import type { NodeRef } from './types.js';

/**
 * Every query result lists nodes in one fixed order: all items first, then all categories, and
 * within each partition by id in UTF-16 code-unit order (the order the adapters list in). One
 * order means one cursor can page any result, and the same query gives the same answer.
 */
const PARTITION_RANK = { item: 0, category: 1 } as const;

export function compareNodeRefs(a: NodeRef, b: NodeRef): number {
  const byPartition = PARTITION_RANK[a.partition] - PARTITION_RANK[b.partition];
  if (byPartition !== 0) return byPartition;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** True when `node` comes strictly after `position` in the result order (what a keyset cursor means). */
export function isAfter(node: NodeRef, position: NodeRef): boolean {
  return compareNodeRefs(node, position) > 0;
}

/** Returns a sorted copy; the input is not changed. */
export function sortNodeRefs<T extends NodeRef>(nodes: readonly T[]): T[] {
  return [...nodes].sort(compareNodeRefs);
}
