import type { AdapterTx, EdgeKey, EdgeRecord, GraphId, NodeRecord, Partition, StorageAdapter } from '../../adapter.js';
import { compareKeys, paginate } from './paging.js';

/** other-end id -> edge, for one node. */
type EdgeIndex = Map<string, Map<string, EdgeRecord>>;

interface GraphData {
  readonly items: Map<string, NodeRecord>;
  readonly categories: Map<string, NodeRecord>;
  /** item id -> (category id -> edge). */
  readonly edgesByItem: EdgeIndex;
  /** category id -> (item id -> edge). Holds the same records as `edgesByItem`. */
  readonly edgesByCategory: EdgeIndex;
}

const emptyGraph = (): GraphData => ({
  items: new Map(),
  categories: new Map(),
  edgesByItem: new Map(),
  edgesByCategory: new Map(),
});

const copyIndex = (index: EdgeIndex): EdgeIndex =>
  new Map([...index].map(([node, edges]) => [node, new Map(edges)]));

/**
 * Copy for a transaction. Stored records are never mutated in place, so they are shared;
 * the maps themselves (including the per-node edge maps) are copied because they are mutated.
 */
const copyGraph = (g: GraphData): GraphData => ({
  items: new Map(g.items),
  categories: new Map(g.categories),
  edgesByItem: copyIndex(g.edgesByItem),
  edgesByCategory: copyIndex(g.edgesByCategory),
});

/** Stored and returned records are deep copies so callers can never alias adapter state. */
function cloneNode(node: NodeRecord): NodeRecord {
  return node.data === undefined
    ? { partition: node.partition, id: node.id }
    : { partition: node.partition, id: node.id, data: structuredClone(node.data) };
}

function cloneEdge(edge: EdgeRecord): EdgeRecord {
  return {
    item: edge.item,
    category: edge.category,
    ...(edge.weight === undefined ? {} : { weight: edge.weight }),
    ...(edge.data === undefined ? {} : { data: structuredClone(edge.data) }),
  };
}

function addToIndex(index: EdgeIndex, node: string, other: string, edge: EdgeRecord): void {
  const edges = index.get(node) ?? new Map<string, EdgeRecord>();
  edges.set(other, edge);
  index.set(node, edges);
}

function removeFromIndex(index: EdgeIndex, node: string, other: string): void {
  const edges = index.get(node);
  if (edges === undefined) return;
  edges.delete(other);
  if (edges.size === 0) index.delete(node);
}

const partitionOf = (g: GraphData, p: Partition): Map<string, NodeRecord> =>
  p === 'item' ? g.items : g.categories;

function makeTx(graph: GraphData, isOpen: () => boolean): AdapterTx {
  const live = <T>(body: () => T): T => {
    if (!isOpen()) throw new Error('Transaction is closed');
    return body();
  };

  return {
    getNodes: async (p, ids) =>
      live(() => {
        const nodes = partitionOf(graph, p);
        return ids.flatMap((id) => {
          const found = nodes.get(id);
          return found === undefined ? [] : [cloneNode(found)];
        });
      }),

    putNodes: async (nodes) =>
      live(() => {
        for (const node of nodes) partitionOf(graph, node.partition).set(node.id, cloneNode(node));
      }),

    deleteNodes: async (p, ids) =>
      live(() => {
        const nodes = partitionOf(graph, p);
        for (const id of ids) nodes.delete(id);
      }),

    listNodes: async (p, page) =>
      live(() => {
        const sorted = [...partitionOf(graph, p).values()].sort((a, b) => compareKeys(a.id, b.id));
        const result = paginate(sorted, (n) => n.id, page);
        return { items: result.items.map(cloneNode), nextCursor: result.nextCursor };
      }),

    // Raw primitives: no endpoint checks and no cascade. The core enforces the bipartite rules.
    putEdges: async (edges: EdgeRecord[]) =>
      live(() => {
        for (const edge of edges) {
          const stored = cloneEdge(edge);
          addToIndex(graph.edgesByItem, edge.item, edge.category, stored);
          addToIndex(graph.edgesByCategory, edge.category, edge.item, stored);
        }
      }),

    deleteEdges: async (keys: EdgeKey[]) =>
      live(() => {
        for (const { item, category } of keys) {
          removeFromIndex(graph.edgesByItem, item, category);
          removeFromIndex(graph.edgesByCategory, category, item);
        }
      }),

    edgesOf: async (p, id, page) =>
      live(() => {
        const byOtherEnd = (p === 'item' ? graph.edgesByItem : graph.edgesByCategory).get(id);
        const otherEnd = (e: EdgeRecord): string => (p === 'item' ? e.category : e.item);
        const sorted = [...(byOtherEnd?.values() ?? [])].sort((a, b) => compareKeys(otherEnd(a), otherEnd(b)));
        const result = paginate(sorted, otherEnd, page);
        return { items: result.items.map(cloneEdge), nextCursor: result.nextCursor };
      }),
  };
}

/**
 * Reference adapter: in-memory, copy-on-write. A transaction works on a copy of one graph and
 * swaps it in on success; if the callback throws, the copy is discarded and nothing changes.
 * All state lives in this closure, so instances share nothing.
 */
export function createMemoryAdapter(): StorageAdapter {
  const graphs = new Map<GraphId, GraphData>();
  const queues = new Map<GraphId, Promise<void>>();

  /** Runs `body` with exclusive access to a graph, so concurrent transactions cannot lose updates. */
  async function exclusive<T>(graphId: GraphId, body: () => Promise<T>): Promise<T> {
    const previous = queues.get(graphId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    queues.set(graphId, tail);
    await previous;
    try {
      return await body();
    } finally {
      release();
      if (queues.get(graphId) === tail) queues.delete(graphId);
    }
  }

  return {
    name: 'memory',
    capabilities: { transactions: true, idempotency: false, nativeSetQueries: false },

    transaction: (graphId, fn) =>
      exclusive(graphId, async () => {
        const current = graphs.get(graphId);
        if (current === undefined) throw new Error(`Graph not found: ${graphId}`);
        const working = copyGraph(current);
        let open = true;
        try {
          const result = await fn(makeTx(working, () => open));
          graphs.set(graphId, working);
          return result;
        } finally {
          open = false;
        }
      }),

    graphs: {
      /** Idempotent: creating an existing graph leaves it untouched. */
      create: (id) =>
        exclusive(id, async () => {
          if (!graphs.has(id)) graphs.set(id, emptyGraph());
        }),
      exists: async (id) => graphs.has(id),
      list: async (page) => paginate([...graphs.keys()].sort(compareKeys), (id) => id, page),
      /** Idempotent: dropping a missing graph is a no-op. */
      drop: (id) =>
        exclusive(id, async () => {
          graphs.delete(id);
        }),
    },
  };
}
