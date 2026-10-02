import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from './adapters/memory/index.js';
import type { StorageAdapter } from './adapter.js';
import { createGraphClient, query, write } from './endpoints.js';

/** An adapter that records every property read, so a test can prove it was never used. */
function watched(adapter: StorageAdapter) {
  const touched: string[] = [];
  const proxy = new Proxy(adapter, { get: (t, p, r) => (touched.push(String(p)), Reflect.get(t, p, r)) });
  return { adapter: proxy, touched };
}

const mutation = (ops: unknown[], extra: object = {}) => ({ version: 1, kind: 'mutation', graphId: 'user_42', ops, ...extra });
const q = (extra: object = {}) => ({ version: 1, graphId: 'user_42', from: { all: true }, return: { shape: 'nodes' }, ...extra });

/** The spec's example: doctor X, four visits, an unrelated note. Written through the real write endpoint. */
async function withClinic() {
  const adapter = createMemoryAdapter();
  const r = await write(
    adapter,
    mutation(
      [
        { op: 'upsertNode', partition: 'category', id: 'doctor-x', data: { name: 'Dr X' } },
        ...['visit-14', 'visit-17', 'visit-21', 'visit-30'].map((id) => ({ op: 'upsertNode', partition: 'item', id, data: { type: 'appointment' } })),
        ...['visit-14', 'visit-17', 'visit-21', 'visit-30'].map((item) => ({ op: 'link', item, category: 'doctor-x', weight: 0.9 })),
        { op: 'upsertNode', partition: 'item', id: 'shopping-list' },
      ],
      { createIfMissing: true },
    ),
  );
  expect(r.ok).toBe(true);
  return adapter;
}

describe('query(): what was written can be read back', () => {
  it('everything about doctor X, as a subgraph with data', async () => {
    const r = await query(await withClinic(), q({ from: { partition: 'category', ids: ['doctor-x'] }, traverse: { depth: 1 }, return: { shape: 'subgraph', includeData: true } }));
    expect(r).toEqual({
      ok: true,
      value: {
        nodes: [
          { partition: 'item', id: 'visit-14', data: { type: 'appointment' } },
          { partition: 'item', id: 'visit-17', data: { type: 'appointment' } },
          { partition: 'item', id: 'visit-21', data: { type: 'appointment' } },
          { partition: 'item', id: 'visit-30', data: { type: 'appointment' } },
          { partition: 'category', id: 'doctor-x', data: { name: 'Dr X' } },
        ],
        edges: ['visit-14', 'visit-17', 'visit-21', 'visit-30'].map((item) => ({ item, category: 'doctor-x', weight: 0.9 })),
        nextCursor: null,
        truncated: false,
      },
    });
  });

  it('the whole graph, in each shape', async () => {
    const adapter = await withClinic();
    expect(await query(adapter, q({ return: { shape: 'count' } }))).toEqual({ ok: true, value: { count: 6, truncated: false } });
    expect(await query(adapter, q({ return: { shape: 'ids' }, page: { limit: 2 } }))).toMatchObject({
      ok: true,
      value: { ids: [{ partition: 'item', id: 'shopping-list' }, { partition: 'item', id: 'visit-14' }], truncated: false },
    });
    const nodes = await query(adapter, q({ page: { limit: 100 } }));
    expect(nodes.ok && 'nodes' in nodes.value && nodes.value.nodes.map((n) => n.id)).toEqual(['shopping-list', 'visit-14', 'visit-17', 'visit-21', 'visit-30', 'doctor-x']);
  });

  it('pages with the cursor it hands back, end to end', async () => {
    const adapter = await withClinic();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await query(adapter, q({ page: { limit: 4, cursor } }));
      if (!r.ok || !('nodes' in r.value)) throw new Error('query failed');
      seen.push(...r.value.nodes.map((n) => n.id));
      cursor = r.value.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(2);
    expect(seen).toEqual(['shopping-list', 'visit-14', 'visit-17', 'visit-21', 'visit-30', 'doctor-x']);
  });

  it('a missing graph is GRAPH_NOT_FOUND, and another graph is never read', async () => {
    const adapter = await withClinic();
    expect(await query(adapter, q({ graphId: 'nobody' }))).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND' } });
    await write(adapter, mutation([{ op: 'upsertNode', partition: 'item', id: 'private' }], { graphId: 'someone_else', createIfMissing: true }));
    const mine = await query(adapter, q({ page: { limit: 100 } }));
    expect(JSON.stringify(mine)).not.toContain('private');
  });

  it('the same query on an unchanged store gives the same answer (AC-13)', async () => {
    const adapter = await withClinic();
    const query1 = q({ from: { partition: 'category', ids: ['doctor-x'] }, traverse: { depth: 2 }, return: { shape: 'subgraph', includeData: true } });
    expect(await query(adapter, query1)).toEqual(await query(adapter, query1));
  });
});

describe('invalid input never reaches the adapter (AC-10, AC-14, AC-20, AC-21)', () => {
  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['a string', 'hello'],
    ['a number', 7],
    ['an array', []],
    ['an empty object', {}],
    ['a malformed object', q({ return: 'nodes' })],
    ['an unknown version (AC-14)', q({ version: 2 })],
    ['a mutation sent to query (AC-20)', mutation([])],
    ['depth 4 (AC-21)', q({ from: { partition: 'category', ids: ['c'] }, traverse: { depth: 4 } })],
    ['a negative depth', q({ from: { partition: 'category', ids: ['c'] }, traverse: { depth: -1 } })],
    ['a page limit above 1000', q({ page: { limit: 1001 } })],
    ['a graph id with a slash', q({ graphId: 'a/b' })],
    ['a garbage cursor', q({ page: { cursor: 'not-a-cursor' } })],
    ['a cursor on a count', q({ return: { shape: 'count' }, page: { cursor: 'x' } })],
    ['a feature not built yet (filter.all)', q({ filter: { all: ['a'] } })],
    ['a feature not built yet (from.where)', q({ from: { partition: 'category', where: { 'data.name': { eq: 'Dr X' } } } })],
    ['a misspelt field', q({ traverse: { depht: 1 } })],
  ];

  it.each(cases)('%s: an error result, the adapter untouched, nothing thrown', async (_name, input) => {
    const { adapter, touched } = watched(createMemoryAdapter());
    const r = await query(adapter, input);
    expect(r.ok).toBe(false);
    expect(touched).toEqual([]);
  });

  it('depth 4 reports where the problem is', async () => {
    const r = await query(createMemoryAdapter(), q({ from: { partition: 'category', ids: ['c'] }, traverse: { depth: 4 } }));
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', path: ['traverse', 'depth'] } });
  });

  it('a mutation sent to query changes nothing', async () => {
    const adapter = await withClinic();
    const before = await query(adapter, q({ return: { shape: 'count' } }));
    await query(adapter, mutation([{ op: 'deleteNode', partition: 'category', id: 'doctor-x' }]));
    expect(await query(adapter, q({ return: { shape: 'count' } }))).toEqual(before);
  });

  it('a feature not built yet says so by name', async () => {
    const r = await query(createMemoryAdapter(), q({ filter: { all: ['a'] } }));
    expect(r).toMatchObject({ ok: false, error: { path: ['filter', 'all'], message: expect.stringContaining('not supported yet') } });
  });
});

describe('options: tighter limits for a call', () => {
  it('maxReachedNodes truncates a query', async () => {
    const adapter = await withClinic();
    expect(await query(adapter, q({ return: { shape: 'count' } }), { limits: { maxReachedNodes: 3 } })).toEqual({ ok: true, value: { count: 3, truncated: true } });
  });

  it('maxOps rejects a long mutation before the adapter is touched', async () => {
    const { adapter, touched } = watched(createMemoryAdapter());
    const ops = [1, 2, 3].map((n) => ({ op: 'upsertNode', partition: 'item', id: `n${n}` }));
    expect(await write(adapter, mutation(ops, { createIfMissing: true }), { limits: { maxOps: 2 } })).toMatchObject({ ok: false, error: { path: ['ops'] } });
    expect(touched).toEqual([]);
  });

  it('maxIdLength tightens ids in queries and in graph ids', async () => {
    const adapter = createMemoryAdapter();
    expect(await query(adapter, q({ graphId: 'abcd' }), { limits: { maxIdLength: 3 } })).toMatchObject({ ok: false, error: { path: ['graphId'] } });
    const client = createGraphClient(adapter, { limits: { maxIdLength: 3 } });
    expect(await client.createGraph('abcd')).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(await client.createGraph('abc')).toMatchObject({ ok: true });
    for (const call of [client.createGraph, client.dropGraph, client.describeGraph]) {
      expect(await call('abcd')).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', path: ['graphId'] } });
    }
  });

  it('maxDataBytes rejects a big payload in a write', async () => {
    const adapter = createMemoryAdapter();
    const big = mutation([{ op: 'upsertNode', partition: 'item', id: 'a', data: { s: 'x'.repeat(200) } }], { createIfMissing: true });
    expect(await write(adapter, big, { limits: { maxDataBytes: 100 } })).toMatchObject({ ok: false, error: { path: ['ops', 0, 'data'] } });
    expect((await write(adapter, big)).ok).toBe(true);
  });

  it.each([
    ['an unknown option', { limit: { maxOps: 5 } }, ['options', 'limit']],
    ['an unknown limit (a typo)', { limits: { maxOp: 5 } }, ['options', 'limits', 'maxOp']],
    ['a zero limit', { limits: { maxOps: 0 } }, ['options', 'limits', 'maxOps']],
    ['a negative limit', { limits: { maxDataBytes: -1 } }, ['options', 'limits', 'maxDataBytes']],
    ['a fractional limit', { limits: { maxIdLength: 2.5 } }, ['options', 'limits', 'maxIdLength']],
    ['a limit given as text', { limits: { maxReachedNodes: '10' } }, ['options', 'limits', 'maxReachedNodes']],
    ['options that are not an object', 'tight', ['options']],
    ['limits that are not an object', { limits: 5 }, ['options', 'limits']],
  ])('refuses %s with a path, before touching the adapter', async (_name, options, path) => {
    for (const call of [
      (a: StorageAdapter) => query(a, q(), options as never),
      (a: StorageAdapter) => write(a, mutation([]), options as never),
    ]) {
      const { adapter, touched } = watched(createMemoryAdapter());
      expect(await call(adapter)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', path } });
      expect(touched).toEqual([]);
    }
  });

  it('survives hostile options', async () => {
    const hostile = { get limits(): never { throw new Error('boom'); } };
    expect(await query(createMemoryAdapter(), q(), hostile as never)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('the client carries its options', () => {
  it('applies them to every call', async () => {
    const adapter = createMemoryAdapter();
    const client = createGraphClient(adapter, { limits: { maxOps: 1, maxReachedNodes: 2 } });
    await client.createGraph('user_42');
    const two = mutation([1, 2].map((n) => ({ op: 'upsertNode', partition: 'item', id: `n${n}` })));
    expect(await client.write(two)).toMatchObject({ ok: false, error: { path: ['ops'] } });
    expect((await client.write(mutation([{ op: 'upsertNode', partition: 'item', id: 'n1' }]))).ok).toBe(true);
    expect((await client.write(mutation([{ op: 'upsertNode', partition: 'item', id: 'n2' }]))).ok).toBe(true);
    expect((await client.write(mutation([{ op: 'upsertNode', partition: 'item', id: 'n3' }]))).ok).toBe(true);
    expect(await client.query(q({ return: { shape: 'count' } }))).toEqual({ ok: true, value: { count: 2, truncated: true } });
  });

  it('is not changed by editing the options object afterwards', async () => {
    const adapter = createMemoryAdapter();
    const options = { limits: { maxOps: 1 } };
    const client = createGraphClient(adapter, options);
    options.limits.maxOps = 1000;
    await client.createGraph('user_42');
    const two = mutation([1, 2].map((n) => ({ op: 'upsertNode', partition: 'item', id: `n${n}` })));
    expect((await client.write(two)).ok).toBe(false);
  });

  it('without options behaves with the defaults', async () => {
    const client = createGraphClient(createMemoryAdapter());
    await client.createGraph('user_42');
    expect((await client.write(mutation([{ op: 'upsertNode', partition: 'item', id: 'a' }]))).ok).toBe(true);
    expect(await client.query(q({ return: { shape: 'count' } }))).toEqual({ ok: true, value: { count: 1, truncated: false } });
  });

  it('throws a RangeError for invalid options when the client is made (a coding mistake, not a request)', () => {
    expect(() => createGraphClient(createMemoryAdapter(), { limits: { maxOp: 5 } } as never)).toThrow(RangeError);
    expect(() => createGraphClient(createMemoryAdapter(), { limits: { maxOps: 0 } })).toThrow(/maxOps/);
    expect(() => createGraphClient(createMemoryAdapter(), 'x' as never)).toThrow(RangeError);
  });

  it('reads through the client: write, then query, then page', async () => {
    const client = createGraphClient(createMemoryAdapter());
    await client.write(mutation([{ op: 'upsertNode', partition: 'item', id: 'a' }, { op: 'upsertNode', partition: 'category', id: 'c' }, { op: 'link', item: 'a', category: 'c' }], { createIfMissing: true }));
    expect(await client.query(q({ return: { shape: 'subgraph' } }))).toEqual({
      ok: true,
      value: {
        nodes: [{ partition: 'item', id: 'a' }, { partition: 'category', id: 'c' }],
        edges: [{ item: 'a', category: 'c', weight: 1 }],
        nextCursor: null,
        truncated: false,
      },
    });
  });
});

describe('failures', () => {
  it('turns adapter errors into STORAGE_ERROR for a valid query', async () => {
    const real = createMemoryAdapter();
    const failing: StorageAdapter = { ...real, graphs: { ...real.graphs, exists: async () => { throw new Error('disk gone'); } } };
    expect(await query(failing, q())).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR', message: expect.stringContaining('disk gone') } });
  });
});
