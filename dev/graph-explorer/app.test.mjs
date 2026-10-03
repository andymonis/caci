import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as library from '../../src/graph_store/index.ts';
import { createMemoryAdapter } from '../../src/graph_store/adapters/memory/index.ts';
import { assertLocalDevelopment, createApp } from './app.mjs';

let app;
let base;

beforeEach(async () => {
  app = createApp({ ...library, createMemoryAdapter });
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
});
afterEach(() => app.close());

const call = async (path, method = 'GET', body) => {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
};
const mutate = (ops, extra = {}) => call('/api/write', 'POST', { version: 1, kind: 'mutation', graphId: 'g', ops, ...extra });

/** A raw request, so headers like Host and Origin can be set freely. */
const raw = (path, { method = 'GET', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const req = request({ host: url.hostname, port: url.port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });

describe('the explorer is local only', () => {
  it('listens on the loopback address and nowhere else', () => {
    expect(app.server.address().address).toBe('127.0.0.1');
  });

  it('answers localhost, but refuses any other Host header (DNS rebinding)', async () => {
    const port = app.server.address().port;
    expect((await raw('/', { headers: { host: `localhost:${port}` } })).status).toBe(200);
    expect((await raw('/', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await raw('/api/graphs', { headers: { host: `192.168.1.5:${port}` } })).status).toBe(403);
  });

  it('refuses cross-origin writes and non-JSON posts (CSRF from another web page)', async () => {
    const port = app.server.address().port;
    const post = (headers) => raw('/api/reset', { method: 'POST', headers: { host: `127.0.0.1:${port}`, ...headers }, body: '{}' });
    expect((await post({ origin: 'https://evil.example', 'content-type': 'application/json' })).status).toBe(403);
    expect((await post({ 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post({ origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' })).status).toBe(200);
    expect((await raw('/api/graphs/x', { method: 'DELETE', headers: { host: `127.0.0.1:${port}`, origin: 'https://evil.example' } })).status).toBe(403);
    const query = (headers) => raw('/api/query', { method: 'POST', headers: { host: `127.0.0.1:${port}`, ...headers }, body: '{}' });
    expect((await query({ origin: 'https://evil.example', 'content-type': 'application/json' })).status).toBe(403);
    expect((await query({ 'content-type': 'text/plain' })).status).toBe(415);
    expect((await query({ 'content-type': 'application/json' })).status).toBe(200);
  });

  it('rejects oversized and malformed bodies', async () => {
    const port = app.server.address().port;
    const headers = { host: `127.0.0.1:${port}`, 'content-type': 'application/json' };
    expect((await raw('/api/write', { method: 'POST', headers, body: '{not json' })).status).toBe(400);
    expect((await raw('/api/write', { method: 'POST', headers, body: JSON.stringify({ pad: 'x'.repeat(1_100_000) }) })).status).toBe(413);
  });

  it('refuses to start under NODE_ENV=production', () => {
    expect(() => assertLocalDevelopment({ NODE_ENV: 'production' })).toThrow(/local development/);
    expect(() => assertLocalDevelopment({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertLocalDevelopment({})).not.toThrow();
  });
});

describe('static files', () => {
  it('serves the page and its scripts with the right content types', async () => {
    const page = await raw('/');
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.text).toContain('Graph Explorer');
    expect((await raw('/app.js')).headers['content-type']).toContain('javascript');
    expect((await raw('/layout.js')).status).toBe(200);
    expect((await raw('/style.css')).headers['content-type']).toContain('text/css');
  });

  it('serves nothing else: unknown paths and traversal attempts are 404', async () => {
    for (const path of ['/nope', '/app.mjs', '/server.mjs', '/package.json', '/../package.json', '/%2e%2e/package.json', '/public/app.js']) {
      expect((await raw(path)).status).toBe(404);
    }
  });
});

describe('queries through the public query() function', () => {
  async function filled() {
    await mutate(
      [
        { op: 'upsertNode', partition: 'category', id: 'doctor-x', data: { name: 'Dr X' } },
        ...['v1', 'v2', 'v3'].map((id) => ({ op: 'upsertNode', partition: 'item', id })),
        ...['v1', 'v2', 'v3'].map((item) => ({ op: 'link', item, category: 'doctor-x' })),
      ],
      { createIfMissing: true },
    );
  }
  const ask = (query) => call('/api/query', 'POST', { version: 1, graphId: 'g', ...query });

  it('answers a query exactly as the library does', async () => {
    await filled();
    const { status, json } = await ask({ from: { partition: 'category', ids: ['doctor-x'] }, traverse: { depth: 1 }, return: { shape: 'subgraph' } });
    expect(status).toBe(200);
    expect(json.value.nodes.map((n) => n.id)).toEqual(['v1', 'v2', 'v3', 'doctor-x']);
    expect(json.value.edges).toEqual(['v1', 'v2', 'v3'].map((item) => ({ item, category: 'doctor-x', weight: 1 })));
  });

  it('pages with the cursor it hands back', async () => {
    await filled();
    const first = await ask({ from: { all: true }, return: { shape: 'ids' }, page: { limit: 3 } });
    expect(first.json.value.ids).toHaveLength(3);
    const second = await ask({ from: { all: true }, return: { shape: 'ids' }, page: { limit: 3, cursor: first.json.value.nextCursor } });
    expect(second.json.value.ids.map((n) => n.id)).toEqual(['doctor-x']);
    expect(second.json.value.nextCursor).toBeNull();
  });

  it('reports refusals as results, not transport failures', async () => {
    await filled();
    expect((await ask({ from: { partition: 'category', ids: ['x'] }, traverse: { depth: 4 }, return: { shape: 'nodes' } })).json).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', path: ['traverse', 'depth'] },
    });
    expect((await ask({ filter: { all: ['a'] }, from: { all: true }, return: { shape: 'nodes' } })).json.error.message).toContain('not supported yet');
    expect((await call('/api/query', 'POST', { version: 1, graphId: 'missing', from: { all: true }, return: { shape: 'count' } })).json).toMatchObject({
      ok: false,
      error: { code: 'GRAPH_NOT_FOUND' },
    });
    expect((await call('/api/query', 'POST', null)).json).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('never changes the store', async () => {
    await filled();
    const before = (await call('/api/graphs/g')).json;
    await ask({ from: { all: true }, return: { shape: 'subgraph', includeData: true } });
    expect((await call('/api/graphs/g')).json).toEqual(before);
  });

  it('draws a graph larger than one page of results completely (2,500 items, 2,500 links)', async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `n${String(i).padStart(4, '0')}`);
    const chunks = (list) => Array.from({ length: Math.ceil(list.length / 800) }, (_, i) => list.slice(i * 800, (i + 1) * 800));
    let first = true;
    for (const chunk of chunks(ids)) {
      expect((await mutate(chunk.map((id) => ({ op: 'upsertNode', partition: 'item', id })), { createIfMissing: first })).json.ok).toBe(true);
      first = false;
    }
    await mutate([{ op: 'upsertNode', partition: 'category', id: 'hub' }]);
    for (const chunk of chunks(ids)) {
      expect((await mutate(chunk.map((item) => ({ op: 'link', item, category: 'hub' })))).json.ok).toBe(true);
    }
    const { json } = await call('/api/graphs/g');
    expect(json.value.items).toHaveLength(2500);
    expect(json.value.categories).toHaveLength(1);
    expect(json.value.edges).toHaveLength(2500);
    expect(json.value.info).toMatchObject({ itemCount: 2500, categoryCount: 1, edgeCount: 2500 });
    expect(new Set(json.value.edges.map((e) => e.item)).size).toBe(2500); // each edge once
    expect(json.value.truncated).toBe(false);
  });
});

describe('driving the graph store', () => {
  it('starts empty and lists graphs as they are created and dropped', async () => {
    expect((await call('/api/graphs')).json).toEqual({ ok: true, value: { items: [] } });
    expect((await call('/api/graphs', 'POST', { graphId: 'g' })).json).toEqual({ ok: true, value: { graphId: 'g' } });
    expect((await call('/api/graphs')).json.value.items).toEqual(['g']);
    expect((await call('/api/graphs/g', 'DELETE')).json).toEqual({ ok: true, value: { graphId: 'g' } });
    expect((await call('/api/graphs')).json.value.items).toEqual([]);
  });

  it('shows the stored graph after writes: nodes, edges and counts', async () => {
    await call('/api/graphs', 'POST', { graphId: 'g' });
    const r = await mutate([
      { op: 'upsertNode', partition: 'item', id: 'n1', data: { title: 'one' } },
      { op: 'upsertNode', partition: 'item', id: 'n2' },
      { op: 'upsertNode', partition: 'category', id: 'work' },
      { op: 'link', item: 'n1', category: 'work', weight: 2 },
      { op: 'link', item: 'n2', category: 'work' },
    ]);
    expect(r.json).toEqual({ ok: true, value: { graphId: 'g', applied: 5, graphCreated: false } });
    const { json } = await call('/api/graphs/g');
    expect(json.value.info).toEqual({ graphId: 'g', itemCount: 2, categoryCount: 1, edgeCount: 2 });
    expect(json.value.items.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(json.value.items[0].data).toEqual({ title: 'one' });
    expect(json.value.edges).toEqual([{ item: 'n1', category: 'work', weight: 2 }, { item: 'n2', category: 'work', weight: 1 }]); // a missing weight reads as 1
    expect(json.value.truncated).toBe(false);
  });

  it('shows removals: deleting a category takes its links with it', async () => {
    await mutate(
      [
        { op: 'upsertNode', partition: 'item', id: 'a' },
        { op: 'upsertNode', partition: 'category', id: 'c' },
        { op: 'link', item: 'a', category: 'c' },
      ],
      { createIfMissing: true },
    );
    await mutate([{ op: 'deleteNode', partition: 'category', id: 'c' }]);
    const { json } = await call('/api/graphs/g');
    expect(json.value.categories).toEqual([]);
    expect(json.value.edges).toEqual([]);
    expect(json.value.info).toMatchObject({ itemCount: 1, categoryCount: 0, edgeCount: 0 });
  });

  it('reports library errors as results (HTTP 200), not as transport failures', async () => {
    await call('/api/graphs', 'POST', { graphId: 'g' });
    const missing = await mutate([{ op: 'link', item: 'nobody', category: 'nothing' }]);
    expect(missing.status).toBe(200);
    expect(missing.json).toMatchObject({ ok: false, error: { code: 'NODE_NOT_FOUND', path: ['ops', 0, 'item'] } });
    expect((await mutate([{ op: 'link', items: ['a', 'b'] }])).json).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect((await call('/api/graphs', 'POST', { graphId: 'Bad/Id' })).json).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', path: ['graphId'] } });
    expect((await call('/api/graphs', 'POST', { graphId: 'g' })).json).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect((await call('/api/graphs/missing')).json).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND' } });
  });

  it('leaves the graph exactly as it was when a mutation fails halfway', async () => {
    await mutate([{ op: 'upsertNode', partition: 'item', id: 'keep' }], { createIfMissing: true });
    const before = (await call('/api/graphs/g')).json;
    const failed = await mutate([
      { op: 'upsertNode', partition: 'item', id: 'lost' },
      { op: 'deleteNode', partition: 'item', id: 'keep' },
      { op: 'link', item: 'lost', category: 'missing' },
    ]);
    expect(failed.json.ok).toBe(false);
    expect((await call('/api/graphs/g')).json).toEqual(before);
  });

  it('keeps graphs apart', async () => {
    await mutate([{ op: 'upsertNode', partition: 'item', id: 'only-in-g' }], { createIfMissing: true });
    await call('/api/graphs', 'POST', { graphId: 'h' });
    expect((await call('/api/graphs/h')).json.value.items).toEqual([]);
    expect((await call('/api/graphs')).json.value.items).toEqual(['g', 'h']);
  });

  it('reset forgets everything', async () => {
    await mutate([{ op: 'upsertNode', partition: 'item', id: 'a' }], { createIfMissing: true });
    expect((await call('/api/reset', 'POST', {})).json.ok).toBe(true);
    expect((await call('/api/graphs')).json.value.items).toEqual([]);
  });

  it('returns 404 for unknown API routes', async () => {
    expect((await call('/api/nothing')).status).toBe(404);
    expect((await call('/api/graphs/g/extra', 'DELETE')).status).toBe(404);
  });
});
