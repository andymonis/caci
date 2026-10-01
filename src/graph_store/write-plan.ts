import type { GraphId, StorageAdapter } from './adapter.js';
import { err, graphError, ok, type GraphError, type Result } from './result.js';
import type { Mutation } from './types.js';

/** What the shell must do about the target graph before applying a mutation's ops. */
export interface GraphResolution {
  readonly graphId: GraphId;
  /** True when the graph is missing and the mutation asked for it to be created. */
  readonly create: boolean;
}

/**
 * Functional core: decides how to handle the target graph. Pure; no I/O (FR-02).
 * A mutation against a missing graph fails unless `createIfMissing` is set.
 */
export function planGraphResolution(
  mutation: Pick<Mutation, 'graphId' | 'createIfMissing'>,
  graphExists: boolean,
): Result<GraphResolution> {
  const { graphId, createIfMissing } = mutation;
  if (graphExists) return ok({ graphId, create: false });
  if (createIfMissing) return ok({ graphId, create: true });
  return err(
    graphError(
      'GRAPH_NOT_FOUND',
      `Graph "${graphId}" does not exist; set createIfMissing: true to create it`,
      ['graphId'],
    ),
  );
}

/**
 * Imperative shell: asks the adapter whether the graph exists, applies the plan, and reports
 * whether this call created it (so a later failure can undo the creation). Never throws.
 */
export async function resolveGraph(
  adapter: StorageAdapter,
  mutation: Pick<Mutation, 'graphId' | 'createIfMissing'>,
): Promise<Result<{ readonly created: boolean }>> {
  try {
    const exists = await adapter.graphs.exists(mutation.graphId);
    const plan = planGraphResolution(mutation, exists);
    if (!plan.ok) return plan;
    if (plan.value.create) await adapter.graphs.create(plan.value.graphId);
    return ok({ created: plan.value.create });
  } catch (cause) {
    return err(storageError(cause));
  }
}

export function storageError(cause: unknown): GraphError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return graphError('STORAGE_ERROR', `Storage adapter failed: ${detail}`);
}
