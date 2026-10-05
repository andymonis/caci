// Local development tool: a tiny HTTP server around the graph store so the explorer UI can drive it.
// It is not part of the library or the published package, and it only ever listens on loopback
// (the server, its host/origin checks and its static-file allow-list come from ../shared/server-kit.mjs).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalDevelopment as assertLocal, createLoopbackServer, HttpError } from '../shared/server-kit.mjs';
import { createDemoClient } from './capture-model.mjs';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const PAGE = 1000;

/** Only these files are ever served, so no request path can reach anything else on disk. */
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/layout.js': ['layout.js', 'text/javascript; charset=utf-8'],
  '/scenarios.js': ['scenarios.js', 'text/javascript; charset=utf-8'],
  '/capture.js': ['capture.js', 'text/javascript; charset=utf-8'],
  '/storage.js': ['storage.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

/** Refuses to run anywhere that looks like a deployment. */
export function assertLocalDevelopment(env = process.env) {
  assertLocal('The graph explorer', env);
}

/**
 * @param lib the graph store: { write, createGraph, dropGraph, listGraphs, describeGraph, createMemoryAdapter }.
 *            It is passed in so the tool can run against the build (`dist`) or the sources (tests).
 * @param options.adapter the store to use; the default is a new memory adapter. A file-backed adapter makes the data persist.
 * @param options.storage what the page is told about it: { kind: 'memory' } (the default) or { kind: 'sqlite', path }.
 * @param options.capture turns on the capture panel (propose a filing for a note, then approve or reject it):
 *            { createController, createLlm, createScriptedModelClient, createAnthropicClient?, apiKey?, realModel?, controllerOptions? }
 *            (`controllerOptions` are passed to every controller: tests use them to shorten how long a proposal lasts).
 *            It uses a demo model that costs nothing. The real model is used only when the server was started
 *            with `realModel: true` AND `apiKey` is set, and then only for requests that ask for it with `network: true`.
 */
export function createApp(lib, options = {}) {
  const adapter = options.adapter ?? lib.createMemoryAdapter();
  const storage = Object.freeze(options.storage === undefined ? { kind: 'memory' } : { ...options.storage });
  const capture = options.capture;
  const apiKey = typeof capture?.apiKey === 'string' && capture.apiKey !== '' ? capture.apiKey : undefined;
  const realAvailable = capture?.realModel === true && apiKey !== undefined && typeof capture.createAnthropicClient === 'function';

  /** One controller per kind of model, over the current adapter. Rebuilt when everything is reset. */
  let controllers = makeControllers();
  /** Which controller holds which pending proposal, so approve and reject go to the right one. */
  const owners = new Map();

  function makeControllers() {
    if (capture === undefined) return null;
    const make = (client) => capture.createController({ ...capture.controllerOptions, adapter, llm: capture.createLlm({ client }) });
    return { demo: make(createDemoClient(capture)), real: realAvailable ? make(capture.createAnthropicClient({ apiKey })) : null };
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

  /** The controller's errors keep their source ("app", "graph" or "llm") and are flattened for the page. */
  const failure = (error) => ({ ok: false, error: { source: error.source, code: error.error.code, message: error.error.message, ...(error.error.path === undefined ? {} : { path: error.error.path }) } });

  /** What the page needs to show a pending proposal: the plain summary, what to draw, and what it cost. */
  const describe = (p) => ({
    id: p.id,
    graphId: p.graphId,
    itemId: p.itemId,
    note: p.note,
    rationale: p.rationale ?? null,
    text: p.text,
    summary: p.summary,
    ops: p.mutation.ops,
    model: p.model,
    attempts: p.attempts,
    usage: p.usage,
    context: p.context,
    expiresAt: p.expiresAt,
  });

  function checkBody(body, allowed, where) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'send a JSON object');
    for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new HttpError(400, `${where}: unknown field "${key}"`);
  }

  async function captureRoute(req, res, parts, { send, readJson }) {
    if (capture === undefined) throw new HttpError(404, 'capture is not available in this explorer');
    const route = parts.slice(1).join('/');
    if (route === 'status' && req.method === 'GET') {
      return send(res, 200, { ok: true, value: { network: { available: realAvailable }, pending: owners.size } });
    }
    if (route === 'propose' && req.method === 'POST') {
      const body = await readJson(req);
      checkBody(body, ['graphId', 'text', 'network'], 'propose');
      if (typeof body.graphId !== 'string') throw new HttpError(400, 'graphId: must be text');
      if (typeof body.text !== 'string') throw new HttpError(400, 'text: must be text');
      if (body.text.length > 20_000) throw new HttpError(400, 'text: over the limit of 20000 characters');
      if (body.network !== undefined && typeof body.network !== 'boolean') throw new HttpError(400, 'network: must be true or false');
      if (body.network === true && !realAvailable) {
        throw new HttpError(409, 'the real model is off: start the explorer with --real-model and ANTHROPIC_API_KEY set');
      }
      const controller = body.network === true ? controllers.real : controllers.demo;
      const result = await controller.propose(body.graphId, { kind: 'text', text: body.text });
      if (!result.ok) return send(res, 200, failure(result.error));
      owners.set(result.value.id, controller);
      return send(res, 200, { ok: true, value: { ...describe(result.value), mode: body.network === true ? 'real' : 'demo' } });
    }
    if ((route === 'approve' || route === 'reject') && req.method === 'POST') {
      const body = await readJson(req);
      checkBody(body, ['id'], route);
      if (typeof body.id !== 'string') throw new HttpError(400, 'id: must be text');
      const controller = owners.get(body.id);
      if (controller === undefined) return send(res, 200, failure({ source: 'app', error: { code: 'PROPOSAL_NOT_FOUND', message: `no pending proposal ${body.id}: it is unknown, or it was already approved or rejected` } }));
      if (route === 'reject') {
        const result = controller.reject(body.id);
        owners.delete(body.id);
        return send(res, 200, result.ok ? { ok: true, value: { id: body.id } } : failure(result.error));
      }
      const result = await controller.approve(body.id);
      if (result.ok) owners.delete(body.id); // on a failed write the proposal stays pending, so it can be retried or rejected
      else if (result.error.source === 'app' && result.error.error.code !== 'UNEXPECTED') owners.delete(body.id);
      return send(res, 200, result.ok ? { ok: true, value: { id: body.id, written: result.value.written } } : failure(result.error));
    }
    throw new HttpError(404, 'no such API route');
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
    if (parts[0] === 'storage' && parts.length === 1 && req.method === 'GET') {
      return send(res, 200, { ok: true, value: storage });
    }
    if (parts[0] === 'reset' && parts.length === 1 && req.method === 'POST') {
      // the same store stays open (a file cannot be swapped for a new one): drop every graph in it
      const ids = await allPages((page) => lib.listGraphs(adapter, page).then((r) => (r.ok ? r.value : { items: [], nextCursor: null })));
      for (const id of ids) {
        const dropped = await lib.dropGraph(adapter, id);
        if (!dropped.ok) return send(res, 200, dropped);
      }
      controllers = makeControllers();
      owners.clear();
      return send(res, 200, { ok: true, value: {} });
    }
    if (parts[0] === 'capture') return captureRoute(req, res, parts, { send, readJson });
    throw new HttpError(404, 'no such API route');
  }

  return createLoopbackServer({ files: FILES, publicDir: PUBLIC_DIR, api });
}
