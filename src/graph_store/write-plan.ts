import type { GraphId, StorageAdapter } from './adapter.js';
import { err, graphError, ok, type GraphError, type Result } from './result.js';
import type { Mutation } from './types.js';

/** What the shell must do about the target graph before applying a mutation's ops. */
export interface GraphResolution {
  readonly graphId: GraphId;
  /**
   * `create-if-missing`: create the graph in one atomic adapter call and learn whether this call
   * made it. `require-existing`: the graph must already be there.
   */
  readonly strategy: 'create-if-missing' | 'require-existing';
}

/** Functional core: decides how to handle the target graph. Pure; no I/O (FR-02). */
export function planGraphResolution(mutation: Pick<Mutation, 'graphId' | 'createIfMissing'>): GraphResolution {
  return { graphId: mutation.graphId, strategy: mutation.createIfMissing ? 'create-if-missing' : 'require-existing' };
}

/**
 * Imperative shell: applies the plan, and reports whether this call created the graph (so a later
 * failure can undo the creation). A mutation against a missing graph fails unless `createIfMissing`
 * is set (AC-02). With `createIfMissing` the creation is atomic, so nothing can slip in between a
 * check and the create. Never throws.
 */
export async function resolveGraph(
  adapter: StorageAdapter,
  mutation: Pick<Mutation, 'graphId' | 'createIfMissing'>,
): Promise<Result<{ readonly created: boolean }>> {
  try {
    const plan = planGraphResolution(mutation);
    if (plan.strategy === 'create-if-missing') {
      const created: unknown = await adapter.graphs.create(plan.graphId);
      if (typeof created !== 'boolean') {
        return err(graphError('STORAGE_ERROR', 'Storage adapter failed: graphs.create did not say whether it created the graph'));
      }
      return ok({ created });
    }
    if (!(await adapter.graphs.exists(plan.graphId))) {
      return err(graphError('GRAPH_NOT_FOUND', `Graph "${plan.graphId}" does not exist; set createIfMissing: true to create it`, ['graphId']));
    }
    return ok({ created: false });
  } catch (cause) {
    return err(storageError(cause));
  }
}

export function storageError(cause: unknown): GraphError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return graphError('STORAGE_ERROR', `Storage adapter failed: ${detail}`);
}
