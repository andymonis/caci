import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from './adapters/memory/index.js';
import type { AdapterTx, EdgeRecord, NodeRecord, StorageAdapter } from './adapter.js';
import { parseQuery } from './parse.js';
import { executeQuery } from './query-exec.js';
import { planQuery } from './query-plan.js';
import type { QueryOutput, SubgraphOutput } from './types.js';

type Raw = Record<string, unknown>;
const item = (id: string, data?: NodeRecord['data']): NodeRecord => (data === undefined ? { partition: 'item', id } : { partition: 'item', id, data });
const category = (id: string, data?: NodeRecord['data']): NodeRecord => (data === undefined ? { partition: 'category', id } : { partition: 'category', id, data });
const link = (i: string, c: string, extra: Partial<EdgeRecord> = {}): EdgeRecord => ({ item: i, category: c, ...extra });

/** doctor-x has four visits; the same visits (and v50) are also under appointments; v17 is under billing too. */
async function clinic(): Promise<StorageAdapter> {
  const adapter = createMemoryAdapter();
  await adapter.graphs.create('g');
  await adapter.transaction('g', async (tx) => {
    await tx.putNodes([
      ...['v14', 'v17', 'v21', 'v30', 'v50', 'shopping'].map((id) => item(id, { id })),
      ...['doctor-x', 'appointments', 'billing', 'errands'].map((id) => category(id, { label: id })),
    ]);
    await tx.putEdges([
      ...['v14', 'v17', 'v21', 'v30'].map((v) => link(v, 'doctor-x', { data: { why: 'visit' } })),
      ...['v14', 'v17', 'v21', 'v30', 'v50'].map((v) => link(v, 'appointments', { weight: 0.5 })),
      link('v17', 'billing', { weight: 0 }),
      link('shopping', 'errands'),
    ]);
  });
  return adapter;
}

const base = { version: 1, graphId: 'g', return: { shape: 'subgraph' } };
async function run(adapter: StorageAdapter, input: Raw, limits?: { maxReachedNodes: number }) {
  const parsed = parseQuery({ ...base, ...input });
  if (!parsed.ok) return parsed;
  const plan = planQuery(parsed.value);
  if (!plan.ok) return plan;
  return executeQuery(adapter, plan.value, limits);
}
async function sub(adapter: StorageAdapter, input: Raw, limits?: { maxReachedNodes: number }): Promise<SubgraphOutput> {
  const r = await run(adapter, input, limits);
  if (!r.ok) throw new Error(`query failed: ${r.error.code} ${r.error.message}`);
  if (!('edges' in r.value)) throw new Error('not a subgraph result');
  return r.value;
}
const nodeKeys = (o: SubgraphOutput) => o.nodes.map((n) => `${n.partition === 'item' ? 'i' : 'c'}:${n.id}`);
const edgeKeys = (o: SubgraphOutput) => o.edges.map((e) => `${e.item}>${e.category}`);
const from = (partition: string, ids: string[], depth: number) => ({ from: { partition, ids }, traverse: { depth } });

describe('a subgraph holds the nodes and only the edges with both ends in the result (AC-17)', () => {
  it('doctor X at depth 1: exactly it, its 4 visits and the 4 edges between them', async () => {
    const out = await sub(await clinic(), from('category', ['doctor-x'], 1));
    expect(nodeKeys(out)).toEqual(['i:v14', 'i:v17', 'i:v21', 'i:v30', 'c:doctor-x']);
    expect(edgeKeys(out)).toEqual(['v14>doctor-x', 'v17>doctor-x', 'v21>doctor-x', 'v30>doctor-x']);
    expect(out).toMatchObject({ nextCursor: null, truncated: false });
  });

  it('leaves out edges to categories that are not in the result (the visits are also under appointments and billing)', async () => {
    const out = await sub(await clinic(), from('category', ['doctor-x'], 1));
    expect(edgeKeys(out).some((e) => e.endsWith('>appointments') || e.endsWith('>billing'))).toBe(false);
  });

  it('gains edges as the depth brings their other end into the result', async () => {
    const adapter = await clinic();
    expect(edgeKeys(await sub(adapter, from('category', ['doctor-x'], 2)))).toEqual([
      'v14>appointments', 'v14>doctor-x', 'v17>appointments', 'v17>billing', 'v17>doctor-x',
      'v21>appointments', 'v21>doctor-x', 'v30>appointments', 'v30>doctor-x',
    ]);
    expect(edgeKeys(await sub(adapter, from('category', ['doctor-x'], 3)))).toHaveLength(10); // adds v50>appointments
  });

  it('from an item, depth 1 gives the item, its categories and the edges to them', async () => {
    const out = await sub(await clinic(), from('item', ['v17'], 1));
    expect(nodeKeys(out)).toEqual(['i:v17', 'c:appointments', 'c:billing', 'c:doctor-x']);
    expect(edgeKeys(out)).toEqual(['v17>appointments', 'v17>billing', 'v17>doctor-x']);
  });

  it('depth 0 is a lone node with no edges', async () => {
    const out = await sub(await clinic(), from('category', ['doctor-x'], 0));
    expect([nodeKeys(out), out.edges]).toEqual([['c:doctor-x'], []]);
  });

  it('a result with no edges has an empty edge list, not a missing one', async () => {
    const out = await sub(await clinic(), from('item', ['shopping', 'v50'], 0));
    expect(out.edges).toEqual([]);
    expect(Array.isArray(out.edges)).toBe(true);
  });
});

describe('weight and data on edges', () => {
  it('always reports a weight: the stored one, including 0, or 1 when none was stored', async () => {
    const adapter = await clinic();
    const out = await sub(adapter, from('item', ['v17'], 1));
    expect(out.edges).toEqual([
      { item: 'v17', category: 'appointments', weight: 0.5 },
      { item: 'v17', category: 'billing', weight: 0 },
      { item: 'v17', category: 'doctor-x', weight: 1 }, // stored without a weight
    ]);
  });

  it('leaves edge data out unless includeData is set, then includes what is stored', async () => {
    const adapter = await clinic();
    const without = await sub(adapter, from('category', ['doctor-x'], 1));
    expect(without.edges.every((e) => !('data' in e))).toBe(true);
    const withData = await sub(adapter, { ...from('category', ['doctor-x'], 1), return: { shape: 'subgraph', includeData: true } });
    expect(withData.edges.every((e) => JSON.stringify(e.data) === '{"why":"visit"}')).toBe(true);
    expect(withData.nodes.find((n) => n.id === 'v14')?.data).toEqual({ id: 'v14' });
  });

  it('an edge with no stored data has no data key even when asked for', async () => {
    const out = await sub(await clinic(), { ...from('item', ['shopping'], 1), return: { shape: 'subgraph', includeData: true } });
    expect(out.edges).toEqual([{ item: 'shopping', category: 'errands', weight: 1 }]);
  });
});

describe('filters decide which nodes are in the result, and so which edges can be', () => {
  it('a partition filter leaves only one kind of node, so no edge has both ends', async () => {
    const adapter = await clinic();
    expect((await sub(adapter, { ...from('category', ['doctor-x'], 3), filter: { partition: 'item' } })).edges).toEqual([]);
    expect((await sub(adapter, { ...from('category', ['doctor-x'], 3), filter: { partition: 'category' } })).edges).toEqual([]);
    expect((await sub(adapter, { filter: { partition: 'item' }, from: { all: true } })).edges).toEqual([]);
  });

  it('excludeSeeds drops the seed category, so the edges to it go too', async () => {
    const out = await sub(await clinic(), { ...from('category', ['doctor-x'], 1), filter: { excludeSeeds: true } });
    expect(nodeKeys(out)).toEqual(['i:v14', 'i:v17', 'i:v21', 'i:v30']);
    expect(out.edges).toEqual([]);
  });

  it('excludeSeeds on a deeper walk keeps the edges among what remains', async () => {
    const out = await sub(await clinic(), { ...from('category', ['doctor-x'], 2), filter: { excludeSeeds: true } });
    expect(edgeKeys(out)).toEqual(['v14>appointments', 'v17>appointments', 'v17>billing', 'v21>appointments', 'v30>appointments']);
  });
});

/** 120 items and 5 categories with a known set of edges, beside a second graph that reuses the same ids. */
async function bigGraph() {
  const adapter = createMemoryAdapter();
  await adapter.graphs.create('g');
  await adapter.graphs.create('h');
  const ids = Array.from({ length: 120 }, (_, i) => `i${String(i + 1).padStart(3, '0')}`);
  const cats = ['c1', 'c2', 'c3', 'c4', 'c5'];
  const edges: EdgeRecord[] = ids.flatMap((id, i) => [link(id, cats[i % 5] as string), ...(i % 3 === 0 ? [link(id, cats[(i + 1) % 5] as string, { weight: 2 })] : [])]);
  await adapter.transaction('g', async (tx) => {
    await tx.putNodes([...ids.map((id) => item(id)), ...cats.map((c) => category(c))]);
    await tx.putEdges(edges);
  });
  await adapter.transaction('h', async (tx) => {
    await tx.putNodes([item('i001'), item('i002'), category('c1'), category('c2'), item('only-h')]);
    await tx.putEdges([link('i001', 'c2'), link('i002', 'c1'), link('only-h', 'c1')]);
  });
  return { adapter, ids, cats, edges };
}

async function everyPage(adapter: StorageAdapter, input: Raw, limit: number): Promise<SubgraphOutput[]> {
  const out: SubgraphOutput[] = [];
  let cursor: string | null = null;
  do {
    const page: SubgraphOutput = await sub(adapter, { ...input, page: { limit, cursor } });
    out.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null && out.length < 500);
  return out;
}

describe('the whole graph, paged (AC-19)', () => {
  it('returns every node and every edge exactly once across pages, and nothing from another graph', async () => {
    const { adapter, ids, cats, edges } = await bigGraph();
    const pages = await everyPage(adapter, { from: { all: true } }, 50);
    expect(pages.map((p) => p.nodes.length)).toEqual([50, 50, 25]);
    expect(pages.flatMap(nodeKeys)).toEqual([...ids.map((id) => `i:${id}`), ...cats.map((c) => `c:${c}`)]);
    const seen = pages.flatMap(edgeKeys);
    expect(new Set(seen).size).toBe(seen.length); // no edge twice
    expect([...seen].sort()).toEqual(edges.map((e) => `${e.item}>${e.category}`).sort());
    expect(seen.some((e) => e.includes('only-h'))).toBe(false);
  });

  it('an edge travels with its item, so the first page can hold edges to categories that arrive on a later page', async () => {
    const { adapter } = await bigGraph();
    const pages = await everyPage(adapter, { from: { all: true } }, 50);
    expect(pages[0]?.nodes.some((n) => n.partition === 'category')).toBe(false);
    expect(pages[0]?.edges.length).toBeGreaterThan(50); // more edges than the limit, by design
    expect(pages[2]?.edges.every((e) => pages[2]?.nodes.some((n) => n.id === e.item))).toBe(true);
  });

  it('the same edges come back whatever the page size', async () => {
    const { adapter } = await bigGraph();
    const edgeSet = async (limit: number) => [...(await everyPage(adapter, { from: { all: true } }, limit)).flatMap(edgeKeys)].sort();
    expect(await edgeSet(7)).toEqual(await edgeSet(1000));
    expect(await edgeSet(1)).toEqual(await edgeSet(125));
  });

  it('reports the edge weights that were stored', async () => {
    const { adapter } = await bigGraph();
    const all = (await everyPage(adapter, { from: { all: true } }, 1000)).flatMap((p) => p.edges);
    expect(all.filter((e) => e.weight === 2)).toHaveLength(40);
    expect(all.filter((e) => e.weight === 1)).toHaveLength(120);
  });

  it('paging a walked subgraph also returns each edge once', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    const ids = Array.from({ length: 120 }, (_, i) => `i${String(i + 1).padStart(3, '0')}`);
    await adapter.transaction('g', async (tx) => {
      await tx.putNodes([category('hub'), category('other'), ...ids.map((id) => item(id))]);
      await tx.putEdges([...ids.map((id) => link(id, 'hub')), ...ids.slice(0, 10).map((id) => link(id, 'other'))]);
    });
    const pages = await everyPage(adapter, from('category', ['hub'], 2), 50);
    const seen = pages.flatMap(edgeKeys);
    expect(seen).toHaveLength(130);
    expect(new Set(seen).size).toBe(130);
  });

  it('is deterministic, and its edges are ordered by item then category', async () => {
    const { adapter } = await bigGraph();
    const a = await everyPage(adapter, { from: { all: true } }, 50);
    expect(await everyPage(adapter, { from: { all: true } }, 50)).toEqual(a);
    const keys = a.flatMap((p) => p.edges).map((e) => [e.item, e.category] as const);
    expect(keys).toEqual([...keys].sort(([ai, ac], [bi, bc]) => (ai < bi ? -1 : ai > bi ? 1 : ac < bc ? -1 : ac > bc ? 1 : 0)));
  });
});

describe('edges that must not appear', () => {
  it('an edge to a category that does not exist is left out', async () => {
    const adapter = await clinic();
    await adapter.transaction('g', (tx) => tx.putEdges([link('v14', 'ghost-category')]));
    const all = await sub(adapter, { from: { all: true }, page: { limit: 1000 } });
    expect(edgeKeys(all).some((e) => e.includes('ghost'))).toBe(false);
    const walked = await sub(adapter, from('item', ['v14'], 1));
    expect(edgeKeys(walked).some((e) => e.includes('ghost'))).toBe(false);
  });

  it('never returns edges of another graph that uses the same ids', async () => {
    const { adapter } = await bigGraph();
    const inH = await sub(adapter, { graphId: 'h', from: { all: true }, page: { limit: 100 } });
    expect(edgeKeys(inH)).toEqual(['i001>c2', 'i002>c1', 'only-h>c1']);
    const inG = await sub(adapter, { from: { partition: 'item', ids: ['i001'] }, traverse: { depth: 1 } });
    expect(edgeKeys(inG).every((e) => !e.includes('only-h'))).toBe(true);
  });
});

describe('an item and a category with the same id (FR-04)', () => {
  it('keeps their edges apart: each edge is reported once, under the right item', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    await adapter.transaction('g', async (tx) => {
      await tx.putNodes([item('x'), category('x'), category('c1'), item('i1')]);
      await tx.putEdges([link('x', 'c1'), link('i1', 'x')]); // item x -> c1, and item i1 -> category x
    });
    const all = await sub(adapter, { from: { all: true }, page: { limit: 100 } });
    expect(nodeKeys(all)).toEqual(['i:i1', 'i:x', 'c:c1', 'c:x']);
    expect(edgeKeys(all)).toEqual(['i1>x', 'x>c1']);
    const walked = await sub(adapter, from('category', ['x'], 1));
    expect(nodeKeys(walked)).toEqual(['i:i1', 'c:x']);
    expect(edgeKeys(walked)).toEqual(['i1>x']);
  });
});

describe('the cap on edges per page', () => {
  it('stops collecting at the cap and marks the page truncated', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    const cats = Array.from({ length: 300 }, (_, i) => `c${String(i).padStart(3, '0')}`);
    await adapter.transaction('g', async (tx) => {
      await tx.putNodes([item('big'), ...cats.map((c) => category(c))]);
      await tx.putEdges(cats.map((c) => link('big', c)));
    });
    const out = await sub(adapter, { from: { all: true }, page: { limit: 1000 } }, { maxReachedNodes: 100 });
    expect(out.edges).toHaveLength(100);
    expect(out.truncated).toBe(true);
    expect(out.edges.map((e) => e.category)).toEqual(cats.slice(0, 100)); // deterministic: the first 100 in order
    expect(await sub(adapter, { from: { all: true }, page: { limit: 1000 } }, { maxReachedNodes: 1000 })).toMatchObject({ truncated: false });
  });
});

describe('failures and read-only', () => {
  it('works on an adapter whose write primitives throw', async () => {
    const real = (await bigGraph()).adapter;
    const noWrites: StorageAdapter = {
      ...real,
      transaction: (graphId, fn) =>
        real.transaction(graphId, (tx) =>
          fn({
            ...tx,
            putNodes: async () => { throw new Error('a query wrote'); },
            deleteNodes: async () => { throw new Error('a query wrote'); },
            putEdges: async () => { throw new Error('a query wrote'); },
            deleteEdges: async () => { throw new Error('a query wrote'); },
          } as AdapterTx),
        ),
    };
    expect((await run(noWrites, { from: { all: true } })).ok).toBe(true);
    expect((await run(noWrites, from('category', ['c1'], 2))).ok).toBe(true);
  });

  it('a missing graph is GRAPH_NOT_FOUND', async () => {
    expect(await run(await clinic(), { graphId: 'nope', from: { all: true } })).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND' } });
  });

  it('the other shapes are unaffected: no edges key appears on nodes, ids or count', async () => {
    const adapter = await clinic();
    for (const shape of ['nodes', 'ids', 'count'] as const) {
      const r = await run(adapter, { ...from('category', ['doctor-x'], 1), return: { shape } });
      expect(r.ok && 'edges' in (r.value as QueryOutput)).toBe(false);
    }
  });
});
