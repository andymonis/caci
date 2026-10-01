import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from './adapters/memory/index.js';
import type { StorageAdapter } from './adapter.js';
import { write } from './endpoints.js';
import { createGraph, describeGraph, dropGraph, listGraphs, normalizePage } from './graphs.js';

const untouchable = new Proxy({}, { get() { throw new Error('adapter was touched'); } }) as StorageAdapter;
const pad = (n: number, width = 4) => String(n).padStart(width, '0');

describe('normalizePage (pure)', () => {
  it('defaults to limit 50 and no cursor', () => {
    expect(normalizePage(undefined)).toEqual({ ok: true, value: { limit: 50, cursor: null } });
    expect(normalizePage({})).toEqual({ ok: true, value: { limit: 50, cursor: null } });
  });

  it('accepts a limit from 1 to 1000 and a string or null cursor', () => {
    expect(normalizePage({ limit: 1 }).ok).toBe(true);
    expect(normalizePage({ limit: 1000, cursor: 'abc' })).toEqual({ ok: true, value: { limit: 1000, cursor: 'abc' } });
    expect(normalizePage({ cursor: null })).toEqual({ ok: true, value: { limit: 50, cursor: null } });
  });

  it.each([
    ['limit 0', { limit: 0 }, ['page', 'limit']],
    ['limit 1001', { limit: 1001 }, ['page', 'limit']],
    ['negative limit', { limit: -5 }, ['page', 'limit']],
    ['fractional limit', { limit: 1.5 }, ['page', 'limit']],
    ['string limit', { limit: '10' }, ['page', 'limit']],
    ['NaN limit', { limit: NaN }, ['page', 'limit']],
    ['null limit', { limit: null }, ['page', 'limit']],
    ['numeric cursor', { cursor: 5 }, ['page', 'cursor']],
    ['empty cursor', { cursor: '' }, ['page', 'cursor']],
    ['unknown field', { limit: 10, offset: 5 }, ['page', 'offset']],
    ['a string', 'next', ['page']],
    ['null', null, ['page']],
    ['an array', [], ['page']],
  ])('rejects %s with a path', (_name, bad, path) => {
    expect(normalizePage(bad)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', path } });
  });

  it('survives a hostile object', () => {
    const hostile = { get limit(): number { throw new Error('boom'); } };
    expect(normalizePage(hostile)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('listGraphs', () => {
  async function adapterWith(count: number): Promise<StorageAdapter> {
    const adapter = createMemoryAdapter();
    // created in reverse order to prove the listing order does not depend on creation order
    for (let i = count - 1; i >= 0; i--) await createGraph(adapter, `graph-${pad(i)}`);
    return adapter;
  }

  it('returns an empty page when there are no graphs', async () => {
    expect(await listGraphs(createMemoryAdapter())).toEqual({ ok: true, value: { items: [], nextCursor: null } });
  });

  it('pages 120 graphs as 3 pages of unique ids in stable order (limit 50)', async () => {
    const adapter = await adapterWith(120);
    const expected = Array.from({ length: 120 }, (_, i) => `graph-${pad(i)}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await listGraphs(adapter, { limit: 50, cursor });
      if (!r.ok) throw new Error('listGraphs failed');
      seen.push(...r.value.items);
      cursor = r.value.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
  });

  it('defaults to 50 per page', async () => {
    const adapter = await adapterWith(60);
    const r = await listGraphs(adapter);
    expect(r).toMatchObject({ ok: true, value: { nextCursor: expect.any(String) } });
    if (r.ok) expect(r.value.items).toHaveLength(50);
  });

  it('allows up to 1000 per page and rejects more, without touching the adapter', async () => {
    expect((await listGraphs(createMemoryAdapter(), { limit: 1000 })).ok).toBe(true);
    expect(await listGraphs(untouchable, { limit: 1001 })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', path: ['page', 'limit'] },
    });
  });

  it('does not skip or repeat graphs added between pages', async () => {
    const adapter = createMemoryAdapter();
    for (const id of ['b', 'd', 'f']) await createGraph(adapter, id);
    const p1 = await listGraphs(adapter, { limit: 2 });
    for (const id of ['a', 'c', 'e']) await createGraph(adapter, id);
    if (!p1.ok) throw new Error('listGraphs failed');
    const p2 = await listGraphs(adapter, { limit: 10, cursor: p1.value.nextCursor });
    expect(p1.value.items).toEqual(['b', 'd']);
    expect(p2).toMatchObject({ ok: true, value: { items: ['e', 'f'], nextCursor: null } });
  });

  it('reflects dropped graphs', async () => {
    const adapter = await adapterWith(3);
    await dropGraph(adapter, 'graph-0001');
    const r = await listGraphs(adapter);
    expect(r).toMatchObject({ ok: true, value: { items: ['graph-0000', 'graph-0002'] } });
  });

  it('turns adapter failures into STORAGE_ERROR instead of throwing', async () => {
    const real = createMemoryAdapter();
    const failing: StorageAdapter = { ...real, graphs: { ...real.graphs, list: async () => { throw new Error('index corrupt'); } } };
    expect(await listGraphs(failing)).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: expect.stringContaining('index corrupt') },
    });
    expect(await listGraphs(untouchable)).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
  });
});

const mutation = (graphId: string, ops: unknown[], extra: object = {}) => ({ version: 1, kind: 'mutation', graphId, ops, ...extra });
const upsert = (partition: 'item' | 'category', id: string) => ({ op: 'upsertNode', partition, id });
const link = (item: string, category: string) => ({ op: 'link', item, category });

describe('describeGraph', () => {
  it('reports zeros for an empty graph', async () => {
    const adapter = createMemoryAdapter();
    await createGraph(adapter, 'g');
    expect(await describeGraph(adapter, 'g')).toEqual({
      ok: true,
      value: { graphId: 'g', itemCount: 0, categoryCount: 0, edgeCount: 0 },
    });
  });

  it('counts items, categories and edges', async () => {
    const adapter = createMemoryAdapter();
    await write(adapter, mutation('g', [
      upsert('item', 'i1'), upsert('item', 'i2'), upsert('item', 'i3'),
      upsert('category', 'c1'), upsert('category', 'c2'),
      link('i1', 'c1'), link('i1', 'c2'), link('i2', 'c1'),
    ], { createIfMissing: true }));
    expect(await describeGraph(adapter, 'g')).toMatchObject({
      ok: true,
      value: { itemCount: 3, categoryCount: 2, edgeCount: 3 },
    });
  });

  it('counts an item and a category sharing an id as two nodes, and a repeated link once', async () => {
    const adapter = createMemoryAdapter();
    await write(adapter, mutation('g', [upsert('item', 'x'), upsert('category', 'x'), link('x', 'x'), link('x', 'x')], { createIfMissing: true }));
    expect(await describeGraph(adapter, 'g')).toMatchObject({ ok: true, value: { itemCount: 1, categoryCount: 1, edgeCount: 1 } });
  });

  it('follows writes and cascade deletes', async () => {
    const adapter = createMemoryAdapter();
    await write(adapter, mutation('g', [
      upsert('item', 'i1'), upsert('item', 'i2'), upsert('category', 'c1'), upsert('category', 'c2'),
      link('i1', 'c1'), link('i2', 'c1'), link('i1', 'c2'),
    ], { createIfMissing: true }));
    await write(adapter, mutation('g', [{ op: 'deleteNode', partition: 'category', id: 'c1' }]));
    expect(await describeGraph(adapter, 'g')).toMatchObject({ ok: true, value: { itemCount: 2, categoryCount: 1, edgeCount: 1 } });
    await write(adapter, mutation('g', [{ op: 'unlink', item: 'i1', category: 'c2' }]));
    expect(await describeGraph(adapter, 'g')).toMatchObject({ ok: true, value: { edgeCount: 0 } });
  });

  it('counts correctly across page boundaries (1500 items, 2300 edges)', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('big');
    await adapter.transaction('big', async (tx) => {
      const items = Array.from({ length: 1500 }, (_, i) => ({ partition: 'item' as const, id: `i${pad(i)}` }));
      await tx.putNodes([...items, { partition: 'category', id: 'c1' }, { partition: 'category', id: 'c2' }]);
      await tx.putEdges([
        ...items.slice(0, 1500).map(({ id }) => ({ item: id, category: 'c1' })),
        ...items.slice(0, 800).map(({ id }) => ({ item: id, category: 'c2' })),
      ]);
    });
    expect(await describeGraph(adapter, 'big')).toEqual({
      ok: true,
      value: { graphId: 'big', itemCount: 1500, categoryCount: 2, edgeCount: 2300 },
    });
  });

  it('only counts the named graph', async () => {
    const adapter = createMemoryAdapter();
    await write(adapter, mutation('a', [upsert('item', 'i'), upsert('category', 'c'), link('i', 'c')], { createIfMissing: true }));
    await write(adapter, mutation('b', [upsert('item', 'i2')], { createIfMissing: true }));
    expect(await describeGraph(adapter, 'b')).toMatchObject({ ok: true, value: { itemCount: 1, categoryCount: 0, edgeCount: 0 } });
  });

  it('does not change the graph', async () => {
    const adapter = createMemoryAdapter();
    await write(adapter, mutation('g', [upsert('item', 'i'), upsert('category', 'c'), link('i', 'c')], { createIfMissing: true }));
    const before = await describeGraph(adapter, 'g');
    await describeGraph(adapter, 'g');
    expect(await describeGraph(adapter, 'g')).toEqual(before);
  });

  it('fails with GRAPH_NOT_FOUND for a missing graph', async () => {
    expect(await describeGraph(createMemoryAdapter(), 'nope')).toMatchObject({
      ok: false,
      error: { code: 'GRAPH_NOT_FOUND', path: ['graphId'] },
    });
  });

  it.each([['empty', ''], ['too long', 'x'.repeat(257)], ['undefined', undefined]])(
    'rejects %s with VALIDATION_ERROR and never touches the adapter',
    async (_name, bad) => {
      expect(await describeGraph(untouchable, bad as unknown as string)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    },
  );

  it('turns adapter failures into STORAGE_ERROR instead of throwing', async () => {
    const real = createMemoryAdapter();
    await real.graphs.create('g');
    const failing: StorageAdapter = { ...real, transaction: async () => { throw new Error('read failed'); } };
    expect(await describeGraph(failing, 'g')).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: expect.stringContaining('read failed') },
    });
    expect(await describeGraph(untouchable, 'g')).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
  });
});
