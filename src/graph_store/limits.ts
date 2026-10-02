import { graphError, type GraphError } from './result.js';
import type { ParsedMutation } from './schema/mutation.js';
import type { ParsedQuery } from './schema/query.js';

export interface Limits {
  /** Maximum ops in one mutation. */
  readonly maxOps: number;
  /** Maximum serialised size of a `data` payload, in bytes (UTF-8 JSON). */
  readonly maxDataBytes: number;
  /** Maximum length of any id, in characters. */
  readonly maxIdLength: number;
  /** Most nodes one query may reach before it stops and reports `truncated` (bounds work and memory). */
  readonly maxReachedNodes: number;
}

export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxOps: 1_000,
  maxDataBytes: 64 * 1024,
  maxIdLength: 256,
  maxReachedNodes: 10_000,
});

/** Page size used when a caller does not give one, and the most a caller may ask for (FR-14). */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 1000;

/** Whether results carry node and edge `data` when the query does not say (provisional; see STATE). */
export const DEFAULT_INCLUDE_DATA = false;

/** Settings for a call, or for a whole client. Anything left out takes its default. */
export interface GraphOptions {
  readonly limits?: Partial<Limits>;
}

export function resolveLimits(options?: GraphOptions): Limits {
  return { ...DEFAULT_LIMITS, ...options?.limits };
}

/**
 * Checks options before they are used, so a typo or nonsense value fails loudly instead of being
 * ignored or breaking every call: only `limits` is allowed, only known limit names, and each limit
 * must be a positive whole number. Pure; never throws.
 */
export function checkOptions(options: unknown): GraphError | undefined {
  try {
    if (options === undefined) return undefined;
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      return graphError('VALIDATION_ERROR', 'options must be an object like { limits: { ... } }', ['options']);
    }
    const { limits, ...extra } = options as Record<string, unknown>;
    const unknownOption = Object.keys(extra)[0];
    if (unknownOption !== undefined) return graphError('VALIDATION_ERROR', `Unknown option "${unknownOption}"`, ['options', unknownOption]);
    if (limits === undefined) return undefined;
    if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
      return graphError('VALIDATION_ERROR', 'options.limits must be an object', ['options', 'limits']);
    }
    for (const [name, value] of Object.entries(limits)) {
      if (!(name in DEFAULT_LIMITS)) {
        return graphError('VALIDATION_ERROR', `Unknown limit "${name}"; known limits: ${Object.keys(DEFAULT_LIMITS).join(', ')}`, ['options', 'limits', name]);
      }
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        return graphError('VALIDATION_ERROR', `limit "${name}" must be a positive whole number`, ['options', 'limits', name]);
      }
    }
    return undefined;
  } catch {
    return graphError('VALIDATION_ERROR', 'options could not be read', ['options']);
  }
}

type Path = readonly (string | number)[];

function checkId(value: string, path: Path, limits: Limits): GraphError | undefined {
  if (value.length <= limits.maxIdLength) return undefined;
  return graphError('VALIDATION_ERROR', `Id exceeds ${limits.maxIdLength} characters`, path);
}

function checkData(data: unknown, path: Path, limits: Limits): GraphError | undefined {
  if (data === undefined) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(data)).length;
  if (bytes <= limits.maxDataBytes) return undefined;
  return graphError('VALIDATION_ERROR', `data exceeds ${limits.maxDataBytes} bytes`, path);
}

/** Cheap pre-check on raw input, before the full schema parse. */
export function checkOpCount(ops: unknown, limits: Limits): GraphError | undefined {
  if (!Array.isArray(ops) || ops.length <= limits.maxOps) return undefined;
  return graphError('VALIDATION_ERROR', `A mutation may contain at most ${limits.maxOps} ops`, ['ops']);
}

export function checkMutationLimits(m: ParsedMutation, limits: Limits): GraphError | undefined {
  const graphIdError = checkId(m.graphId, ['graphId'], limits);
  if (graphIdError) return graphIdError;
  for (const [i, op] of m.ops.entries()) {
    const found =
      op.op === 'upsertNode'
        ? (checkId(op.id, ['ops', i, 'id'], limits) ?? checkData(op.data, ['ops', i, 'data'], limits))
        : op.op === 'deleteNode'
          ? checkId(op.id, ['ops', i, 'id'], limits)
          : op.op === 'link'
            ? (checkId(op.item, ['ops', i, 'item'], limits) ??
              checkId(op.category, ['ops', i, 'category'], limits) ??
              checkData(op.data, ['ops', i, 'data'], limits))
            : (checkId(op.item, ['ops', i, 'item'], limits) ??
              checkId(op.category, ['ops', i, 'category'], limits));
    if (found) return found;
  }
  return undefined;
}

export function checkQueryLimits(q: ParsedQuery, limits: Limits): GraphError | undefined {
  const graphIdError = checkId(q.graphId, ['graphId'], limits);
  if (graphIdError) return graphIdError;
  if ('ids' in q.from) {
    for (const [i, id] of q.from.ids.entries()) {
      const found = checkId(id, ['from', 'ids', i], limits);
      if (found) return found;
    }
  }
  for (const clause of ['all', 'any', 'none'] as const) {
    for (const [i, id] of (q.filter?.[clause] ?? []).entries()) {
      const found = checkId(id, ['filter', clause, i], limits);
      if (found) return found;
    }
  }
  return undefined;
}
