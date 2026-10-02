// Local development tool: a tiny HTTP server around the graph store so the explorer UI can drive it.
// It is not part of the library or the published package, and it only ever listens on loopback.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY_BYTES = 1_000_000;
const LOOPBACK = '127.0.0.1';
const PAGE = 1000;

/** Only these files are ever served, so no request path can reach anything else on disk. */
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/layout.js': ['layout.js', 'text/javascript; charset=utf-8'],
  '/scenarios.js': ['scenarios.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Refuses to run anywhere that looks like a deployment. */
export function assertLocalDevelopment(env = process.env) {
  if (env.NODE_ENV === 'production') {
    throw new Error('The graph explorer is a local development tool and must not run with NODE_ENV=production.');
  }
}

/**
 * @param lib the graph store: { write, createGraph, dropGraph, listGraphs, describeGraph, createMemoryAdapter }.
 *            It is passed in so the tool can run against the build (`dist`) or the sources (tests).
 */
export function createApp(lib) {
  let adapter = lib.createMemoryAdapter();

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

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

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return text === '' ? {} : JSON.parse(text);
    } catch {
      throw new HttpError(400, 'request body is not valid JSON');
    }
  }

  async function allPages(fetchPage) {
    const rows = [];
    let cursor = null;
    do {
      const page = await fetchPage({ limit: PAGE, cursor });
      rows.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return rows;
  }

  /** Everything in one graph, read through the adapter's own primitives so the picture is the stored truth. */
  async function readGraph(graphId) {
    const info = await lib.describeGraph(adapter, graphId);
    if (!info.ok) return info;
    const data = await adapter.transaction(graphId, async (tx) => {
      const items = await allPages((page) => tx.listNodes('item', page));
      const categories = await allPages((page) => tx.listNodes('category', page));
      const edges = [];
      for (const item of items) edges.push(...(await allPages((page) => tx.edgesOf('item', item.id, page))));
      return { items, categories, edges };
    });
    return { ok: true, value: { info: info.value, ...data } };
  }

  async function api(req, res, url) {
    const writes = req.method !== 'GET';
    if (writes) {
      if (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) {
        throw new HttpError(403, 'cross-origin request refused');
      }
      if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new HttpError(415, 'send application/json');
      }
    }
    const parts = url.pathname.split('/').slice(2); // after /api
    const graphId = parts[1] === undefined ? undefined : decodeURIComponent(parts[1]);

    if (parts[0] === 'graphs' && parts.length === 1 && req.method === 'GET') {
      const ids = await allPages((page) => lib.listGraphs(adapter, page).then((r) => (r.ok ? r.value : { items: [], nextCursor: null })));
      return send(res, 200, { ok: true, value: { items: ids } });
    }
    if (parts[0] === 'graphs' && parts.length === 1 && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, await lib.createGraph(adapter, body.graphId));
    }
    if (parts[0] === 'graphs' && parts.length === 2 && req.method === 'GET') {
      return send(res, 200, await readGraph(graphId));
    }
    if (parts[0] === 'graphs' && parts.length === 2 && req.method === 'DELETE') {
      return send(res, 200, await lib.dropGraph(adapter, graphId));
    }
    if (parts[0] === 'write' && parts.length === 1 && req.method === 'POST') {
      return send(res, 200, await lib.write(adapter, await readJson(req)));
    }
    if (parts[0] === 'reset' && parts.length === 1 && req.method === 'POST') {
      adapter = lib.createMemoryAdapter();
      return send(res, 200, { ok: true, value: {} });
    }
    throw new HttpError(404, 'no such API route');
  }

  async function handle(req, res) {
    if (!hostAllowed(req)) throw new HttpError(403, 'this tool only answers on 127.0.0.1 or localhost');
    const url = new URL(req.url ?? '/', 'http://explorer.invalid');
    const file = req.method === 'GET' ? FILES[url.pathname] : undefined;
    if (file !== undefined) {
      return send(res, 200, await readFile(join(PUBLIC_DIR, file[0]), 'utf8'), file[1]);
    }
    if (url.pathname.startsWith('/api/')) return api(req, res, url);
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
