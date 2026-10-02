import type { StorageAdapter } from './adapter.js';
import { checkOptions, resolveLimits, type GraphOptions } from './limits.js';
import { parseMutation, parseQuery } from './parse.js';
import { executeQuery } from './query-exec.js';
import { planQuery } from './query-plan.js';
import { applyMutation } from './apply-mutation.js';
import { createGraph, describeGraph, dropGraph, listGraphs } from './graphs.js';
import type { Paged } from './adapter.js';
import { err, type GraphError, type Result } from './result.js';
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

/**
 * Endpoint 1: writes. Accepts mutation instructions only. Ops apply in order and atomically:
 * all succeed or none persist (FR-08). `options.limits` can tighten the caps for this call.
 */
export async function write(
  adapter: StorageAdapter,
  instruction: unknown,
  options?: GraphOptions,
): Promise<Result<WriteOutput, GraphError>> {
  const badOptions = checkOptions(options);
  if (badOptions) return err(badOptions);
  const parsed = parseMutation(instruction, options);
  if (!parsed.ok) return parsed;
  return applyMutation(adapter, parsed.value);
}

/**
 * Endpoint 2: reads. Accepts queries only and never changes the store. Parsing and planning
 * happen before the adapter is touched, so invalid input never reaches it.
 */
export async function query(
  adapter: StorageAdapter,
  input: unknown,
  options?: GraphOptions,
): Promise<Result<QueryOutput, GraphError>> {
  const badOptions = checkOptions(options);
  if (badOptions) return err(badOptions);
  const parsed = parseQuery(input, options);
  if (!parsed.ok) return parsed;
  const plan = planQuery(parsed.value);
  if (!plan.ok) return plan;
  return executeQuery(adapter, plan.value, resolveLimits(options));
}

/**
 * Binds an adapter and, optionally, settings that apply to every call (for example tighter
 * `limits`). Holds only those and caches nothing. Throws a `RangeError` for invalid options, since
 * that is a mistake in the code creating the client, not in a request.
 */
export function createGraphClient(adapter: StorageAdapter, options?: GraphOptions): GraphClient {
  const bad = checkOptions(options);
  if (bad) throw new RangeError(`Invalid client options at ${bad.path?.join('.') ?? 'options'}: ${bad.message}`);
  // A private frozen copy, so changing the caller's object later cannot change the client.
  const bound: GraphOptions = Object.freeze({ limits: Object.freeze({ ...options?.limits }) });
  return Object.freeze({
    write: (instruction: unknown) => write(adapter, instruction, bound),
    query: (input: unknown) => query(adapter, input, bound),
    createGraph: (graphId: string) => createGraph(adapter, graphId, bound),
    dropGraph: (graphId: string) => dropGraph(adapter, graphId, bound),
    listGraphs: (page?: { limit?: number; cursor?: string | null }) => listGraphs(adapter, page),
    describeGraph: (graphId: string) => describeGraph(adapter, graphId, bound),
  });
}
