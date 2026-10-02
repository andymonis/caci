import type { AdapterTx, NodeRecord, Partition, StorageAdapter } from './adapter.js';
import { DEFAULT_LIMITS } from './limits.js';
import { encodeQueryCursor } from './query-cursor.js';
import { isAfter, sortNodeRefs } from './query-order.js';
import type { QueryPlan } from './query-plan.js';
import { err, graphError, ok, type Result } from './result.js';
import type { NodeRef, QueryNode, QueryOutput } from './types.js';
import { storageError } from './write-plan.js';

/**
 * The only part of a transaction a query may touch. It has no write methods, so a query cannot
 * change the store (FR-21, AC-22), and `readOnly` builds it fresh so even a cast cannot reach them.
 */
export type ReadTx = Pick<AdapterTx, 'getNodes' | 'listNodes' | 'edgesOf'>;

export function readOnly(tx: AdapterTx): ReadTx {
  return Object.freeze({
    getNodes: (p, ids) => tx.getNodes(p, ids),
    listNodes: (p, page) => tx.listNodes(p, page),
    edgesOf: (p, id, page) => tx.edgesOf(p, id, page),
  });
}

/** Rows asked of the adapter at a time. */
const READ_PAGE = 1000;

const notYet = (feature: string, path: (string | number)[]) =>
  err(graphError('VALIDATION_ERROR', `${feature} is not supported yet`, path));

/** Walks a partition page by page, failing loudly if the adapter's cursor does not advance. */
async function* pagesOf(tx: ReadTx, partition: Partition): AsyncGenerator<readonly NodeRecord[]> {
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<ReadTx['listNodes']>> = await tx.listNodes(partition, { limit: READ_PAGE, cursor });
    yield page.items;
    if (page.nextCursor !== null && page.nextCursor === cursor) {
      throw new Error(`the adapter's paging cursor did not advance while listing ${partition} nodes`);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
}

const partitionsOf = (plan: QueryPlan): Partition[] => (plan.partition === undefined ? ['item', 'category'] : [plan.partition]);

/** The first `want` nodes after the plan's position, and whether any more follow. */
async function firstNodes(tx: ReadTx, plan: QueryPlan, want: number): Promise<{ nodes: NodeRecord[]; more: boolean }> {
  const nodes: NodeRecord[] = [];
  for (const partition of partitionsOf(plan)) {
    for await (const items of pagesOf(tx, partition)) {
      const last = items.at(-1);
      if (plan.after !== null && last !== undefined && !isAfter(last, plan.after)) continue; // whole page is before the cursor
      for (const node of items) {
        if (plan.after !== null && !isAfter(node, plan.after)) continue;
        if (nodes.length === want) return { nodes, more: true };
        nodes.push(node);
      }
    }
  }
  return { nodes, more: false };
}

/** How many nodes match, counting no further than `cap`. */
async function countNodes(tx: ReadTx, plan: QueryPlan, cap: number): Promise<{ count: number; truncated: boolean }> {
  let count = 0;
  for (const partition of partitionsOf(plan)) {
    for await (const items of pagesOf(tx, partition)) {
      count += items.length;
      if (count > cap) return { count: cap, truncated: true };
    }
  }
  return { count, truncated: false };
}

/** Named seeds that exist, in result order. Missing ids are ignored. */
async function seedNodes(tx: ReadTx, seeds: { partition: Partition; ids: string[] }): Promise<NodeRecord[]> {
  const found: NodeRecord[] = [];
  for (let i = 0; i < seeds.ids.length; i += READ_PAGE) {
    found.push(...(await tx.getNodes(seeds.partition, seeds.ids.slice(i, i + READ_PAGE))));
  }
  return sortNodeRefs(found);
}

const toNode = (node: NodeRecord, includeData: boolean): QueryNode =>
  includeData && node.data !== undefined ? { partition: node.partition, id: node.id, data: node.data } : { partition: node.partition, id: node.id };

const toRef = (node: NodeRecord): NodeRef => ({ partition: node.partition, id: node.id });

function shapeNodes(plan: QueryPlan, nodes: NodeRecord[], more: boolean, truncated: boolean): QueryOutput {
  const last = nodes.at(-1);
  const nextCursor = more && last !== undefined ? encodeQueryCursor(plan.fingerprint, toRef(last)) : null;
  return plan.shape === 'ids'
    ? { ids: nodes.map(toRef), nextCursor, truncated }
    : { nodes: nodes.map((n) => toNode(n, plan.includeData)), nextCursor, truncated };
}

/**
 * Functional core of `query`, for seeds without traversal: reads through a read-only handle and
 * shapes the answer. Parts not built yet (walking edges, the `subgraph` shape) are refused by name.
 */
export async function executePlan(tx: ReadTx, plan: QueryPlan, maxReachedNodes: number): Promise<Result<QueryOutput>> {
  if (plan.depth > 0) return notYet('traversal (depth above 0)', ['traverse', 'depth']);
  if (plan.shape === 'subgraph') return notYet('the subgraph shape', ['return', 'shape']);

  if (plan.seeds.kind === 'all') {
    if (plan.excludeSeeds) return ok(plan.shape === 'count' ? { count: 0, truncated: false } : shapeNodes(plan, [], false, false));
    if (plan.shape === 'count') return ok(await countNodes(tx, plan, maxReachedNodes));
    const { nodes, more } = await firstNodes(tx, plan, plan.limit);
    return ok(shapeNodes(plan, nodes, more, false));
  }

  // Named seeds at depth 0: the result is the seeds that exist, narrowed by the partition filter.
  const { partition, ids } = plan.seeds;
  const excluded = plan.excludeSeeds || (plan.partition !== undefined && plan.partition !== partition);
  const found = excluded ? [] : await seedNodes(tx, { partition, ids });
  const reached = found.slice(0, maxReachedNodes);
  const truncated = found.length > reached.length;
  if (plan.shape === 'count') return ok({ count: reached.length, truncated });
  const remaining = reached.filter((n) => plan.after === null || isAfter(n, plan.after));
  return ok(shapeNodes(plan, remaining.slice(0, plan.limit), remaining.length > plan.limit, truncated));
}

/**
 * Imperative shell: checks the graph exists, runs the plan inside one transaction through a
 * read-only handle, and turns any adapter failure into a result. Never throws.
 */
export async function executeQuery(
  adapter: StorageAdapter,
  plan: QueryPlan,
  limits: { maxReachedNodes: number } = DEFAULT_LIMITS,
): Promise<Result<QueryOutput>> {
  try {
    if (!(await adapter.graphs.exists(plan.graphId))) {
      return err(graphError('GRAPH_NOT_FOUND', `Graph "${plan.graphId}" does not exist`, ['graphId']));
    }
    return await adapter.transaction(plan.graphId, (tx) => executePlan(readOnly(tx), plan, limits.maxReachedNodes));
  } catch (cause) {
    return err(storageError(cause));
  }
}
