import type { AdapterTx, GraphId, NodeRecord, Partition, StorageAdapter } from '../../adapter.js';
import { compareKeys, paginate } from './paging.js';

interface GraphData {
  readonly items: Map<string, NodeRecord>;
  readonly categories: Map<string, NodeRecord>;
}

const emptyGraph = (): GraphData => ({ items: new Map(), categories: new Map() });

/** Shallow copy: stored records are never mutated in place, so sharing them between copies is safe. */
const copyGraph = (g: GraphData): GraphData => ({ items: new Map(g.items), categories: new Map(g.categories) });

/** Stored and returned records are deep copies so callers can never alias adapter state. */
function cloneNode(node: NodeRecord): NodeRecord {
  return node.data === undefined
    ? { partition: node.partition, id: node.id }
    : { partition: node.partition, id: node.id, data: structuredClone(node.data) };
}

const partitionOf = (g: GraphData, p: Partition): Map<string, NodeRecord> =>
  p === 'item' ? g.items : g.categories;

const edgesNotReady = (): never => {
  throw new Error('Memory adapter edges are not implemented yet (T-015)');
};

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

    putEdges: async () => edgesNotReady(),
    deleteEdges: async () => edgesNotReady(),
    edgesOf: async () => edgesNotReady(),
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
