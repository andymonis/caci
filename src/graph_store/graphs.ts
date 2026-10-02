import type { AdapterTx, Page, Paged, StorageAdapter } from './adapter.js';
import { GRAPH_ID_PATTERN, GRAPH_ID_RULE, MAX_GRAPH_ID_LENGTH } from './graph-id.js';
import { checkOptions, DEFAULT_LIMITS, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, resolveLimits, type GraphOptions, type Limits } from './limits.js';
import { err, graphError, ok, type GraphError, type Result } from './result.js';
import type { GraphInfo, GraphRef } from './types.js';
import { storageError } from './write-plan.js';

/**
 * Functional core: a graph id must match the safe character set and stay within the length limit.
 * Pure. See `graph-id.ts` for why graph ids are restricted.
 */
export function validateGraphId(graphId: unknown, limits: Pick<Limits, 'maxIdLength'> = DEFAULT_LIMITS): Result<string> {
  if (typeof graphId !== 'string') {
    return err(graphError('VALIDATION_ERROR', `graphId must be a string: ${GRAPH_ID_RULE}`, ['graphId']));
  }
  if (graphId.length > Math.min(MAX_GRAPH_ID_LENGTH, limits.maxIdLength)) {
    return err(graphError('VALIDATION_ERROR', `graphId is too long: ${GRAPH_ID_RULE}`, ['graphId']));
  }
  if (!GRAPH_ID_PATTERN.test(graphId)) {
    return err(graphError('VALIDATION_ERROR', `graphId has characters that are not allowed: ${GRAPH_ID_RULE}`, ['graphId']));
  }
  return ok(graphId);
}

/** Functional core: creating a graph that already exists is a `CONFLICT`. Pure. */
export function planCreateGraph(graphId: string, exists: boolean): Result<undefined> {
  return exists
    ? err(graphError('CONFLICT', `Graph "${graphId}" already exists`, ['graphId']))
    : ok(undefined);
}

/** Functional core: operating on a graph that does not exist is `GRAPH_NOT_FOUND`. Pure. */
export function requireGraph(graphId: string, exists: boolean): Result<undefined> {
  return exists
    ? ok(undefined)
    : err(graphError('GRAPH_NOT_FOUND', `Graph "${graphId}" does not exist`, ['graphId']));
}

/** Runs a graph-lifecycle body so that nothing, including adapter failures, can make it throw. */
async function guarded<T>(body: () => Promise<Result<T>>): Promise<Result<T, GraphError>> {
  try {
    return await body();
  } catch (cause) {
    return err(storageError(cause));
  }
}

/**
 * Creates an empty graph (FR-01). Fails with `CONFLICT` if it already exists.
 * The existence check and the create are separate adapter calls, so two simultaneous creates of
 * the same id can both succeed; `write` with `createIfMissing` is the idempotent alternative.
 */
export function createGraph(adapter: StorageAdapter, graphId: string, options?: GraphOptions): Promise<Result<GraphRef>> {
  return guarded(async () => {
    const bad = checkOptions(options);
    if (bad) return err(bad);
    const id = validateGraphId(graphId, resolveLimits(options));
    if (!id.ok) return id;
    const plan = planCreateGraph(id.value, await adapter.graphs.exists(id.value));
    if (!plan.ok) return plan;
    await adapter.graphs.create(id.value);
    return ok({ graphId: id.value });
  });
}

/** Deletes a graph and everything in it (FR-01). Fails with `GRAPH_NOT_FOUND` if it is missing. */
export function dropGraph(adapter: StorageAdapter, graphId: string, options?: GraphOptions): Promise<Result<GraphRef>> {
  return guarded(async () => {
    const bad = checkOptions(options);
    if (bad) return err(bad);
    const id = validateGraphId(graphId, resolveLimits(options));
    if (!id.ok) return id;
    const plan = requireGraph(id.value, await adapter.graphs.exists(id.value));
    if (!plan.ok) return plan;
    await adapter.graphs.drop(id.value);
    return ok({ graphId: id.value });
  });
}

/**
 * Functional core: turns a caller's page argument into a concrete `Page` (FR-14). Accepts
 * `undefined` or `{ limit?, cursor? }`; the limit is a whole number from 1 to 1000 (default 50).
 * Unknown keys are rejected so typos fail loudly. Pure; never throws.
 */
export function normalizePage(page: unknown): Result<Page> {
  try {
    if (page === undefined) return ok({ limit: DEFAULT_PAGE_LIMIT, cursor: null });
    if (typeof page !== 'object' || page === null || Array.isArray(page)) {
      return err(graphError('VALIDATION_ERROR', 'page must be an object like { limit, cursor }', ['page']));
    }
    const { limit = DEFAULT_PAGE_LIMIT, cursor = null, ...unknown } = page as Record<string, unknown>;
    const extra = Object.keys(unknown)[0];
    if (extra !== undefined) {
      return err(graphError('VALIDATION_ERROR', `Unknown page field "${extra}"`, ['page', extra]));
    }
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
      return err(
        graphError('VALIDATION_ERROR', `page.limit must be a whole number from 1 to ${MAX_PAGE_LIMIT}`, ['page', 'limit']),
      );
    }
    if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0)) {
      return err(graphError('VALIDATION_ERROR', 'page.cursor must be a non-empty string or null', ['page', 'cursor']));
    }
    return ok({ limit, cursor });
  } catch {
    return err(graphError('VALIDATION_ERROR', 'page could not be read', ['page']));
  }
}

/**
 * Lists graph ids in a deterministic order with a keyset cursor (FR-01, FR-14). Pass the
 * returned `nextCursor` back in as `page.cursor` to continue; `null` means there is no more.
 */
export function listGraphs(adapter: StorageAdapter, page?: { limit?: number; cursor?: string | null }): Promise<Result<Paged<string>>> {
  return guarded(async () => {
    const normalized = normalizePage(page);
    if (!normalized.ok) return normalized;
    return ok(await adapter.graphs.list(normalized.value));
  });
}

/** Counts every row of a paged listing without holding more than one page in memory. */
async function countAll(fetch: (page: Page) => Promise<Paged<unknown>>): Promise<number> {
  let count = 0;
  let cursor: string | null = null;
  do {
    const result: Paged<unknown> = await fetch({ limit: MAX_PAGE_LIMIT, cursor });
    count += result.items.length;
    cursor = result.nextCursor;
  } while (cursor !== null);
  return count;
}

async function countEdges(tx: AdapterTx): Promise<number> {
  // Every edge has exactly one item end, so summing over items counts each edge once.
  let edges = 0;
  let cursor: string | null = null;
  do {
    const items: Paged<{ id: string }> = await tx.listNodes('item', { limit: MAX_PAGE_LIMIT, cursor });
    for (const item of items.items) edges += await countAll((page) => tx.edgesOf('item', item.id, page));
    cursor = items.nextCursor;
  } while (cursor !== null);
  return edges;
}

/**
 * Reports how much is in a graph (FR-01). Fails with `GRAPH_NOT_FOUND` if it is missing.
 * In v1 the counts come from walking the graph inside one transaction, so the cost grows with
 * the graph's size and writers to this graph wait while it runs.
 */
export function describeGraph(adapter: StorageAdapter, graphId: string, options?: GraphOptions): Promise<Result<GraphInfo>> {
  return guarded(async () => {
    const bad = checkOptions(options);
    if (bad) return err(bad);
    const id = validateGraphId(graphId, resolveLimits(options));
    if (!id.ok) return id;
    const plan = requireGraph(id.value, await adapter.graphs.exists(id.value));
    if (!plan.ok) return plan;
    const info = await adapter.transaction(id.value, async (tx) => ({
      graphId: id.value,
      itemCount: await countAll((page) => tx.listNodes('item', page)),
      categoryCount: await countAll((page) => tx.listNodes('category', page)),
      edgeCount: await countEdges(tx),
    }));
    return ok(info);
  });
}
