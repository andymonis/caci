// Local development tool: a tiny HTTP server around the graph store so the explorer UI can drive it.
// It is not part of the library or the published package, and it only ever listens on loopback
// (the server, its host/origin checks and its static-file allow-list come from ../shared/server-kit.mjs).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalDevelopment as assertLocal, createLoopbackServer, HttpError } from '../shared/server-kit.mjs';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
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

/** Refuses to run anywhere that looks like a deployment. */
export function assertLocalDevelopment(env = process.env) {
  assertLocal('The graph explorer', env);
}

/**
 * @param lib the graph store: { write, createGraph, dropGraph, listGraphs, describeGraph, createMemoryAdapter }.
 *            It is passed in so the tool can run against the build (`dist`) or the sources (tests).
 */
export function createApp(lib) {
  let adapter = lib.createMemoryAdapter();

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

  /**
   * Everything in one graph, read through the public `query()` (one whole-graph subgraph query, a
   * page at a time), so the picture shows what a real caller of the library would get.
   */
  async function readGraph(graphId) {
    const info = await lib.describeGraph(adapter, graphId);
    if (!info.ok) return info;
    const items = [];
    const categories = [];
    const edges = [];
    let truncated = false;
    let cursor = null;
    for (let pages = 0; pages < 1000; pages++) {
      const result = await lib.query(adapter, {
        version: 1,
        graphId,
        from: { all: true },
        return: { shape: 'subgraph', includeData: true },
        page: { limit: PAGE, cursor },
      });
      if (!result.ok) return result;
      for (const node of result.value.nodes) (node.partition === 'item' ? items : categories).push(node);
      edges.push(...result.value.edges);
      truncated ||= result.value.truncated;
      cursor = result.value.nextCursor;
      if (cursor === null) break;
    }
    return { ok: true, value: { info: info.value, items, categories, edges, truncated } };
  }

  async function api(req, res, url, { send, readJson }) {
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
    if (parts[0] === 'query' && parts.length === 1 && req.method === 'POST') {
      return send(res, 200, await lib.query(adapter, await readJson(req)));
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

  return createLoopbackServer({ files: FILES, publicDir: PUBLIC_DIR, api });
}
