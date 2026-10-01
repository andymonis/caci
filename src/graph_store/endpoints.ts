import type { StorageAdapter } from './adapter.js';
import { parseMutation, parseQuery } from './parse.js';
import { applyMutation } from './apply-mutation.js';
import { err, graphError, type GraphError, type Result } from './result.js';
import type { WriteOutput } from './types.js';

/** Placeholder shape; widened when the query endpoint is implemented (M4). */
export interface QueryOutput {
  readonly nextCursor: string | null;
}

export interface GraphClient {
  readonly write: (instruction: unknown) => Promise<Result<WriteOutput, GraphError>>;
  readonly query: (query: unknown) => Promise<Result<QueryOutput, GraphError>>;
}

// The error-code enum is closed (spec), so STORAGE_ERROR stands in until query is implemented.
const notImplemented = (endpoint: string) =>
  err(graphError('STORAGE_ERROR', `${endpoint}() is not implemented yet`));

/**
 * Endpoint 1: writes. Accepts mutation instructions only. Ops apply in order and atomically:
 * all succeed or none persist (FR-08).
 */
export async function write(
  adapter: StorageAdapter,
  instruction: unknown,
): Promise<Result<WriteOutput, GraphError>> {
  const parsed = parseMutation(instruction);
  if (!parsed.ok) return parsed;
  return applyMutation(adapter, parsed.value);
}

/** Endpoint 2: reads. Accepts queries only; never changes the store. */
export async function query(
  adapter: StorageAdapter,
  input: unknown,
): Promise<Result<QueryOutput, GraphError>> {
  const parsed = parseQuery(input);
  if (!parsed.ok) return parsed;
  return notImplemented('query');
}

/** Binds an adapter. Holds only the adapter reference and caches nothing. */
export function createGraphClient(adapter: StorageAdapter): GraphClient {
  return Object.freeze({
    write: (instruction: unknown) => write(adapter, instruction),
    query: (input: unknown) => query(adapter, input),
  });
}
