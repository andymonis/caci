import type { AdapterTx, EdgeRecord, NodeRecord, Partition, StorageAdapter } from './adapter.js';
import { DEFAULT_LIMITS } from './limits.js';
import { READ_PAGE, walkPages } from './paging.js';
import { encodeQueryCursor } from './query-cursor.js';
import { isAfter, sortNodeRefs } from './query-order.js';
import type { QueryPlan } from './query-plan.js';
import { err, graphError, ok, type Result } from './result.js';
import type { NodeRef, QueryEdge, QueryNode, QueryOutput } from './types.js';
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

const pages = walkPages; // fails loudly, rather than looping for ever, if the adapter's cursor does not advance

const pagesOf = (tx: ReadTx, partition: Partition) => pages((page) => tx.listNodes(partition, page), `${partition} nodes`);

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

const keyOf = (partition: Partition, id: string): string => `${partition}:${id}`;
const otherPartition = (p: Partition): Partition => (p === 'item' ? 'category' : 'item');

/**
 * Walks the graph breadth first from the named seeds, `depth` hops out. Each hop crosses to the
 * other partition (item to category, category to item). Everything within `depth` hops is reached,
 * once: a visited set means a node reached by two paths counts once and a cycle cannot loop.
 * Seeds that do not exist are ignored. Work is bounded by `cap`: when it would be exceeded, the walk
 * stops (including partway through a node's edges) and the result is marked truncated.
 */
async function reachNodes(
  tx: ReadTx,
  seeds: { partition: Partition; ids: string[] },
  depth: number,
  cap: number,
): Promise<{ nodes: NodeRecord[]; seedKeys: Set<string>; truncated: boolean }> {
  const reached = new Map<string, NodeRecord>();
  let truncated = false;
  for (const seed of await seedNodes(tx, seeds)) {
    if (reached.size >= cap) {
      truncated = true;
      break;
    }
    reached.set(keyOf(seed.partition, seed.id), seed);
  }
  const seedKeys = new Set(reached.keys());

  let frontier = [...reached.values()];
  for (let hop = 1; hop <= depth && frontier.length > 0 && !truncated; hop++) {
    const first = frontier[0];
    if (first === undefined) break;
    const to = otherPartition(first.partition); // every node in a ring is in the same partition
    const room = cap - reached.size;
    const discovered = new Set<string>();

    search: for (const node of frontier) {
      for await (const edges of pages((page) => tx.edgesOf(node.partition, node.id, page), `edges of ${node.partition} "${node.id}"`)) {
        for (const edge of edges) {
          const id = node.partition === 'item' ? edge.category : edge.item;
          if (reached.has(keyOf(to, id)) || discovered.has(id)) continue;
          if (discovered.size >= room) {
            truncated = true;
            break search;
          }
          discovered.add(id);
        }
      }
    }

    const next: NodeRecord[] = [];
    const ids = [...discovered];
    for (let i = 0; i < ids.length; i += READ_PAGE) next.push(...(await tx.getNodes(to, ids.slice(i, i + READ_PAGE))));
    frontier = sortNodeRefs(next); // an edge to a node that is gone is skipped
    for (const node of frontier) reached.set(keyOf(node.partition, node.id), node);
  }
  return { nodes: [...reached.values()], seedKeys, truncated };
}

const toNode = (node: NodeRecord, includeData: boolean): QueryNode =>
  includeData && node.data !== undefined ? { partition: node.partition, id: node.id, data: node.data } : { partition: node.partition, id: node.id };

const toRef = (node: NodeRecord): NodeRef => ({ partition: node.partition, id: node.id });

/** An edge as results report it: a missing weight reads as 1, and `data` only when asked for. */
const toEdge = (edge: EdgeRecord, includeData: boolean): QueryEdge => ({
  item: edge.item,
  category: edge.category,
  weight: edge.weight ?? 1,
  ...(includeData && edge.data !== undefined ? { data: edge.data } : {}),
});

/** Tells which of these category ids are part of the whole result. */
type InResult = (categoryIds: string[]) => Promise<Set<string>>;

/**
 * The edges that travel with a page of a `subgraph` result: those of the page's items whose
 * category end is also somewhere in the whole result. Because an edge goes with its item, every
 * edge appears exactly once across all pages. At most `cap` edges are returned per page.
 */
async function edgesForPage(
  tx: ReadTx,
  pageNodes: readonly NodeRecord[],
  inResult: InResult,
  includeData: boolean,
  cap: number,
): Promise<{ edges: QueryEdge[]; truncated: boolean }> {
  const edges: QueryEdge[] = [];
  for (const node of pageNodes) {
    if (node.partition !== 'item') continue;
    for await (const batch of pages((page) => tx.edgesOf('item', node.id, page), `edges of item "${node.id}"`)) {
      const present = await inResult([...new Set(batch.map((e) => e.category))]);
      for (const edge of batch) {
        if (!present.has(edge.category)) continue;
        if (edges.length >= cap) return { edges, truncated: true };
        edges.push(toEdge(edge, includeData));
      }
    }
  }
  return { edges, truncated: false };
}

async function shapeNodes(
  tx: ReadTx,
  plan: QueryPlan,
  nodes: NodeRecord[],
  more: boolean,
  truncated: boolean,
  inResult: InResult,
  cap: number,
): Promise<QueryOutput> {
  const last = nodes.at(-1);
  const nextCursor = more && last !== undefined ? encodeQueryCursor(plan.fingerprint, toRef(last)) : null;
  if (plan.shape === 'ids') return { ids: nodes.map(toRef), nextCursor, truncated };
  const shown = nodes.map((n) => toNode(n, plan.includeData));
  if (plan.shape !== 'subgraph') return { nodes: shown, nextCursor, truncated };
  const gathered = await edgesForPage(tx, nodes, inResult, plan.includeData, cap);
  return { nodes: shown, edges: gathered.edges, nextCursor, truncated: truncated || gathered.truncated };
}

const nobody: InResult = async () => new Set();

/**
 * Functional core of `query`: reads through a read-only handle and shapes the answer: seeds,
 * traversal, the partition filter, and the nodes, ids, count and subgraph shapes.
 */
export async function executePlan(tx: ReadTx, plan: QueryPlan, maxReachedNodes: number): Promise<Result<QueryOutput>> {
  if (plan.seeds.kind === 'all') {
    if (plan.excludeSeeds) {
      return ok(plan.shape === 'count' ? { count: 0, truncated: false } : await shapeNodes(tx, plan, [], false, false, nobody, maxReachedNodes));
    }
    if (plan.shape === 'count') return ok(await countNodes(tx, plan, maxReachedNodes));
    const { nodes, more } = await firstNodes(tx, plan, plan.limit);
    // The whole graph is the result, so a category end is in it exactly when that category exists.
    // With a partition filter only one kind of node is in the result, so there are no edges.
    const existing: InResult = async (ids) => {
      const found = new Set<string>();
      for (let i = 0; i < ids.length; i += READ_PAGE) {
        for (const c of await tx.getNodes('category', ids.slice(i, i + READ_PAGE))) found.add(c.id);
      }
      return found;
    };
    return ok(await shapeNodes(tx, plan, nodes, more, false, plan.partition === undefined ? existing : nobody, maxReachedNodes));
  }

  // Named seeds: walk out `plan.depth` hops (0 means just the seeds), then narrow and page the reached set.
  const reachedSet = await reachNodes(tx, plan.seeds, plan.depth, maxReachedNodes);
  let nodes = reachedSet.nodes;
  if (plan.excludeSeeds) nodes = nodes.filter((n) => !reachedSet.seedKeys.has(keyOf(n.partition, n.id)));
  if (plan.partition !== undefined) nodes = nodes.filter((n) => n.partition === plan.partition);
  nodes = sortNodeRefs(nodes);
  if (plan.shape === 'count') return ok({ count: nodes.length, truncated: reachedSet.truncated });
  const remaining = nodes.filter((n) => plan.after === null || isAfter(n, plan.after));
  const inResult = new Set(nodes.filter((n) => n.partition === 'category').map((n) => n.id));
  const members: InResult = async (ids) => new Set(ids.filter((id) => inResult.has(id)));
  return ok(await shapeNodes(tx, plan, remaining.slice(0, plan.limit), remaining.length > plan.limit, reachedSet.truncated, members, maxReachedNodes));
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
