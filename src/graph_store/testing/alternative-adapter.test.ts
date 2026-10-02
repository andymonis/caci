import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../adapters/memory/index.js';
import type { AdapterTx, EdgeRecord, NodeRecord, Page, Paged, StorageAdapter } from '../adapter.js';
import { createGraphClient } from '../endpoints.js';
import { runAdapterConformance } from './index.js';

/**
 * AC-15: "a new adapter that passes runAdapterConformance needs no core changes to work end to end".
 *
 * This is such an adapter. It is deliberately unlike the memory adapter: transactions work by
 * snapshotting the whole graph and restoring it on failure (not copy-on-write maps), edges live in
 * one flat map filtered on demand (not two indexes), and cursors have their own format. It imports
 * nothing from the memory adapter, and the core was not touched to make it work.
 *
 * It serialises transactions with a per-graph promise chain (not the memory adapter's queue), which
 * the conformance suite requires. It is a test fixture, not a real backend.
 */
interface Store {
  nodes: Map<string, NodeRecord>;
  edges: Map<string, EdgeRecord>;
}

const nodeKey = (partition: string, id: string): string => `${partition}\u0000${id}`;
const edgeKey = (item: string, category: string): string => `${item}\u0000${category}`;

function cloneStore(store: Store): Store {
  return { nodes: structuredClone(store.nodes), edges: structuredClone(store.edges) };
}

/** Keyset paging with this adapter's own cursor format: "after:<last key>". */
function paged<T>(rows: T[], keyOf: (row: T) => string, page: Page): Paged<T> {
  const sorted = [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const after = page.cursor === null ? null : page.cursor.slice('after:'.length);
  const rest = after === null ? sorted : sorted.filter((row) => keyOf(row) > after);
  const items = rest.slice(0, page.limit);
  const last = items.at(-1);
  return { items, nextCursor: rest.length > page.limit && last !== undefined ? `after:${keyOf(last)}` : null };
}

function makeTx(store: Store): AdapterTx {
  return {
    getNodes: async (p, ids) =>
      ids.flatMap((id) => {
        const node = store.nodes.get(nodeKey(p, id));
        return node === undefined ? [] : [structuredClone(node)];
      }),
    putNodes: async (nodes) => void nodes.forEach((n) => store.nodes.set(nodeKey(n.partition, n.id), structuredClone(n))),
    deleteNodes: async (p, ids) => void ids.forEach((id) => store.nodes.delete(nodeKey(p, id))),
    putEdges: async (edges) => void edges.forEach((e) => store.edges.set(edgeKey(e.item, e.category), structuredClone(e))),
    deleteEdges: async (keys) => void keys.forEach((k) => store.edges.delete(edgeKey(k.item, k.category))),
    edgesOf: async (p, id, page) => {
      const mine = [...store.edges.values()].filter((e) => (p === 'item' ? e.item === id : e.category === id));
      const result = paged(mine, (e) => (p === 'item' ? e.category : e.item), page);
      return { items: structuredClone(result.items), nextCursor: result.nextCursor };
    },
    listNodes: async (p, page) => {
      const result = paged([...store.nodes.values()].filter((n) => n.partition === p), (n) => n.id, page);
      return { items: structuredClone(result.items), nextCursor: result.nextCursor };
    },
  };
}

function createSnapshotAdapter(): StorageAdapter {
  const graphs = new Map<string, Store>();
  const tails = new Map<string, Promise<unknown>>(); // per graph: the last queued transaction

  /** Runs `job` after every earlier job on this graph has finished, whether it succeeded or not. */
  const inTurn = <T>(graphId: string, job: () => Promise<T>): Promise<T> => {
    const run = (tails.get(graphId) ?? Promise.resolve()).then(job, job);
    tails.set(graphId, run.catch(() => undefined));
    return run;
  };

  return {
    name: 'snapshot-fixture',
    capabilities: { transactions: true, idempotency: false, nativeSetQueries: false },
    transaction: (graphId, fn) =>
      inTurn(graphId, async () => {
        const current = graphs.get(graphId);
        if (current === undefined) throw new Error(`no such graph: ${graphId}`);
        const working = cloneStore(current); // snapshot; dropped if fn throws
        const result = await fn(makeTx(working));
        graphs.set(graphId, working);
        return result;
      }),
    graphs: {
      create: async (id) => void (graphs.has(id) || graphs.set(id, { nodes: new Map(), edges: new Map() })),
      exists: async (id) => graphs.has(id),
      list: async (page) => paged([...graphs.keys()], (id) => id, page),
      drop: async (id) => void graphs.delete(id),
    },
  };
}

// 1. It passes the same conformance suite as the memory adapter, with no changes to the suite or the core.
runAdapterConformance(() => createSnapshotAdapter(), { describe, it });

// 2. And it works end to end through the public client.
describe('an independent adapter works end to end (AC-15)', () => {
  it('runs the lifecycle and a mutation through the client', async () => {
    const client = createGraphClient(createSnapshotAdapter());
    expect(await client.createGraph('user_42')).toEqual({ ok: true, value: { graphId: 'user_42' } });
    const written = await client.write({
      version: 1,
      kind: 'mutation',
      graphId: 'user_42',
      ops: [
        { op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 'Q3 plan' } },
        { op: 'upsertNode', partition: 'category', id: 'planning' },
        { op: 'link', item: 'note-1', category: 'planning', weight: 0.8 },
      ],
    });
    expect(written).toEqual({ ok: true, value: { graphId: 'user_42', applied: 3, graphCreated: false } });
    expect(await client.describeGraph('user_42')).toEqual({
      ok: true,
      value: { graphId: 'user_42', itemCount: 1, categoryCount: 1, edgeCount: 1 },
    });
    expect(await client.dropGraph('user_42')).toEqual({ ok: true, value: { graphId: 'user_42' } });
    expect(await client.listGraphs()).toEqual({ ok: true, value: { items: [], nextCursor: null } });
  });

  it('rolls a failed mutation back through its own snapshot mechanism', async () => {
    const client = createGraphClient(createSnapshotAdapter());
    await client.createGraph('g');
    await client.write({ version: 1, kind: 'mutation', graphId: 'g', ops: [{ op: 'upsertNode', partition: 'item', id: 'keep' }] });
    const failed = await client.write({
      version: 1,
      kind: 'mutation',
      graphId: 'g',
      ops: [
        { op: 'upsertNode', partition: 'item', id: 'lost' },
        { op: 'link', item: 'keep', category: 'missing' },
      ],
    });
    expect(failed).toMatchObject({ ok: false, error: { code: 'NODE_NOT_FOUND', path: ['ops', 1, 'category'] } });
    expect(await client.describeGraph('g')).toMatchObject({ ok: true, value: { itemCount: 1 } });
  });

  it('can sit beside the memory adapter in one process without either seeing the other (AC-12)', async () => {
    const memory = createGraphClient(createMemoryAdapter());
    const fixture = createGraphClient(createSnapshotAdapter());
    await memory.createGraph('shared-name');
    await memory.createGraph('only-in-memory');
    expect(await fixture.listGraphs()).toEqual({ ok: true, value: { items: [], nextCursor: null } });
    expect((await fixture.createGraph('shared-name')).ok).toBe(true);
    expect(await fixture.describeGraph('only-in-memory')).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND' } });
    expect(await memory.listGraphs()).toEqual({ ok: true, value: { items: ['only-in-memory', 'shared-name'], nextCursor: null } });
  });
});
