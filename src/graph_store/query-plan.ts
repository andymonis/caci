import type { Partition } from './adapter.js';
import { DEFAULT_INCLUDE_DATA } from './limits.js';
import { decodeQueryCursor, queryFingerprint } from './query-cursor.js';
import { compareNodeRefs } from './query-order.js';
import { err, graphError, ok, type Result } from './result.js';
import type { NodeRef, Query } from './types.js';

/** Where a query starts: the whole graph, or named nodes in one partition. */
export type SeedSource = { kind: 'all' } | { kind: 'ids'; partition: Partition; ids: string[] };

/** A parsed query, normalised into exactly what the executor needs. */
export interface QueryPlan {
  graphId: string;
  seeds: SeedSource;
  /** Hops to walk from the seeds (0 to 3). Always 0 for `all`, which already is the whole graph. */
  depth: number;
  /** Drop the seeds from the result. */
  excludeSeeds: boolean;
  /** Keep only nodes of this partition. */
  partition: Partition | undefined;
  shape: 'subgraph' | 'nodes' | 'ids' | 'count';
  includeData: boolean;
  limit: number;
  /** Continue after this node, or `null` for the first page. */
  after: NodeRef | null;
  /** Identifies the query apart from its page; cursors are bound to it. */
  fingerprint: string;
}

const notYet = (feature: string, path: (string | number)[]) =>
  err(graphError('VALIDATION_ERROR', `${feature} is not supported yet`, path));

/**
 * Functional core of `query`: checks what can be executed and turns the query into a plan. Pure;
 * never throws. Parts of the query format that are accepted but not yet executed are refused here
 * by name, because ignoring them would return a wrong answer that looks right.
 */
export function planQuery(query: Query): Result<QueryPlan> {
  // Checked in a fixed order, so the same query always reports the same first problem.
  let seeds: SeedSource;
  if ('all' in query.from) seeds = { kind: 'all' };
  else if ('ids' in query.from) seeds = { kind: 'ids', partition: query.from.partition, ids: uniqueSorted(query.from.ids) };
  else return notYet('from.where (matching seeds on data)', ['from', 'where']);

  const filter = query.filter;
  if (filter?.where !== undefined) return notYet('filter.where (matching on data)', ['filter', 'where']);
  for (const clause of ['all', 'any', 'none'] as const) {
    if (filter?.[clause] !== undefined) return notYet(`filter.${clause} (category set clauses)`, ['filter', clause]);
  }

  const fingerprint = queryFingerprint(query);
  let after: NodeRef | null = null;
  if (query.page.cursor !== null) {
    if (query.return.shape === 'count') {
      return err(graphError('VALIDATION_ERROR', 'a count result is not paged, so it takes no cursor', ['page', 'cursor']));
    }
    const decoded = decodeQueryCursor(query.page.cursor, fingerprint);
    if (!decoded.ok) return decoded;
    after = decoded.value;
  }

  return ok({
    graphId: query.graphId,
    seeds,
    depth: seeds.kind === 'all' ? 0 : query.traverse.depth,
    excludeSeeds: filter?.excludeSeeds ?? false,
    partition: filter?.partition,
    shape: query.return.shape,
    includeData: query.return.includeData ?? DEFAULT_INCLUDE_DATA,
    limit: query.page.limit,
    after,
    fingerprint,
  });
}

function uniqueSorted(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((a, b) => compareNodeRefs({ partition: 'item', id: a }, { partition: 'item', id: b }));
}
