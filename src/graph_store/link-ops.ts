import type { AdapterTx, EdgeRecord, NodeRecord } from './adapter.js';
import { err, graphError, ok, type Result } from './result.js';
import type { Op } from './types.js';

export type LinkOp = Extract<Op, { op: 'link' }>;
export type UnlinkOp = Extract<Op, { op: 'unlink' }>;

/**
 * Functional core: the edge a `link` op stores. The edge is replaced whole, so linking again
 * is idempotent and the latest weight and data win (AC-06). Pure.
 */
export function planLink(op: LinkOp): EdgeRecord {
  return {
    item: op.item,
    category: op.category,
    ...(op.weight === undefined ? {} : { weight: op.weight }),
    ...(op.data === undefined ? {} : { data: op.data }),
  };
}

/**
 * Functional core: which endpoint nodes must be created for the link to be valid.
 * A missing endpoint is `NODE_NOT_FOUND` unless `ensureNodes` is set (the item is reported
 * first). Error paths are relative to the op; the caller prefixes the op's position. Pure.
 */
export function planLinkEndpoints(
  op: Pick<LinkOp, 'item' | 'category' | 'ensureNodes'>,
  itemExists: boolean,
  categoryExists: boolean,
): Result<NodeRecord[]> {
  const missing: NodeRecord[] = [
    ...(itemExists ? [] : [{ partition: 'item' as const, id: op.item }]),
    ...(categoryExists ? [] : [{ partition: 'category' as const, id: op.category }]),
  ];
  if (op.ensureNodes) return ok(missing);
  const first = missing[0];
  if (first === undefined) return ok([]);
  return err(
    graphError(
      'NODE_NOT_FOUND',
      `${first.partition} "${first.id}" does not exist; create it first or set ensureNodes: true`,
      [first.partition],
    ),
  );
}

/**
 * Imperative shell: applies a `link` op inside a transaction. Nothing is written when an
 * endpoint is missing and `ensureNodes` is off.
 */
export async function applyLink(tx: AdapterTx, op: LinkOp): Promise<Result<undefined>> {
  const [item] = await tx.getNodes('item', [op.item]);
  const [category] = await tx.getNodes('category', [op.category]);
  const endpoints = planLinkEndpoints(op, item !== undefined, category !== undefined);
  if (!endpoints.ok) return endpoints;
  if (endpoints.value.length > 0) await tx.putNodes(endpoints.value);
  await tx.putEdges([planLink(op)]);
  return ok(undefined);
}

/** Imperative shell: applies an `unlink` op. Removing an edge that does not exist is a no-op. */
export async function applyUnlink(tx: AdapterTx, op: UnlinkOp): Promise<void> {
  await tx.deleteEdges([{ item: op.item, category: op.category }]);
}
