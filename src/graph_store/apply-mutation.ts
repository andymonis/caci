import type { AdapterTx, GraphId, StorageAdapter } from './adapter.js';
import { applyLink, applyUnlink } from './link-ops.js';
import { applyDeleteNode, applyUpsertNode } from './node-ops.js';
import { err, graphError, ok, type GraphError, type Result } from './result.js';
import type { Mutation, Op, WriteOutput } from './types.js';
import { resolveGraph, storageError } from './write-plan.js';

/** Thrown inside the transaction to abort it, so the adapter rolls every earlier op back. */
class OpFailure extends Error {
  readonly graphError: GraphError;

  constructor(graphError: GraphError) {
    super(graphError.message);
    this.graphError = graphError;
  }
}

async function applyOp(tx: AdapterTx, op: Op): Promise<Result<undefined>> {
  switch (op.op) {
    case 'upsertNode':
      await applyUpsertNode(tx, op);
      return ok(undefined);
    case 'deleteNode':
      await applyDeleteNode(tx, op);
      return ok(undefined);
    case 'link':
      return applyLink(tx, op);
    case 'unlink':
      await applyUnlink(tx, op);
      return ok(undefined);
  }
}

/**
 * A graph this call created is removed again when the mutation fails, so a failed write leaves
 * the store unchanged. It is only dropped while still empty: if a concurrent writer has put data
 * in it since, that data stays.
 */
async function undoGraphCreation(
  adapter: StorageAdapter,
  graphId: GraphId,
  failure: GraphError,
): Promise<GraphError> {
  try {
    const page = { limit: 1, cursor: null };
    const empty = await adapter.transaction(graphId, async (tx) => {
      const [items, categories] = [await tx.listNodes('item', page), await tx.listNodes('category', page)];
      return items.items.length === 0 && categories.items.length === 0;
    });
    if (empty) await adapter.graphs.drop(graphId);
    return failure;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return graphError(
      'STORAGE_ERROR',
      `${failure.message} (and removing the newly created graph "${graphId}" also failed: ${detail})`,
    );
  }
}

/**
 * Imperative shell for `write`: resolves the graph, then applies every op in order inside one
 * adapter transaction. Later ops see earlier ops' effects. If any op fails the transaction is
 * aborted and nothing persists (FR-08, AC-04). Never throws (FR-15).
 */
export async function applyMutation(adapter: StorageAdapter, mutation: Mutation): Promise<Result<WriteOutput>> {
  let graphCreated = false;
  try {
    if (!adapter.capabilities.transactions) {
      return err(
        graphError(
          'STORAGE_ERROR',
          `Adapter "${adapter.name}" does not support transactions, so mutations cannot be applied atomically`,
        ),
      );
    }
    const resolved = await resolveGraph(adapter, mutation);
    if (!resolved.ok) return resolved;
    graphCreated = resolved.value.created;

    await adapter.transaction(mutation.graphId, async (tx) => {
      for (const [index, op] of mutation.ops.entries()) {
        const result = await applyOp(tx, op);
        if (!result.ok) {
          const { code, message, path = [] } = result.error;
          throw new OpFailure(graphError(code, message, ['ops', index, ...path]));
        }
      }
    });
    return ok({ graphId: mutation.graphId, applied: mutation.ops.length, graphCreated });
  } catch (cause) {
    const failure = cause instanceof OpFailure ? cause.graphError : storageError(cause);
    return err(graphCreated ? await undoGraphCreation(adapter, mutation.graphId, failure) : failure);
  }
}
