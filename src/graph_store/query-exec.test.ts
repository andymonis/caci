import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from './adapters/memory/index.js';
import type { AdapterTx, NodeRecord, StorageAdapter } from './adapter.js';
import { parseQuery } from './parse.js';
import { readOnly, executeQuery } from './query-exec.js';
import { planQuery } from './query-plan.js';
import type { QueryOutput } from './types.js';

const pad = (n: number, width = 3): string => String(n).padStart(width, '0');
const items120 = Array.from({ length: 120 }, (_, i) => `i${pad(i + 1)}`);

/** Graph `g`: 120 items (with data), 5 categories; graph `h` reuses some ids with different data. */
async function populated(): Promise<StorageAdapter> {
  const adapter = createMemoryAdapter();
  await adapter.graphs.create('g');
  await adapter.graphs.create('h');
  await adapter.transaction('g', async (tx) => {
    await tx.putNodes([
      ...[...items120].reverse().map((id) => ({ partition: 'item' as const, id, data: { n: id, from: 'g' } })),
      ...['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({ partition: 'category' as const, id, data: { label: id } })),
    ]);
    await tx.putEdges([{ item: 'i001', category: 'c1' }]);
  });
  await adapter.transaction('h', (tx) =>
    tx.putNodes([
      { partition: 'item', id: 'i001', data: { from: 'h' } },
      { partition: 'item', id: 'only-in-h', data: { from: 'h' } },
      { partition: 'category', id: 'c1', data: { from: 'h' } },
    ]),
  );
  return adapter;
}

const base = { version: 1, graphId: 'g', from: { all: true }, return: { shape: 'nodes' } };
type Raw = Record<string, unknown>;

/** The whole read path as `query()` will use it: parse, plan, execute. */
async function run(adapter: StorageAdapter, input: Raw, limits?: { maxReachedNodes: number }) {
  const parsed = parseQuery({ ...base, ...input });
  if (!parsed.ok) return parsed;
  const plan = planQuery(parsed.value);
  if (!plan.ok) return plan;
  return executeQuery(adapter, plan.value, limits);
}
async function value(adapter: StorageAdapter, input: Raw, limits?: { maxReachedNodes: number }): Promise<QueryOutput> {
  const r = await run(adapter, input, limits);
  if (!r.ok) throw new Error(`query failed: ${r.error.code} ${r.error.message}`);
  return r.value;
}
const nodesOf = (out: QueryOutput) => ('nodes' in out ? out.nodes : []);
const idsOf = (out: QueryOutput) => nodesOf(out).map((n) => n.id);

/** Reads pages until the cursor runs out. */
async function allPages(adapter: StorageAdapter, input: Raw, limit: number) {
  const pages: QueryOutput[] = [];
  let cursor: string | null = null;
  do {
    const out = await value(adapter, { ...input, page: { limit, cursor } });
    pages.push(out);
    cursor = 'nextCursor' in out ? out.nextCursor : null;
    if (pages.length > 500) throw new Error('paging did not finish');
  } while (cursor !== null);
  return pages;
}

describe('everything in a graph (from: all)', () => {
  it('lists items first, then categories, each by id', async () => {
    const out = await value(await populated(), { page: { limit: 1000 } });
    expect(nodesOf(out).map((n) => `${n.partition}:${n.id}`)).toEqual([...items120.map((id) => `item:${id}`), ...['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => `category:${id}`)]);
    expect(out).toMatchObject({ nextCursor: null, truncated: false });
  });

  it('leaves out data unless includeData is set, and includes it when it is', async () => {
    const adapter = await populated();
    const without = nodesOf(await value(adapter, { page: { limit: 2 } }));
    expect(without[0]).toEqual({ partition: 'item', id: 'i001' });
    expect('data' in (without[0] ?? {})).toBe(false);
    const withData = nodesOf(await value(adapter, { return: { shape: 'nodes', includeData: true }, page: { limit: 2 } }));
    expect(withData[0]).toEqual({ partition: 'item', id: 'i001', data: { n: 'i001', from: 'g' } });
  });

  it('the ids shape gives only references, never data, even when asked for it', async () => {
    const out = await value(await populated(), { return: { shape: 'ids', includeData: true }, page: { limit: 3 } });
    expect(out).toMatchObject({ ids: [{ partition: 'item', id: 'i001' }, { partition: 'item', id: 'i002' }, { partition: 'item', id: 'i003' }] });
    expect(JSON.stringify(out)).not.toContain('"data"');
  });

  it('the count shape counts everything', async () => {
    expect(await value(await populated(), { return: { shape: 'count' } })).toEqual({ count: 125, truncated: false });
  });

  it('the partition filter keeps one kind of node', async () => {
    const adapter = await populated();
    expect(idsOf(await value(adapter, { filter: { partition: 'category' }, page: { limit: 100 } }))).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(await value(adapter, { filter: { partition: 'item' }, return: { shape: 'count' } })).toEqual({ count: 120, truncated: false });
    expect(await value(adapter, { filter: { partition: 'category' }, return: { shape: 'count' } })).toEqual({ count: 5, truncated: false });
  });

  it('puts upper case before lower case and handles awkward ids (UTF-16 order)', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    const ids = ['b', 'B', 'a', 'A', 'ünï', 'a/b', '../x', 'a b'];
    await adapter.transaction('g', (tx) => tx.putNodes(ids.map((id) => ({ partition: 'item' as const, id }))));
    expect(idsOf(await value(adapter, {}))).toEqual([...ids].sort());
  });

  it('is an empty result, not an error, for an empty graph', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    expect(await value(adapter, {})).toEqual({ nodes: [], nextCursor: null, truncated: false });
    expect(await value(adapter, { return: { shape: 'count' } })).toEqual({ count: 0, truncated: false });
  });
});

describe('paging', () => {
  it('returns 120 matches as 3 pages of unique nodes in stable order (AC-09)', async () => {
    const pages = await allPages(await populated(), { filter: { partition: 'item' } }, 50);
    expect(pages.map((p) => idsOf(p).length)).toEqual([50, 50, 20]);
    expect(pages.flatMap(idsOf)).toEqual(items120);
    expect(pages.map((p) => ('nextCursor' in p ? p.nextCursor !== null : false))).toEqual([true, true, false]);
  });

  it('carries on from the last item into the categories, across the partition boundary', async () => {
    const pages = await allPages(await populated(), {}, 50);
    expect(pages.map((p) => idsOf(p).length)).toEqual([50, 50, 25]);
    expect(pages[2] && nodesOf(pages[2]).slice(-5).map((n) => n.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('has no next cursor when a page exactly fills the limit with nothing after it', async () => {
    const adapter = await populated();
    const exact = await allPages(adapter, { filter: { partition: 'category' } }, 5);
    expect(exact).toHaveLength(1);
    expect(exact[0]).toMatchObject({ nextCursor: null });
    expect((await allPages(adapter, { filter: { partition: 'item' } }, 60)).map((p) => idsOf(p).length)).toEqual([60, 60]);
  });

  it('walks everything one node at a time', async () => {
    const pages = await allPages(await populated(), { filter: { partition: 'category' } }, 1);
    expect(pages.flatMap(idsOf)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(pages).toHaveLength(5);
  });

  it('does not skip or repeat when nodes are added or removed between pages', async () => {
    const adapter = await populated();
    const first = await value(adapter, { filter: { partition: 'item' }, page: { limit: 3 } });
    expect(idsOf(first)).toEqual(['i001', 'i002', 'i003']);
    await adapter.transaction('g', async (tx) => {
      await tx.putNodes([{ partition: 'item', id: 'a-before-everything' }, { partition: 'item', id: 'i003x' }]);
      await tx.deleteNodes('item', ['i004']);
    });
    const cursor = 'nextCursor' in first ? first.nextCursor : null;
    const second = await value(adapter, { filter: { partition: 'item' }, page: { limit: 3, cursor } });
    expect(idsOf(second)).toEqual(['i003x', 'i005', 'i006']); // new node after the cursor appears, deleted one is gone, earlier one is not shown
  });

  it('refuses a cursor from a different query, and a garbage one, before reading anything', async () => {
    const adapter = await populated();
    const out = await value(adapter, { filter: { partition: 'item' }, page: { limit: 2 } });
    const cursor = 'nextCursor' in out ? out.nextCursor : null;
    expect(await run(adapter, { filter: { partition: 'category' }, page: { cursor } })).toMatchObject({ ok: false, error: { path: ['page', 'cursor'] } });
    expect(await run(adapter, { page: { cursor: 'garbage' } })).toMatchObject({ ok: false, error: { path: ['page', 'cursor'] } });
  });
});

describe('named seeds (depth 0)', () => {
  const seeds = (ids: string[], partition = 'item') => ({ from: { partition, ids }, traverse: { depth: 0 } });

  it('returns the seeds that exist, in result order, ignoring the ones that do not', async () => {
    const adapter = await populated();
    expect(idsOf(await value(adapter, seeds(['i010', 'nope', 'i002', 'i010', 'also-nope'])))).toEqual(['i002', 'i010']);
    expect(await value(adapter, { ...seeds(['nope']), return: { shape: 'count' } })).toEqual({ count: 0, truncated: false });
  });

  it('works for categories, with data when asked', async () => {
    const out = await value(await populated(), { ...seeds(['c2', 'c1'], 'category'), return: { shape: 'nodes', includeData: true } });
    expect(nodesOf(out)).toEqual([
      { partition: 'category', id: 'c1', data: { label: 'c1' } },
      { partition: 'category', id: 'c2', data: { label: 'c2' } },
    ]);
  });

  it('applies the partition filter: seeds of the other kind are dropped', async () => {
    const adapter = await populated();
    expect(idsOf(await value(adapter, { ...seeds(['c1'], 'category'), filter: { partition: 'item' } }))).toEqual([]);
    expect(idsOf(await value(adapter, { ...seeds(['c1'], 'category'), filter: { partition: 'category' } }))).toEqual(['c1']);
  });

  it('excludeSeeds leaves nothing at depth 0', async () => {
    expect(idsOf(await value(await populated(), { ...seeds(['i001']), filter: { excludeSeeds: true } }))).toEqual([]);
    expect(idsOf(await value(await populated(), { filter: { excludeSeeds: true } }))).toEqual([]); // everything is a seed
  });

  it('pages 120 named seeds as 3 pages, and counts them', async () => {
    const adapter = await populated();
    const pages = await allPages(adapter, seeds(items120), 50);
    expect(pages.map((p) => idsOf(p).length)).toEqual([50, 50, 20]);
    expect(pages.flatMap(idsOf)).toEqual(items120);
    expect(await value(adapter, { ...seeds(items120), return: { shape: 'count' } })).toEqual({ count: 120, truncated: false });
  });

  it('handles more seeds than one read holds (2,500 ids)', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    const ids = Array.from({ length: 2500 }, (_, i) => `n${pad(i, 4)}`);
    await adapter.transaction('g', (tx) => tx.putNodes(ids.map((id) => ({ partition: 'item' as const, id }))));
    expect(await value(adapter, { ...seeds(ids), return: { shape: 'count' } })).toEqual({ count: 2500, truncated: false });
  });
});

describe('caps', () => {
  it('count stops at the reached-node cap and says it is a lower bound', async () => {
    const adapter = await populated();
    expect(await value(adapter, { return: { shape: 'count' } }, { maxReachedNodes: 100 })).toEqual({ count: 100, truncated: true });
    expect(await value(adapter, { return: { shape: 'count' } }, { maxReachedNodes: 125 })).toEqual({ count: 125, truncated: false });
  });

  it('named seeds beyond the cap are cut and marked truncated', async () => {
    const out = await value(await populated(), { from: { partition: 'item', ids: items120 }, traverse: { depth: 0 }, page: { limit: 1000 } }, { maxReachedNodes: 30 });
    expect(idsOf(out)).toEqual(items120.slice(0, 30));
    expect(out).toMatchObject({ truncated: true });
  });
});

describe('what is not built yet is refused by name (traversal is covered in query-traverse.test.ts)', () => {
  it('the subgraph shape', async () => {
    expect(await run(await populated(), { return: { shape: 'subgraph' } })).toMatchObject({ ok: false, error: { path: ['return', 'shape'] } });
  });
});

describe('graphs and isolation', () => {
  it('a missing graph is GRAPH_NOT_FOUND', async () => {
    expect(await run(await populated(), { graphId: 'nope' })).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND', path: ['graphId'] } });
  });

  it('never returns anything from another graph, even with identical ids', async () => {
    const adapter = await populated();
    const out = await value(adapter, { graphId: 'h', return: { shape: 'nodes', includeData: true }, page: { limit: 100 } });
    expect(nodesOf(out)).toEqual([
      { partition: 'item', id: 'i001', data: { from: 'h' } },
      { partition: 'item', id: 'only-in-h', data: { from: 'h' } },
      { partition: 'category', id: 'c1', data: { from: 'h' } },
    ]);
    expect(await value(adapter, { graphId: 'h', return: { shape: 'count' } })).toEqual({ count: 3, truncated: false });
    expect(idsOf(await value(adapter, { graphId: 'g', from: { partition: 'item', ids: ['only-in-h'] }, traverse: { depth: 0 } }))).toEqual([]);
  });
});

describe('determinism and read-only (AC-13, AC-22)', () => {
  const battery: Raw[] = [
    {},
    { page: { limit: 7 } },
    { filter: { partition: 'category' }, return: { shape: 'nodes', includeData: true } },
    { return: { shape: 'ids' }, page: { limit: 40 } },
    { return: { shape: 'count' } },
    { from: { partition: 'item', ids: ['i005', 'i001', 'zzz'] }, traverse: { depth: 0 } },
    { graphId: 'h', return: { shape: 'nodes', includeData: true } },
  ];

  it('the same query on an unchanged store gives deep-equal results, cursors included', async () => {
    const adapter = await populated();
    for (const q of battery) expect(await run(adapter, q)).toEqual(await run(adapter, q));
  });

  /** Everything stored, read back through the adapter's own primitives. */
  async function dump(adapter: StorageAdapter): Promise<unknown> {
    const out: Record<string, unknown> = {};
    for (const graphId of ['g', 'h']) {
      out[graphId] = await adapter.transaction(graphId, async (tx) => {
        const page = { limit: 1000, cursor: null };
        const items = (await tx.listNodes('item', page)).items;
        const categories = (await tx.listNodes('category', page)).items;
        const edges = [];
        for (const i of items) edges.push(...(await tx.edgesOf('item', i.id, page)).items);
        return { items, categories, edges };
      });
    }
    out.graphs = (await adapter.graphs.list({ limit: 100, cursor: null })).items;
    return JSON.stringify(out);
  }

  it('leaves the store exactly as it was after any valid query', async () => {
    const adapter = await populated();
    const before = await dump(adapter);
    for (const q of battery) await run(adapter, q);
    await allPages(adapter, {}, 7);
    expect(await dump(adapter)).toBe(before);
  });

  it('works on an adapter whose write primitives all throw, so no query can be writing', async () => {
    const real = await populated();
    const noWrites: StorageAdapter = {
      ...real,
      transaction: (graphId, fn) =>
        real.transaction(graphId, (tx) =>
          fn({
            ...tx,
            putNodes: async () => { throw new Error('a query wrote nodes'); },
            deleteNodes: async () => { throw new Error('a query deleted nodes'); },
            putEdges: async () => { throw new Error('a query wrote edges'); },
            deleteEdges: async () => { throw new Error('a query deleted edges'); },
          } as AdapterTx),
        ),
    };
    for (const q of battery) expect((await run(noWrites, q)).ok).toBe(true);
  });

  it('the read-only handle has exactly the three read methods and cannot be extended', () => {
    const handle = readOnly({} as AdapterTx);
    expect(Object.keys(handle).sort()).toEqual(['edgesOf', 'getNodes', 'listNodes']);
    expect(Object.isFrozen(handle)).toBe(true);
    expect('putNodes' in handle).toBe(false);
  });
});

describe('adapter failures', () => {
  it('turns adapter errors into STORAGE_ERROR instead of throwing', async () => {
    const real = await populated();
    const failing: StorageAdapter = { ...real, transaction: async () => { throw new Error('disk gone'); } };
    expect(await run(failing, {})).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR', message: expect.stringContaining('disk gone') } });
    const hostile = new Proxy({}, { get() { throw new Error('exploded'); } }) as StorageAdapter;
    expect(await run(hostile, {})).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
  });

  it('stops with STORAGE_ERROR instead of looping forever when the adapter cursor does not advance', async () => {
    const real = await populated();
    const stuck: StorageAdapter = {
      ...real,
      transaction: (graphId, fn) =>
        real.transaction(graphId, (tx) =>
          fn({ ...tx, listNodes: async (p: NodeRecord['partition']) => ({ items: (await tx.listNodes(p, { limit: 2, cursor: null })).items, nextCursor: 'same' }) } as AdapterTx),
        ),
    };
    const r = await run(stuck, { page: { limit: 1000 } });
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR', message: expect.stringContaining('did not advance') } });
  });
});
