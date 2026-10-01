import type { StorageAdapter } from './adapter.js';
import { DEFAULT_LIMITS, type Limits } from './limits.js';
import { err, graphError, ok, type GraphError, type Result } from './result.js';
import type { GraphRef } from './types.js';
import { storageError } from './write-plan.js';

/** Functional core: a graph id must be a non-empty string within the id length limit. Pure. */
export function validateGraphId(graphId: unknown, limits: Pick<Limits, 'maxIdLength'> = DEFAULT_LIMITS): Result<string> {
  if (typeof graphId !== 'string' || graphId.length === 0) {
    return err(graphError('VALIDATION_ERROR', 'graphId must be a non-empty string', ['graphId']));
  }
  if (graphId.length > limits.maxIdLength) {
    return err(graphError('VALIDATION_ERROR', `graphId exceeds ${limits.maxIdLength} characters`, ['graphId']));
  }
  return ok(graphId);
}

/** Functional core: creating a graph that already exists is a `CONFLICT`. Pure. */
export function planCreateGraph(graphId: string, exists: boolean): Result<undefined> {
  return exists
    ? err(graphError('CONFLICT', `Graph "${graphId}" already exists`, ['graphId']))
    : ok(undefined);
}

/** Functional core: dropping a graph that does not exist is `GRAPH_NOT_FOUND`. Pure. */
export function planDropGraph(graphId: string, exists: boolean): Result<undefined> {
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
export function createGraph(adapter: StorageAdapter, graphId: string): Promise<Result<GraphRef>> {
  return guarded(async () => {
    const id = validateGraphId(graphId);
    if (!id.ok) return id;
    const plan = planCreateGraph(id.value, await adapter.graphs.exists(id.value));
    if (!plan.ok) return plan;
    await adapter.graphs.create(id.value);
    return ok({ graphId: id.value });
  });
}

/** Deletes a graph and everything in it (FR-01). Fails with `GRAPH_NOT_FOUND` if it is missing. */
export function dropGraph(adapter: StorageAdapter, graphId: string): Promise<Result<GraphRef>> {
  return guarded(async () => {
    const id = validateGraphId(graphId);
    if (!id.ok) return id;
    const plan = planDropGraph(id.value, await adapter.graphs.exists(id.value));
    if (!plan.ok) return plan;
    await adapter.graphs.drop(id.value);
    return ok({ graphId: id.value });
  });
}
