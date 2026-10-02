import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from './adapters/memory/index.js';
import type { AdapterTx, EdgeRecord, NodeRecord, StorageAdapter } from './adapter.js';
import { parseQuery } from './parse.js';
import { executeQuery } from './query-exec.js';
import { planQuery } from './query-plan.js';
import type { QueryOutput } from './types.js';

type Raw = Record<string, unknown>;
const item = (id: string, data?: NodeRecord['data']): NodeRecord => (data === undefined ? { partition: 'item', id } : { partition: 'item', id, data });
const category = (id: string, data?: NodeRecord['data']): NodeRecord => (data === undefined ? { partition: 'category', id } : { partition: 'category', id, data });
const edge = (i: string, c: string): EdgeRecord => ({ item: i, category: c });

/**
 * doctor-x -- v14, v17, v21, v30            (four visits)
 * appointments -- v14, v17, v21, v30, v50   (v50 is an appointment with another doctor)
 * billing -- v17
 * errands -- shopping                       (unrelated)
 */
async function clinic(): Promise<StorageAdapter> {
  const adapter = createMemoryAdapter();
  await adapter.graphs.create('g');
  await adapter.transaction('g', async (tx) => {
    await tx.putNodes([
      ...['v14', 'v17', 'v21', 'v30', 'v50', 'shopping'].map((id) => item(id, { id })),
      ...['doctor-x', 'appointments', 'billing', 'errands'].map((id) => category(id, { label: id })),
    ]);
    await tx.putEdges([
      ...['v14', 'v17', 'v21', 'v30'].map((v) => edge(v, 'doctor-x')),
      ...['v14', 'v17', 'v21', 'v30', 'v50'].map((v) => edge(v, 'appointments')),
      edge('v17', 'billing'),
      edge('shopping', 'errands'),
    ]);
  });
  return adapter;
}

const base = { version: 1, graphId: 'g', return: { shape: 'nodes' } };
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
const refs = (out: QueryOutput) => ('nodes' in out ? out.nodes : 'ids' in out ? out.ids : []).map((n) => `${n.partition === 'item' ? 'i' : 'c'}:${n.id}`);
const from = (partition: string, ids: string[], depth: number) => ({ from: { partition, ids }, traverse: { depth } });

describe('walking out from a category: each hop crosses to the other partition', () => {
  it('depth 0 is just the seed', async () => {
    expect(refs(await value(await clinic(), from('category', ['doctor-x'], 0)))).toEqual(['c:doctor-x']);
  });

  it('depth 1 gives the seed and its items (AC-17)', async () => {
    expect(refs(await value(await clinic(), from('category', ['doctor-x'], 1)))).toEqual(['i:v14', 'i:v17', 'i:v21', 'i:v30', 'c:doctor-x']);
  });

  it('depth 2 adds the other categories those items belong to', async () => {
    expect(refs(await value(await clinic(), from('category', ['doctor-x'], 2)))).toEqual([
      'i:v14', 'i:v17', 'i:v21', 'i:v30', 'c:appointments', 'c:billing', 'c:doctor-x',
    ]);
  });

  it('depth 3 reaches the items that share those categories', async () => {
    expect(refs(await value(await clinic(), from('category', ['doctor-x'], 3)))).toEqual([
      'i:v14', 'i:v17', 'i:v21', 'i:v30', 'i:v50', 'c:appointments', 'c:billing', 'c:doctor-x',
    ]);
  });

  it('never reaches the unrelated part of the graph', async () => {
    const all = refs(await value(await clinic(), from('category', ['doctor-x'], 3)));
    expect(all).not.toContain('i:shopping');
    expect(all).not.toContain('c:errands');
  });

  it('the default depth is 1', async () => {
    expect(refs(await value(await clinic(), { from: { partition: 'category', ids: ['doctor-x'] } }))).toEqual(refs(await value(await clinic(), from('category', ['doctor-x'], 1))));
  });
});

describe('walking out from an item', () => {
  it('depth 1 gives its categories', async () => {
    expect(refs(await value(await clinic(), from('item', ['v17'], 1)))).toEqual(['i:v17', 'c:appointments', 'c:billing', 'c:doctor-x']);
  });

  it('depth 2 gives the items that share a category with it (the basis of "related items")', async () => {
    const out = refs(await value(await clinic(), { ...from('item', ['v17'], 2), filter: { partition: 'item' } }));
    expect(out).toEqual(['i:v14', 'i:v17', 'i:v21', 'i:v30', 'i:v50']);
  });

  it('a seed with no edges is just itself, however deep', async () => {
    const adapter = await clinic();
    await adapter.transaction('g', (tx) => tx.putNodes([item('loner')]));
    expect(refs(await value(adapter, from('item', ['loner'], 3)))).toEqual(['i:loner']);
  });
});

describe('seeds', () => {
  it('several seeds are walked together, and a node reached from both appears once', async () => {
    const out = refs(await value(await clinic(), from('category', ['doctor-x', 'appointments'], 1)));
    expect(out).toEqual(['i:v14', 'i:v17', 'i:v21', 'i:v30', 'i:v50', 'c:appointments', 'c:doctor-x']);
    expect(new Set(out).size).toBe(out.length);
  });

  it('seeds that do not exist are ignored, and nothing is reached from them', async () => {
    const adapter = await clinic();
    expect(refs(await value(adapter, from('category', ['no-such-category', 'billing'], 1)))).toEqual(['i:v17', 'c:billing']);
    expect(refs(await value(adapter, from('category', ['no-such-category'], 3)))).toEqual([]);
  });

  it('excludeSeeds drops the seeds but keeps what was reached through them', async () => {
    const adapter = await clinic();
    expect(refs(await value(adapter, { ...from('category', ['doctor-x'], 1), filter: { excludeSeeds: true } }))).toEqual(['i:v14', 'i:v17', 'i:v21', 'i:v30']);
    expect(refs(await value(adapter, { ...from('category', ['doctor-x'], 0), filter: { excludeSeeds: true } }))).toEqual([]);
    expect(refs(await value(adapter, { ...from('category', ['doctor-x'], 2), filter: { excludeSeeds: true } }))).toEqual([
      'i:v14', 'i:v17', 'i:v21', 'i:v30', 'c:appointments', 'c:billing',
    ]);
  });

  it('the partition filter narrows the reached set but the walk still passes through the other kind', async () => {
    const adapter = await clinic();
    expect(refs(await value(adapter, { ...from('category', ['doctor-x'], 3), filter: { partition: 'item' } }))).toEqual(['i:v14', 'i:v17', 'i:v21', 'i:v30', 'i:v50']);
    expect(refs(await value(adapter, { ...from('category', ['doctor-x'], 3), filter: { partition: 'category' } }))).toEqual(['c:appointments', 'c:billing', 'c:doctor-x']);
  });
});

describe('every node once, and cycles cannot loop', () => {
  it('a node reachable by several paths appears once (v17 is under doctor-x, appointments and billing)', async () => {
    const out = refs(await value(await clinic(), from('category', ['doctor-x', 'appointments', 'billing'], 3)));
    expect(out.filter((r) => r === 'i:v17')).toHaveLength(1);
    expect(new Set(out).size).toBe(out.length);
  });

  it('a fully connected 3x3 graph at depth 3 terminates with each of its 6 nodes once', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    await adapter.transaction('g', async (tx) => {
      await tx.putNodes([...['a', 'b', 'c'].map((id) => item(id)), ...['x', 'y', 'z'].map((id) => category(id))]);
      await tx.putEdges(['a', 'b', 'c'].flatMap((i) => ['x', 'y', 'z'].map((c) => edge(i, c))));
    });
    const out = refs(await value(adapter, from('item', ['a'], 3)));
    expect(out).toEqual(['i:a', 'i:b', 'i:c', 'c:x', 'c:y', 'c:z']);
  });

  it('an edge to a node that no longer exists is skipped instead of failing the query', async () => {
    const adapter = await clinic();
    await adapter.transaction('g', (tx) => tx.putEdges([edge('ghost-item', 'doctor-x')]));
    expect(refs(await value(adapter, from('category', ['doctor-x'], 1)))).toEqual(['i:v14', 'i:v17', 'i:v21', 'i:v30', 'c:doctor-x']);
  });
});

describe('shapes, data and paging over a walked result', () => {
  it('count, ids and nodes agree', async () => {
    const adapter = await clinic();
    const q = from('category', ['doctor-x'], 2);
    expect(await value(adapter, { ...q, return: { shape: 'count' } })).toEqual({ count: 7, truncated: false });
    expect(refs(await value(adapter, { ...q, return: { shape: 'ids' } }))).toEqual(refs(await value(adapter, q)));
  });

  it('data is attached to reached nodes only when asked for', async () => {
    const adapter = await clinic();
    const out = await value(adapter, { ...from('item', ['v17'], 1), return: { shape: 'nodes', includeData: true } });
    expect('nodes' in out && out.nodes.map((n) => n.data)).toEqual([{ id: 'v17' }, { label: 'appointments' }, { label: 'billing' }, { label: 'doctor-x' }]);
  });

  it('pages a walked result with a stable cursor (120 items under one category)', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    const ids = Array.from({ length: 120 }, (_, i) => `i${String(i + 1).padStart(3, '0')}`);
    await adapter.transaction('g', async (tx) => {
      await tx.putNodes([category('hub'), ...ids.map((id) => item(id))]);
      await tx.putEdges(ids.map((id) => edge(id, 'hub')));
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const out: QueryOutput = await value(adapter, { ...from('category', ['hub'], 1), page: { limit: 50, cursor } });
      seen.push(...refs(out));
      cursor = 'nextCursor' in out ? out.nextCursor : null;
      pages += 1;
    } while (cursor !== null && pages < 20);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids.map((id) => `i:${id}`), 'c:hub']);
  });

  it('gives the same answer every time, whatever order the data was written in', async () => {
    const a = await clinic();
    const b = createMemoryAdapter();
    await b.graphs.create('g');
    await b.transaction('g', async (tx) => {
      await tx.putEdges([edge('shopping', 'errands'), edge('v17', 'billing'), ...['v50', 'v30', 'v21', 'v17', 'v14'].map((v) => edge(v, 'appointments')), ...['v30', 'v21', 'v17', 'v14'].map((v) => edge(v, 'doctor-x'))]);
      await tx.putNodes([...['doctor-x', 'appointments', 'billing', 'errands'].map((id) => category(id, { label: id })), ...['shopping', 'v50', 'v30', 'v21', 'v17', 'v14'].map((id) => item(id, { id }))]);
    });
    for (const depth of [0, 1, 2, 3]) {
      const q = { ...from('category', ['doctor-x'], depth), return: { shape: 'nodes', includeData: true } };
      expect(await value(a, q)).toEqual(await value(b, q));
      expect(await value(a, q)).toEqual(await value(a, q));
    }
  });
});

describe('graphs stay apart', () => {
  it('follows only the edges of the queried graph, even where another graph links the same ids differently', async () => {
    const adapter = await clinic();
    await adapter.graphs.create('h');
    await adapter.transaction('h', async (tx) => {
      await tx.putNodes([category('doctor-x'), item('v14'), item('stranger')]);
      await tx.putEdges([edge('stranger', 'doctor-x')]); // in h, doctor-x has a different visit
    });
    expect(refs(await value(adapter, { ...from('category', ['doctor-x'], 1), graphId: 'h' }))).toEqual(['i:stranger', 'c:doctor-x']);
    expect(refs(await value(adapter, from('category', ['doctor-x'], 1)))).toContain('i:v14');
    expect(refs(await value(adapter, from('category', ['doctor-x'], 1)))).not.toContain('i:stranger');
  });
});

describe('the reached-node cap', () => {
  it('stops at the cap, marks the result truncated, and is deterministic', async () => {
    const adapter = await clinic();
    const q = from('category', ['doctor-x'], 3);
    const small = await value(adapter, q, { maxReachedNodes: 3 });
    expect(refs(small)).toHaveLength(3);
    expect(small).toMatchObject({ truncated: true });
    expect(await value(adapter, q, { maxReachedNodes: 3 })).toEqual(small);
    expect(await value(adapter, q, { maxReachedNodes: 8 })).toMatchObject({ truncated: false });
    expect(await value(adapter, q, { maxReachedNodes: 7 })).toMatchObject({ truncated: true });
  });

  it('count under a cap is a lower bound', async () => {
    expect(await value(await clinic(), { ...from('category', ['doctor-x'], 3), return: { shape: 'count' } }, { maxReachedNodes: 4 })).toEqual({ count: 4, truncated: true });
  });

  it('a seed list larger than the cap is cut and marked truncated', async () => {
    const out = await value(await clinic(), from('item', ['v14', 'v17', 'v21', 'v30', 'v50'], 0), { maxReachedNodes: 2 });
    expect(refs(out)).toEqual(['i:v14', 'i:v17']);
    expect(out).toMatchObject({ truncated: true });
  });

  it('does not read a huge hub to the end: 5,000 items, cap 100, only a few pages of edges read', async () => {
    const real = createMemoryAdapter();
    await real.graphs.create('g');
    const ids = Array.from({ length: 5000 }, (_, i) => `i${String(i).padStart(4, '0')}`);
    await real.transaction('g', async (tx) => {
      await tx.putNodes([category('hub'), ...ids.map((id) => item(id))]);
      await tx.putEdges(ids.map((id) => edge(id, 'hub')));
    });
    let edgePageReads = 0;
    const counting: StorageAdapter = {
      ...real,
      transaction: (graphId, fn) => real.transaction(graphId, (tx) => fn({ ...tx, edgesOf: (p, id, page) => (edgePageReads++, tx.edgesOf(p, id, page)) } as AdapterTx)),
    };
    const out = await value(counting, { ...from('category', ['hub'], 2), return: { shape: 'count' } }, { maxReachedNodes: 100 });
    expect(out).toEqual({ count: 100, truncated: true });
    expect(edgePageReads).toBeLessThanOrEqual(2);
  });

  it('walks a large but under-cap graph in reasonable time (2,000 items, 2 hops)', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    const ids = Array.from({ length: 2000 }, (_, i) => `i${String(i).padStart(4, '0')}`);
    await adapter.transaction('g', async (tx) => {
      await tx.putNodes([category('hub'), ...Array.from({ length: 20 }, (_, i) => category(`c${i}`)), ...ids.map((id) => item(id))]);
      await tx.putEdges([...ids.map((id) => edge(id, 'hub')), ...ids.map((id, i) => edge(id, `c${i % 20}`))]);
    });
    const started = Date.now();
    const out = await value(adapter, { ...from('category', ['hub'], 2), return: { shape: 'count' } });
    expect(out).toEqual({ count: 2021, truncated: false });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('failures and read-only', () => {
  it('a graph that is missing is GRAPH_NOT_FOUND', async () => {
    expect(await run(await clinic(), { ...from('category', ['doctor-x'], 1), graphId: 'nope' })).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND' } });
  });

  it('stops with STORAGE_ERROR when an edge listing never advances', async () => {
    const real = await clinic();
    const stuck: StorageAdapter = {
      ...real,
      transaction: (graphId, fn) =>
        real.transaction(graphId, (tx) =>
          fn({ ...tx, edgesOf: async (p: 'item' | 'category', id: string) => ({ items: (await tx.edgesOf(p, id, { limit: 1, cursor: null })).items, nextCursor: 'same' }) } as AdapterTx),
        ),
    };
    expect(await run(stuck, from('category', ['doctor-x'], 1))).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR', message: expect.stringContaining('did not advance') } });
  });

  it('traversal never writes: it works on an adapter whose write primitives throw', async () => {
    const real = await clinic();
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
    for (const depth of [0, 1, 2, 3]) expect((await run(noWrites, from('category', ['doctor-x'], depth))).ok).toBe(true);
  });
});
