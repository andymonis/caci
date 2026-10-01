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
}

export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxOps: 1_000,
  maxDataBytes: 64 * 1024,
  maxIdLength: 256,
});

export interface ParseOptions {
  readonly limits?: Partial<Limits>;
}

export function resolveLimits(options?: ParseOptions): Limits {
  return { ...DEFAULT_LIMITS, ...options?.limits };
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
