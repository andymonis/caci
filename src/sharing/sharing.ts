import { circlesError, isCircleId, normaliseCategories, type CirclePage, type CirclesError, type CircleStore, type Grant, type Result } from '../circles/index.js';
import { query, type JsonValue, type NodesOutput, type StorageAdapter } from '../graph_store/index.js';
import { isUserId, userGraphId, type Authenticated, type UserController, type UserStore } from '../users/index.js';

// Sharing (R-008): what a person shares of their own brain with another member of a circle. This file is the
// grant side: setting, listing and withdrawing, for the person the session belongs to. It never writes to a graph
// (the only graph call is a read of the owner's own categories), and it takes the owner from the session: there
// is no way to name whose categories are being shared but one's own.

export const DEFAULT_GRANT_LIMITS = Object.freeze({ maxCategoriesPerGrant: 200 });
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 100;
const CATEGORY_NAME_MAX = 100;
const BATCH = 50;
const STORAGE = 'the sharing service could not complete the request';

export interface SharingLimits {
  /** The most categories one grant may name. Default 200. */
  readonly maxCategoriesPerGrant?: number;
}

export interface SharingInit {
  /** Only `resolve` is used: the session gives the person. */
  readonly users: Pick<UserController, 'resolve'>;
  /** Only `get` is used, to put a username and a display name to a user id. */
  readonly directory: Pick<UserStore, 'get'>;
  /** Membership and grants. */
  readonly store: CircleStore;
  /** The graphs: read only, and only the caller's own for grants. */
  readonly graphAdapter: StorageAdapter;
  readonly limits?: SharingLimits;
  readonly clock?: () => number;
}

/** A category as it is named in a grant. */
export interface SharedCategoryView {
  readonly id: string;
  readonly name?: string;
}

/** What the caller shares with one other member of a circle: names for people to recognise them by, never an email or a graph. */
export interface GrantView {
  readonly userId: string;
  readonly username?: string;
  readonly displayName?: string;
  /** The shared categories that still exist in the caller's graph. */
  readonly categories: readonly SharedCategoryView[];
  readonly updatedAt: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export interface PageRequest {
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface Sharing {
  /**
   * Replaces what the caller shares with `granteeId` in a circle. `input` is `{ categories: [ids] }` and nothing else.
   * Every category must exist in the caller's own graph; an empty list withdraws (and answers `ok(undefined)`).
   * A stranger to the circle, and a grantee who is not a member, get `NOT_FOUND`.
   */
  setGrant(token: unknown, circleId: unknown, granteeId: unknown, input: unknown): Promise<Result<GrantView | undefined, CirclesError>>;
  /** What the caller shares in a circle, one entry per member, by user id. */
  grants(token: unknown, circleId: unknown, page?: PageRequest): Promise<Result<Page<GrantView>, CirclesError>>;
  /** Withdraws what the caller shares with `granteeId`: `true` if there was something. */
  withdraw(token: unknown, circleId: unknown, granteeId: unknown): Promise<Result<boolean, CirclesError>>;
}

const ok = <T>(value: T): Result<T, CirclesError> => ({ ok: true, value });
const err = (error: CirclesError): Result<never, CirclesError> => ({ ok: false, error });
const noCircle = (): CirclesError => circlesError('NOT_FOUND', 'no such circle');
const noMember = (): CirclesError => circlesError('NOT_FOUND', 'no such member');
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function whole(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`createSharing: ${name} must be a positive whole number`);
  return value;
}

export function createSharing(init: SharingInit): Sharing {
  if (typeof init?.users?.resolve !== 'function' || typeof init.directory?.get !== 'function' || init.store === undefined || init.graphAdapter === undefined) {
    throw new TypeError('createSharing needs a user controller (resolve), a directory (get), a circle store and a graph adapter');
  }
  const { users, directory, store, graphAdapter } = init;
  const maxCategories = whole(init.limits?.maxCategoriesPerGrant, DEFAULT_GRANT_LIMITS.maxCategoriesPerGrant, 'maxCategoriesPerGrant');
  const clock = init.clock ?? Date.now;
  const storageFailure = (): CirclesError => circlesError('STORAGE_ERROR', STORAGE);

  /** Runs `body`; anything it throws, and any storage failure, is the one fixed message (never the thrown text). */
  async function guarded<T>(body: () => Promise<Result<T, CirclesError>>): Promise<Result<T, CirclesError>> {
    try {
      const result = await body();
      return result.ok || result.error.code !== 'STORAGE_ERROR' ? result : err(storageFailure());
    } catch {
      return err(storageFailure());
    }
  }

  async function whoIs(token: unknown): Promise<Result<string, CirclesError>> {
    let resolved: Awaited<ReturnType<UserController['resolve']>>;
    try {
      resolved = await users.resolve(token);
    } catch {
      return err(storageFailure());
    }
    if (resolved.ok) return ok((resolved.value as Authenticated).user.id);
    return err(resolved.error.code === 'UNAUTHENTICATED' ? circlesError('UNAUTHENTICATED', 'not signed in') : storageFailure());
  }

  /** The caller, once they are shown to be a member of the circle: the one answer for "no such circle" otherwise. */
  async function memberOf(token: unknown, circleId: unknown): Promise<Result<{ userId: string; circleId: string }, CirclesError>> {
    const who = await whoIs(token);
    if (!who.ok) return who;
    if (!isCircleId(circleId)) return err(noCircle());
    if ((await store.membershipOf(circleId, who.value)) === undefined) return err(noCircle());
    return ok({ userId: who.value, circleId });
  }

  const nameOf = (data: JsonValue | undefined): string | undefined => {
    const name = isObject(data) ? data.name : undefined;
    return typeof name === 'string' && name !== '' ? [...name].slice(0, CATEGORY_NAME_MAX).join('') : undefined;
  };

  /** Which of `ids` are categories of the person's own graph, with their names. A missing graph holds none. */
  async function existing(ownerId: string, ids: readonly string[]): Promise<Result<Map<string, string | undefined>, CirclesError>> {
    const found = new Map<string, string | undefined>();
    for (let at = 0; at < ids.length; at += BATCH) {
      const batch = ids.slice(at, at + BATCH);
      const r = await query(graphAdapter, { version: 1, graphId: userGraphId(ownerId), from: { partition: 'category', ids: batch }, traverse: { depth: 0 }, return: { shape: 'nodes', includeData: true }, page: { limit: BATCH, cursor: null } });
      if (!r.ok) {
        if (r.error.code === 'GRAPH_NOT_FOUND') return ok(new Map());
        return err(storageFailure());
      }
      for (const node of (r.value as NodesOutput).nodes) if (node.partition === 'category') found.set(node.id, nameOf(node.data));
    }
    return ok(found);
  }

  async function view(ownerId: string, grant: Grant): Promise<Result<GrantView, CirclesError>> {
    const names = await existing(ownerId, grant.categories);
    if (!names.ok) return names;
    const person = await directory.get(grant.granteeId);
    const categories = grant.categories.filter((id) => names.value.has(id)).map((id) => {
      const name = names.value.get(id);
      return Object.freeze({ id, ...(name === undefined ? {} : { name }) });
    });
    return ok(Object.freeze({ userId: grant.granteeId, ...(person === undefined ? {} : { username: person.username, displayName: person.displayName }), categories: Object.freeze(categories), updatedAt: grant.updatedAt }));
  }

  function pageOf(request: PageRequest | undefined): Result<CirclePage, CirclesError> {
    const limit = request?.limit ?? DEFAULT_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return err(circlesError('INVALID_INPUT', `limit must be a whole number from 1 to ${MAX_PAGE}`, { field: 'limit' }));
    const cursor = request?.cursor ?? null;
    if (cursor !== null && typeof cursor !== 'string') return err(circlesError('INVALID_INPUT', 'cursor must be text', { field: 'cursor' }));
    return ok({ limit, cursor });
  }

  return {
    setGrant: (token, circleId, granteeId, input) =>
      guarded(async () => {
        const me = await memberOf(token, circleId);
        if (!me.ok) return me;
        if (!isUserId(granteeId) || (await store.membershipOf(me.value.circleId, granteeId)) === undefined) return err(noMember());
        if (granteeId === me.value.userId) return err(circlesError('INVALID_INPUT', 'you cannot share with yourself', { field: 'granteeId' }));
        if (!isObject(input)) return err(circlesError('INVALID_INPUT', 'send an object with the categories to share', { field: 'categories' }));
        const stray = Object.keys(input).find((key) => key !== 'categories');
        if (stray !== undefined) return err(circlesError('INVALID_INPUT', `${stray.length > 40 ? `${stray.slice(0, 40)}…` : stray} is not accepted here`, { field: stray.length > 40 ? 'input' : stray }));
        const normal = normaliseCategories(input.categories, maxCategories);
        if (!normal.ok) return normal;
        if (normal.value.length > 0) {
          const there = await existing(me.value.userId, normal.value);
          if (!there.ok) return there;
          if (normal.value.some((id) => !there.value.has(id))) return err(circlesError('INVALID_INPUT', 'every category must be one of your own', { field: 'categories' }));
        }
        const set = await store.setGrant(me.value.circleId, me.value.userId, granteeId, normal.value, clock(), { maxCategoriesPerGrant: maxCategories });
        if (!set.ok) {
          // the grantee may have left in the meantime: the same answer as for any non-member
          return set;
        }
        if (set.value === undefined) return ok(undefined);
        return view(me.value.userId, set.value);
      }),

    grants: (token, circleId, request) =>
      guarded(async () => {
        const me = await memberOf(token, circleId);
        if (!me.ok) return me;
        const page = pageOf(request);
        if (!page.ok) return page;
        let listed: Awaited<ReturnType<CircleStore['listGrantsBy']>>;
        try {
          listed = await store.listGrantsBy(me.value.circleId, me.value.userId, page.value);
        } catch (cause) {
          if (cause instanceof RangeError) return err(circlesError('INVALID_INPUT', 'that cursor is not one this service gave', { field: 'cursor' }));
          throw cause;
        }
        const items: GrantView[] = [];
        for (const grant of listed.items) {
          const v = await view(me.value.userId, grant);
          if (!v.ok) return v;
          items.push(v.value);
        }
        return ok(Object.freeze({ items: Object.freeze(items), nextCursor: listed.nextCursor }));
      }),

    withdraw: (token, circleId, granteeId) =>
      guarded(async () => {
        const me = await memberOf(token, circleId);
        if (!me.ok) return me;
        if (!isUserId(granteeId)) return ok(false);
        return ok(await store.withdrawGrant(me.value.circleId, me.value.userId, granteeId));
      }),
  };
}

