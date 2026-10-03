import type { AdapterTx, StorageAdapter } from '../graph_store/index.js';

const WRITES = ['putNodes', 'deleteNodes', 'putEdges', 'deleteEdges'] as const;

export interface RecordingAdapter {
  readonly adapter: StorageAdapter;
  /** Every write primitive that was called, in order (`putNodes`, `graphs.create`, ...). Reads are not listed. */
  readonly writes: string[];
  /** Every call of any kind, in order. */
  readonly calls: string[];
}

/** Wraps an adapter and records what is called on it, so a test can prove that nothing was written. */
export function recordAdapter(inner: StorageAdapter): RecordingAdapter {
  const writes: string[] = [];
  const calls: string[] = [];
  const note = (name: string): void => {
    calls.push(name);
    if ((WRITES as readonly string[]).includes(name) || name === 'graphs.create' || name === 'graphs.drop') writes.push(name);
  };
  const wrapTx = (tx: AdapterTx): AdapterTx => ({
    getNodes: (p, ids) => (note('getNodes'), tx.getNodes(p, ids)),
    putNodes: (nodes) => (note('putNodes'), tx.putNodes(nodes)),
    deleteNodes: (p, ids) => (note('deleteNodes'), tx.deleteNodes(p, ids)),
    putEdges: (edges) => (note('putEdges'), tx.putEdges(edges)),
    deleteEdges: (keys) => (note('deleteEdges'), tx.deleteEdges(keys)),
    edgesOf: (p, id, page) => (note('edgesOf'), tx.edgesOf(p, id, page)),
    listNodes: (p, page) => (note('listNodes'), tx.listNodes(p, page)),
    ...(tx.itemsByCategories === undefined ? {} : { itemsByCategories: (clause, page) => (note('itemsByCategories'), tx.itemsByCategories?.(clause, page) as never) }),
  });
  const adapter: StorageAdapter = {
    name: `recording(${inner.name})`,
    capabilities: inner.capabilities,
    transaction: (graphId, fn) => (note('transaction'), inner.transaction(graphId, (tx) => fn(wrapTx(tx)))),
    graphs: {
      create: (id) => (note('graphs.create'), inner.graphs.create(id)),
      exists: (id) => (note('graphs.exists'), inner.graphs.exists(id)),
      list: (page) => (note('graphs.list'), inner.graphs.list(page)),
      drop: (id) => (note('graphs.drop'), inner.graphs.drop(id)),
    },
  };
  return { adapter, writes, calls };
}
