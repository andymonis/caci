import type { StorageAdapter } from './adapter.js';
import { parseMutation, parseQuery } from './parse.js';
import { applyMutation } from './apply-mutation.js';
import { createGraph, describeGraph, dropGraph, listGraphs } from './graphs.js';
import type { Paged } from './adapter.js';
import { err, graphError, type GraphError, type Result } from './result.js';
import type { GraphInfo, GraphRef, QueryOutput, WriteOutput } from './types.js';

/** An adapter bound once at creation. `write` and `query` carry graph data; the rest manage graphs (FR-01). */
export interface GraphClient {
  readonly write: (instruction: unknown) => Promise<Result<WriteOutput, GraphError>>;
  readonly query: (query: unknown) => Promise<Result<QueryOutput, GraphError>>;
  readonly createGraph: (graphId: string) => Promise<Result<GraphRef, GraphError>>;
  readonly dropGraph: (graphId: string) => Promise<Result<GraphRef, GraphError>>;
  readonly listGraphs: (page?: { limit?: number; cursor?: string | null }) => Promise<Result<Paged<string>, GraphError>>;
  readonly describeGraph: (graphId: string) => Promise<Result<GraphInfo, GraphError>>;
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
    createGraph: (graphId: string) => createGraph(adapter, graphId),
    dropGraph: (graphId: string) => dropGraph(adapter, graphId),
    listGraphs: (page?: { limit?: number; cursor?: string | null }) => listGraphs(adapter, page),
    describeGraph: (graphId: string) => describeGraph(adapter, graphId),
  });
}
