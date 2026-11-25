import { isUserId } from '../users/index.js';
import { FACT_ID_MAX, MAX_LIST_FOR, MAX_RESOLUTION_PAGE, type Resolution, type ResolutionPageInput, type ResolutionScope, type ResolvedFact } from './types.js';

export const CIRCLE_ID = /^c[a-z0-9]{16}$/;
export const VERB_NAME = /^[a-z0-9-]{1,20}$/;
const KEYS = ['userId', 'scope', 'factId', 'verb', 'at'] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A fact id: 1 to 256 characters, no lone surrogates (they would not survive being stored as text). Any other text is a legal graph id. */
export const isFactId = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && [...v].length <= FACT_ID_MAX && !/\p{Cs}/u.test(v);

export function scopeProblem(scope: unknown): string | undefined {
  if (!isObject(scope)) return 'scope must be an object';
  if (scope.kind === 'personal') return Object.keys(scope).length === 1 ? undefined : 'a personal scope has no other field';
  if (scope.kind === 'circle') return Object.keys(scope).length === 2 && typeof scope.circleId === 'string' && CIRCLE_ID.test(scope.circleId) ? undefined : 'a circle scope is exactly a kind and a circle id';
  return 'scope.kind must be personal or circle';
}

/** `undefined` when the record is acceptable, otherwise the first thing wrong. Strict: a field that is not listed is refused, so no text can be smuggled in. */
export function resolutionProblem(record: unknown): string | undefined {
  if (!isObject(record)) return 'a resolution must be an object';
  for (const key of Object.keys(record)) if (!(KEYS as readonly string[]).includes(key)) return `a resolution has no field ${JSON.stringify(key.slice(0, 20))}`;
  if (!isUserId(record.userId)) return 'userId must be a user id';
  const scope = scopeProblem(record.scope);
  if (scope !== undefined) return scope;
  if (!isFactId(record.factId)) return 'factId must be 1 to 256 characters of text';
  if (typeof record.verb !== 'string' || !VERB_NAME.test(record.verb)) return 'verb must be 1 to 20 characters of a-z, 0-9 and -';
  if (typeof record.at !== 'number' || !Number.isSafeInteger(record.at) || record.at < 0 || record.at > 8_640_000_000_000_000) return 'at must be a whole number of milliseconds';
  return undefined;
}

export const copyScope = (s: ResolutionScope): ResolutionScope => Object.freeze(s.kind === 'personal' ? { kind: 'personal' as const } : { kind: 'circle' as const, circleId: s.circleId });
export const copyResolution = (r: Resolution): Resolution => Object.freeze({ userId: r.userId, scope: copyScope(r.scope), factId: r.factId, verb: r.verb, at: r.at });
export const copyFact = (f: ResolvedFact): ResolvedFact => Object.freeze({ scope: copyScope(f.scope), factId: f.factId });

export const scopeKey = (scope: ResolutionScope): string => (scope.kind === 'personal' ? 'personal' : `circle:${scope.circleId}`);

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The fixed order of listings: scope, then fact id, in UTF-16 order. */
export const compareFacts = (a: ResolvedFact, b: ResolvedFact): number => text(scopeKey(a.scope), scopeKey(b.scope)) || text(a.factId, b.factId);

/** A page limit of 1 to 100 and a well-formed `after`; anything else is a coding mistake (a `RangeError`). */
export function checkPage(page: ResolutionPageInput | { readonly limit: number; readonly after?: ResolvedFact }): void {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > MAX_RESOLUTION_PAGE) throw new RangeError(`a page limit is a whole number from 1 to ${MAX_RESOLUTION_PAGE}`);
  if (page.after !== undefined && (scopeProblem(page.after.scope) !== undefined || !isFactId(page.after.factId))) throw new RangeError('a page position needs a scope and a fact id');
}

/** At most 500 well-formed fact ids; anything else is a coding mistake (a `RangeError`). */
export function checkFactIds(factIds: readonly string[]): void {
  if (!Array.isArray(factIds) || factIds.length > MAX_LIST_FOR || !factIds.every(isFactId)) throw new RangeError(`listFor takes at most ${MAX_LIST_FOR} fact ids`);
}

/** A well-formed user id, scope and fact id for a read or a remove; anything else is a coding mistake (a `RangeError`). */
export function checkKey(userId: string, scope: ResolutionScope, factId: string): void {
  if (!isUserId(userId) || scopeProblem(scope) !== undefined || !isFactId(factId)) throw new RangeError('a resolution is found by a user id, a scope and a fact id');
}
