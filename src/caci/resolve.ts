import { caciError, type CaciError } from './errors.js';
import { err, ok, type Result } from '../graph_store/index.js';
import { isFactId, type ResolutionScope } from '../resolutions/index.js';
import { parseScope } from '../scopes/index.js';

// Reading the input of the verb operations (R-025 VR-FR-02): strict fields, nothing parsed out of free text. The scope is parsed by the
// controller with the scope module; here is only the shape of the rest.

export interface ResolveInput {
  readonly scope: unknown;
  readonly id: string;
  readonly verb?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `{ scope?, id, verb }` (or without `verb` when `withVerb` is false): any other field is refused by name, `id` must be text, and `verb`
 * must be text. Whether the verb exists, the scope is readable and the fact is there are checked by the controller after this.
 */
export function readResolveInput(input: unknown, withVerb: boolean): Result<ResolveInput, CaciError> {
  if (!isObject(input)) return err(caciError('INVALID_INPUT', withVerb ? 'send { scope, id, verb }' : 'send { scope, id }', { field: 'id' }));
  for (const key of Object.keys(input)) if (key !== 'scope' && key !== 'id' && !(withVerb && key === 'verb')) return err(caciError('INVALID_INPUT', `${key} is not accepted here`, { field: key }));
  if (typeof input.id !== 'string' || input.id === '') return err(caciError('INVALID_INPUT', 'id must be the fact\'s id', { field: 'id' }));
  if (withVerb && (typeof input.verb !== 'string' || input.verb === '')) return err(caciError('INVALID_INPUT', 'verb must be the name of a verb', { field: 'verb' }));
  return ok(Object.freeze({ scope: input.scope, id: input.id, ...(withVerb ? { verb: input.verb as string } : {}) }));
}

export const FACT_PAGE_DEFAULT = 50;
export const FACT_PAGE_MAX = 100;

/** `{ limit?, after? }` for the person's own resolutions: a limit of 1 to 100 and `after` as `{ scope, id }` (the last fact of the page before). */
export function readResolutionsPage(input: unknown): Result<{ readonly limit: number; readonly after?: { readonly scope: ResolutionScope; readonly id: string } }, CaciError> {
  if (input === undefined) return ok({ limit: FACT_PAGE_DEFAULT });
  if (!isObject(input)) return err(caciError('INVALID_INPUT', 'send { limit, after }', { field: 'limit' }));
  for (const key of Object.keys(input)) if (key !== 'limit' && key !== 'after') return err(caciError('INVALID_INPUT', `${key} is not accepted here`, { field: key }));
  const limit = input.limit === undefined ? FACT_PAGE_DEFAULT : input.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > FACT_PAGE_MAX) return err(caciError('INVALID_INPUT', `limit must be a whole number from 1 to ${FACT_PAGE_MAX}`, { field: 'limit' }));
  if (input.after === undefined) return ok({ limit });
  const after = input.after;
  if (!isObject(after)) return err(caciError('INVALID_INPUT', 'after must be { scope, id }', { field: 'after' }));
  for (const key of Object.keys(after)) if (key !== 'scope' && key !== 'id') return err(caciError('INVALID_INPUT', `after.${key} is not accepted here`, { field: `after.${key}` }));
  const scope = parseScope(after.scope);
  if (!scope.ok || typeof after.id !== 'string' || !isFactId(after.id)) return err(caciError('INVALID_INPUT', 'after must be { scope, id }', { field: 'after' }));
  return ok({ limit, after: { scope: scope.value.kind === 'personal' ? { kind: 'personal' } : { kind: 'circle', circleId: scope.value.circleId }, id: after.id } });
}
