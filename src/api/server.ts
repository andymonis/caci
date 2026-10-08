import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseBody } from './body.js';
import { parseCookies } from './cookies.js';
import { checkRoutes, DOCUMENT_TYPES, matchRoute, policyProblem, type ApiResponse, type Method, type Route } from './router.js';

export interface ApiServerOptions {
  readonly routes: readonly Route[];
  /** The address to listen on. Default `127.0.0.1`: reachable only from this machine. */
  readonly host?: string;
  /** Largest request body, in bytes. Default 16,384. */
  readonly maxBodyBytes?: number;
  /** Largest request header block, in bytes. Default 16,384. */
  readonly maxHeaderBytes?: number;
  /** Time to receive the headers / the whole request, in milliseconds. Defaults 10,000 and 30,000. */
  readonly headersTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /**
   * `Host` values the server answers to, for example `["127.0.0.1:8080", "localhost:8080"]` (against DNS rebinding). Default: for a
   * loopback address with no proxy, the loopback names on the port in use; otherwise no check (a public name cannot be known here).
   */
  readonly allowedHosts?: readonly string[];
  /**
   * How many reverse proxies sit in front, each adding the address it saw to `X-Forwarded-For`. Default 0: the socket's address is
   * used and the header is ignored (anyone could send it). With 1, the last entry is used, which the proxy wrote.
   */
  readonly trustedProxies?: number;
  /** Called once per request, after the reply: method, path (never the query), status and milliseconds. Never gets a body, a cookie or a query. */
  readonly log?: (event: { readonly method: string; readonly path: string; readonly status: number; readonly ms: number }) => void;
}

export interface ApiServer {
  readonly server: Server;
  /** Pass 0 for a free port. Resolves with the port. */
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

const METHODS: readonly string[] = Object.freeze(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const BODY_METHODS: readonly string[] = Object.freeze(['POST', 'PATCH', 'PUT', 'DELETE']);
const MAX_QUERY_PARAMS = 20;
const MAX_QUERY_VALUE = 512;

/** Headers on every reply, errors included. The API only ever sends JSON, so the page policy is "load nothing". */
const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'",
});

const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '::1';

/** `{ error: { code, message } }`, the one shape of every failure. */
function errorBody(status: number, message: string): { error: { code: string; message: string } } {
  const codes: Record<number, string> = { 400: 'BAD_REQUEST', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 500: 'INTERNAL_ERROR' };
  return { error: { code: codes[status] ?? 'ERROR', message } };
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError(`${name} must be a positive whole number`);
  return n;
}

/** Builds the HTTP server for the API. It listens only when `listen` is called, and only on `host`. */
export function createApiServer(options: ApiServerOptions): ApiServer {
  checkRoutes(options.routes);
  const host = options.host ?? '127.0.0.1';
  const maxBodyBytes = positive(options.maxBodyBytes, 16_384, 'maxBodyBytes');
  const maxHeaderBytes = positive(options.maxHeaderBytes, 16_384, 'maxHeaderBytes');
  const headersTimeoutMs = positive(options.headersTimeoutMs, 10_000, 'headersTimeoutMs');
  const requestTimeoutMs = positive(options.requestTimeoutMs, 30_000, 'requestTimeoutMs');
  const trustedProxies = options.trustedProxies ?? 0;
  if (!Number.isSafeInteger(trustedProxies) || trustedProxies < 0 || trustedProxies > 5) throw new TypeError('trustedProxies must be a whole number from 0 to 5');
  if (typeof host !== 'string' || host === '') throw new TypeError('host must be an address');

  const server = createServer({ maxHeaderSize: maxHeaderBytes, requestTimeout: requestTimeoutMs, headersTimeout: Math.min(headersTimeoutMs, requestTimeoutMs), keepAliveTimeout: 5000, connectionsCheckingInterval: Math.min(5000, requestTimeoutMs) }, (req, res) => {
    const started = Date.now();
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    handle(req, res)
      .catch(() => send(res, { status: 500, body: errorBody(500, 'internal error') }))
      .finally(() => options.log?.({ method: String(req.method), path: path.slice(0, 200), status: res.statusCode, ms: Date.now() - started }));
  });

  function hostAllowed(req: IncomingMessage): boolean {
    const given = req.headers.host;
    if (options.allowedHosts !== undefined) return typeof given === 'string' && options.allowedHosts.includes(given);
    if (!isLoopback(host) || trustedProxies > 0) return true;
    const port = (server.address() as { port: number } | null)?.port;
    return typeof given === 'string' && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(given);
  }

  /** A write must come from this site: a different `Origin` (or `null`) is refused. A request with no `Origin` is not a browser's cross-site one. */
  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
      const url = new URL(origin);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.host === req.headers.host;
    } catch {
      return false;
    }
  }

  function clientKey(req: IncomingMessage): string {
    const socket = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    if (trustedProxies === 0) return socket;
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
    const hop = forwarded[forwarded.length - trustedProxies];
    return hop !== undefined && /^[0-9A-Fa-f:.]{2,45}$/.test(hop) ? hop.replace(/^::ffff:/, '') : socket;
  }

  async function readBody(req: IncomingMessage): Promise<Buffer | 'too-large'> {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > maxBodyBytes) return 'too-large';
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBodyBytes) return 'too-large';
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  function send(res: ServerResponse, response: ApiResponse & { readonly allow?: readonly Method[] }): void {
    if (res.headersSent) return;
    const headers: Record<string, string | string[]> = { ...SECURITY_HEADERS };
    const document = response.document;
    if (document !== undefined) {
      // a page, script or style sheet: its kind picks a fixed content type; a bad one is our mistake, never sent
      const bad = response.body !== undefined || !Object.hasOwn(DOCUMENT_TYPES, document.kind) || typeof document.text !== 'string' || response.status === 204 || (document.policy !== undefined && policyProblem(document.policy) !== undefined);
      if (bad) return send(res, { status: 500, body: errorBody(500, 'internal error') });
      headers['content-type'] = DOCUMENT_TYPES[document.kind];
      headers['content-length'] = String(Buffer.byteLength(document.text));
      if (document.policy !== undefined) headers['content-security-policy'] = document.policy;
      if (response.cookies !== undefined && response.cookies.length > 0) headers['set-cookie'] = [...response.cookies];
      res.writeHead(response.status, headers);
      res.end(document.text);
      return;
    }
    const hasBody = response.body !== undefined && response.status !== 204;
    if (hasBody) headers['content-type'] = 'application/json; charset=utf-8';
    if (response.cookies !== undefined && response.cookies.length > 0) headers['set-cookie'] = [...response.cookies];
    if (response.allow !== undefined) headers.allow = response.allow.join(', ');
    if (response.retryAfterSeconds !== undefined) headers['retry-after'] = String(Math.max(1, Math.ceil(response.retryAfterSeconds)));
    res.writeHead(response.status, headers);
    res.end(hasBody ? JSON.stringify(response.body) : undefined);
  }

  const fail = (res: ServerResponse, status: number, message: string, extra: { allow?: readonly Method[] } = {}): void => send(res, { status, body: errorBody(status, message), ...extra });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req)) return fail(res, 403, 'this server does not answer to that address');
    const method = String(req.method);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://api.invalid');
    } catch {
      return fail(res, 400, 'bad request target');
    }
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';

    const found = matchRoute(options.routes, method, rawPath);
    if (found.kind === 'none') return fail(res, 404, 'not found');
    if (found.kind === 'method' || !METHODS.includes(method)) {
      return fail(res, 405, 'method not allowed', { allow: found.kind === 'method' ? found.allow : [] });
    }

    let body: Readonly<Record<string, never>> | undefined;
    if (method !== 'GET') {
      if (!originAllowed(req)) return fail(res, 403, 'cross-origin request refused');
      if (BODY_METHODS.includes(method)) {
        const raw = await readBody(req);
        if (raw === 'too-large') return fail(res, 413, 'request body too large');
        const parsed = parseBody(raw, req.headers['content-type']);
        if (!parsed.ok) return fail(res, parsed.status, parsed.message);
        body = parsed.body as typeof body;
      }
    }

    const query: Record<string, string> = Object.create(null) as Record<string, string>;
    let count = 0;
    for (const [name, value] of url.searchParams) {
      if (name in query) continue;
      if (++count > MAX_QUERY_PARAMS || name.length > 64 || value.length > MAX_QUERY_VALUE) return fail(res, 400, 'the query string is not acceptable');
      query[name] = value;
    }

    const response = await found.route.handler({
      method: method as Method,
      path: rawPath,
      params: found.params,
      query: Object.freeze(query),
      body: body as never,
      cookies: parseCookies(req.headers.cookie),
      clientKey: clientKey(req),
    });
    send(res, response);
  }

  return {
    server,
    listen: (port = 0) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve((server.address() as { port: number }).port));
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
