import { isCircleId } from '../circles/index.js';
import { err, ok, scopesError, type ScopesResult } from './errors.js';

// A scope says whose brain a request is about: the caller's own, or one circle's. These are the only two
// shapes, closed on purpose: no graph id, no user id and no other key is ever accepted from a request.

export type Scope = { readonly kind: 'personal' } | { readonly kind: 'circle'; readonly circleId: string };

/** Where a result came from, to show a person (R-009 D11). The circle name is added by whoever resolves the scope. */
export type Provenance = { readonly kind: 'personal' } | { readonly kind: 'circle'; readonly circleId: string; readonly circleName: string };

export const PERSONAL: Scope = Object.freeze({ kind: 'personal' });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const shorten = (key: string): string => (key.length > 40 ? `${key.slice(0, 40)}…` : key);

/**
 * The scope a request names. `undefined` means personal (so existing callers are unchanged). Anything else must be
 * exactly `{ kind: 'personal' }` or `{ kind: 'circle', circleId }` with a circle id of the shape the service makes;
 * any other key (a graph id, a user id, a typo) is refused by name.
 */
export function parseScope(input: unknown): ScopesResult<Scope> {
  if (input === undefined) return ok(PERSONAL);
  if (!isObject(input)) return err(scopesError('INVALID_INPUT', 'scope must be { kind: "personal" } or { kind: "circle", circleId }', 'scope'));
  const keys = Object.keys(input);
  if (input.kind === 'personal') {
    const stray = keys.find((k) => k !== 'kind');
    if (stray !== undefined) return err(scopesError('INVALID_INPUT', `${shorten(stray)} is not accepted in a personal scope`, stray.length > 40 ? 'scope' : stray));
    return ok(PERSONAL);
  }
  if (input.kind === 'circle') {
    const stray = keys.find((k) => k !== 'kind' && k !== 'circleId');
    if (stray !== undefined) return err(scopesError('INVALID_INPUT', `${shorten(stray)} is not accepted in a circle scope`, stray.length > 40 ? 'scope' : stray));
    if (!isCircleId(input.circleId)) return err(scopesError('INVALID_INPUT', 'circleId must be a circle id', 'circleId'));
    return ok(Object.freeze({ kind: 'circle', circleId: input.circleId }));
  }
  return err(scopesError('INVALID_INPUT', 'scope.kind must be "personal" or "circle"', 'scope'));
}

/**
 * The graph a circle's brain lives in: derived by trusted code from the circle id, never taken from a request.
 * A value that is not a circle id is a coding mistake and throws, as `userGraphId` does.
 */
export function circleGraphId(circleId: string): string {
  if (!isCircleId(circleId)) throw new TypeError('circleGraphId: not a circle id');
  return `circle-${circleId}`;
}

/** The circle id inside a circle graph id, or `undefined` for any other graph id. */
export function circleIdOfGraph(graphId: string): string | undefined {
  if (typeof graphId !== 'string' || !graphId.startsWith('circle-')) return undefined;
  const id = graphId.slice('circle-'.length);
  return isCircleId(id) ? id : undefined;
}
