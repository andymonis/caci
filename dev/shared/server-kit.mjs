// Shared by the local development tools (graph explorer, LLM lab). Not part of the library or the
// published package. Everything a tool needs to be safe to run on a developer's machine lives here
// once: it only listens on loopback, only answers requests addressed to that origin (against DNS
// rebinding), refuses cross-origin and non-JSON writes (against CSRF from another web page), limits
// request bodies, serves only an explicit list of files, and refuses to run in production.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const LOOPBACK = '127.0.0.1';
export const DEFAULT_MAX_BODY_BYTES = 1_000_000;

/** An error that should reach the browser as this status and message. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Refuses to run anywhere that looks like a deployment. `tool` is the name used in the message. */
export function assertLocalDevelopment(tool, env = process.env) {
  if (env.NODE_ENV === 'production') {
    throw new Error(`${tool} is a local development tool and must not run with NODE_ENV=production.`);
  }
}

/** Sends a JSON value (or a string with the given type), never cached and never sniffed. */
export function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Reads a request body as JSON (an empty body is `{}`), refusing anything over the limit. */
export async function readJson(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text === '' ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

/**
 * Builds a loopback-only server.
 *
 * @param options.files    The only files ever served: `{ '/path': ['file-name-in-publicDir', 'content-type'] }`.
 * @param options.publicDir Where those files are.
 * @param options.api      `async (req, res, url, kit) => void` for every `/api/...` request. Writes (any
 *                         method but GET) have already passed the origin and content-type checks.
 * @param options.maxBodyBytes Largest request body `kit.readJson` accepts.
 */
export function createLoopbackServer({ files, publicDir, api, maxBodyBytes = DEFAULT_MAX_BODY_BYTES }) {
  const kit = Object.freeze({ send, readJson: (req) => readJson(req, maxBodyBytes), HttpError });

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (error instanceof HttpError) send(res, error.status, { error: error.message });
      else send(res, 500, { error: 'internal error', detail: String(error?.message ?? error) });
    });
  });

  /** Requests must be addressed to this exact loopback origin; this blocks DNS-rebinding from other sites. */
  function hostAllowed(req) {
    const port = server.address()?.port;
    return [`${LOOPBACK}:${port}`, `localhost:${port}`].includes(req.headers.host ?? '');
  }

  function checkWrite(req) {
    if (req.method === 'GET') return;
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) {
      throw new HttpError(403, 'cross-origin request refused');
    }
    if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      throw new HttpError(415, 'send application/json');
    }
  }

  async function handle(req, res) {
    if (!hostAllowed(req)) throw new HttpError(403, 'this tool only answers on 127.0.0.1 or localhost');
    const url = new URL(req.url ?? '/', 'http://tool.invalid');
    const file = req.method === 'GET' ? files[url.pathname] : undefined; // paths start with '/', so no inherited property can match
    if (file) return send(res, 200, await readFile(join(publicDir, file[0]), 'utf8'), file[1]);
    if (url.pathname.startsWith('/api/')) {
      checkWrite(req);
      return api(req, res, url, kit);
    }
    throw new HttpError(404, 'not found');
  }

  return {
    server,
    /** Always binds loopback. Pass 0 for a free port. Resolves with the port. */
    listen: (port = 0) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, LOOPBACK, () => resolve(server.address().port));
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
