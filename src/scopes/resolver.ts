import type { CircleRole, CircleStore } from '../circles/index.js';
import { isUserId, userGraphId, type Authenticated, type UserController } from '../users/index.js';
import { err, ok, scopesError, type ScopesError, type ScopesResult } from './errors.js';
import { authoriseBrain, type BrainAction } from './policy.js';
import { circleGraphId, PERSONAL, type Provenance, type Scope } from './scope.js';

// The resolver turns "a session and a scope" into "exactly one graph the person may use for this action", or
// one fixed answer. It reads nothing from any graph. Membership and role are read from the store on every call:
// nothing is cached, so a demotion, a removal or a promotion takes effect on the next request.

/** What a successful resolution gives the caller. The graph id is for trusted code only and never goes to a client. */
export interface ResolvedScope {
  readonly userId: string;
  readonly scope: Scope;
  readonly graphId: string;
  readonly provenance: Provenance;
  /** The person's role in the circle (`undefined` for a personal scope). */
  readonly role?: CircleRole;
}

export interface ScopeResolverInit {
  /** Only `resolve` is used: the session gives the person. */
  readonly users: Pick<UserController, 'resolve'>;
  /** Only the current role and the circle's name are read; `listCirclesOf` lists the circles for `readable`. */
  readonly store: Pick<CircleStore, 'membershipOf' | 'getCircle' | 'listCirclesOf'>;
  /** The most scopes (the personal brain plus circles) one combined view may cover. More is refused, never silently cut. Default 25. */
  readonly maxScopes?: number;
}

export interface ScopeResolver {
  /** The person a session belongs to, or `UNAUTHENTICATED`. */
  who(token: unknown): Promise<ScopesResult<string>>;
  /** The graph for this scope and action. A circle the person may not use for this action is `NOT_FOUND`, the same for every reason. */
  resolve(token: unknown, scope: Scope, action: BrainAction): Promise<ScopesResult<ResolvedScope>>;
  /**
   * Every scope the person may read right now, for a combined view: their own brain first, then each circle they are
   * in (every role may read), by circle id. Read from the store on every call. More than `maxScopes` is `LIMIT_REACHED`.
   */
  readable(token: unknown): Promise<ScopesResult<readonly ResolvedScope[]>>;
}

const STORAGE = 'the scopes service could not complete the request';
const NO_CIRCLE = 'no such circle';

export function createScopeResolver(init: ScopeResolverInit): ScopeResolver {
  if (typeof init?.users?.resolve !== 'function' || typeof init.store?.membershipOf !== 'function' || typeof init.store.getCircle !== 'function' || typeof init.store.listCirclesOf !== 'function') {
    throw new TypeError('createScopeResolver needs a user controller (resolve) and a circle store (membershipOf, getCircle, listCirclesOf)');
  }
  const maxScopes = init.maxScopes ?? 25;
  if (!Number.isSafeInteger(maxScopes) || maxScopes < 1) throw new TypeError('createScopeResolver: maxScopes must be a positive whole number');
  const { users, store } = init;
  const storage = (): ScopesError => scopesError('STORAGE_ERROR', STORAGE);

  async function who(token: unknown): Promise<ScopesResult<string>> {
    let resolved: Awaited<ReturnType<UserController['resolve']>>;
    try {
      resolved = await users.resolve(token);
    } catch {
      return err(storage());
    }
    if (resolved.ok) {
      const id = (resolved.value as Authenticated).user.id;
      return isUserId(id) ? ok(id) : err(storage());
    }
    return err(resolved.error.code === 'UNAUTHENTICATED' ? scopesError('UNAUTHENTICATED', 'not signed in') : storage());
  }

  const PAGE = 100;
  async function readable(token: unknown): Promise<ScopesResult<readonly ResolvedScope[]>> {
    const person = await who(token);
    if (!person.ok) return person;
    const out: ResolvedScope[] = [Object.freeze({ userId: person.value, scope: PERSONAL, graphId: userGraphId(person.value), provenance: Object.freeze({ kind: 'personal' as const }) })];
    try {
      const seen = new Set<string>();
      let cursor: string | null = null;
      for (;;) {
        const page = await store.listCirclesOf(person.value, { limit: PAGE, cursor });
        for (const s of page.items) {
          if (out.length >= maxScopes) return err(scopesError('LIMIT_REACHED', `you are in more circles than can be combined in one view (at most ${maxScopes - 1}): choose one circle`));
          out.push(Object.freeze({ userId: person.value, scope: Object.freeze({ kind: 'circle' as const, circleId: s.circle.id }), graphId: circleGraphId(s.circle.id), provenance: Object.freeze({ kind: 'circle' as const, circleId: s.circle.id, circleName: s.circle.name }), role: s.role }));
        }
        if (page.nextCursor === null) break;
        if (seen.has(page.nextCursor)) return err(storage());
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    } catch {
      return err(storage());
    }
    return ok(Object.freeze(out));
  }

  return Object.freeze({
    who,
    readable,
    async resolve(token: unknown, scope: Scope, action: BrainAction): Promise<ScopesResult<ResolvedScope>> {
      const person = await who(token);
      if (!person.ok) return person;
      if (scope === undefined || scope === null || typeof scope !== 'object') return err(scopesError('INVALID_INPUT', 'scope is required', 'scope'));
      if (scope.kind === 'personal') {
        return ok(Object.freeze({ userId: person.value, scope, graphId: userGraphId(person.value), provenance: Object.freeze({ kind: 'personal' as const }) }));
      }
      if (scope.kind !== 'circle') return err(scopesError('INVALID_INPUT', 'scope.kind must be "personal" or "circle"', 'scope'));
      let graphId: string;
      try {
        graphId = circleGraphId(scope.circleId);
      } catch {
        return err(scopesError('NOT_FOUND', NO_CIRCLE));
      }
      try {
        const membership = await store.membershipOf(scope.circleId, person.value);
        if (membership === undefined || !authoriseBrain(membership.role, action)) return err(scopesError('NOT_FOUND', NO_CIRCLE));
        const circle = await store.getCircle(scope.circleId);
        if (circle === undefined) return err(scopesError('NOT_FOUND', NO_CIRCLE));
        return ok(Object.freeze({ userId: person.value, scope, graphId, provenance: Object.freeze({ kind: 'circle' as const, circleId: scope.circleId, circleName: circle.name }), role: membership.role }));
      } catch {
        return err(storage());
      }
    },
  });
}
