import type { AdapterTx, EdgeKey, EdgeRecord, JsonObject, NodeRecord } from './adapter.js';
import type { Op } from './types.js';

export type UpsertNodeOp = Extract<Op, { op: 'upsertNode' }>;
export type DeleteNodeOp = Extract<Op, { op: 'deleteNode' }>;

/** Edges are fetched and removed in pages of the maximum allowed size, so memory stays bounded. */
const EDGE_PAGE_SIZE = 1000;

/**
 * Functional core: the node record an upsert should store.
 * - `replace`: the node's data becomes exactly `op.data` (absent means no data).
 * - `merge`: shallow merge; keys in `op.data` win, other existing keys are kept.
 * Pure: neither argument is modified.
 */
export function planUpsertNode(op: UpsertNodeOp, existing: NodeRecord | undefined): NodeRecord {
  const data: JsonObject | undefined =
    op.mode === 'merge' && existing?.data !== undefined
      ? { ...existing.data, ...op.data }
      : op.data;
  return data === undefined
    ? { partition: op.partition, id: op.id }
    : { partition: op.partition, id: op.id, data };
}

/** Functional core: the edge keys to remove so that deleting a node leaves no dangling edges. */
export function planCascade(edges: readonly EdgeRecord[]): EdgeKey[] {
  return edges.map(({ item, category }) => ({ item, category }));
}

/** Imperative shell: applies an `upsertNode` op inside a transaction. */
export async function applyUpsertNode(tx: AdapterTx, op: UpsertNodeOp): Promise<void> {
  const [existing] = await tx.getNodes(op.partition, [op.id]);
  await tx.putNodes([planUpsertNode(op, existing)]);
}

/**
 * Imperative shell: applies a `deleteNode` op inside a transaction. Removes the node's edges
 * first, then the node (FR-07). Deleting a node that does not exist is a no-op.
 */
export async function applyDeleteNode(tx: AdapterTx, op: DeleteNodeOp): Promise<void> {
  let cursor: string | null = null;
  do {
    const page = await tx.edgesOf(op.partition, op.id, { limit: EDGE_PAGE_SIZE, cursor });
    await tx.deleteEdges(planCascade(page.items));
    // Keyset cursors stay valid after the rows before them are deleted.
    cursor = page.nextCursor;
  } while (cursor !== null);
  await tx.deleteNodes(op.partition, [op.id]);
}
