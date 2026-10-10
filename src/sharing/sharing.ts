import { circlesError, isCircleId, normaliseCategories, type CirclePage, type CirclesError, type CircleStore, type Grant, type Result } from '../circles/index.js';
import { query, type CountOutput, type JsonObject, type JsonValue, type NodesOutput, type StorageAdapter, type SubgraphOutput } from '../graph_store/index.js';
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
const MAX_DATA_CHARS = 4096;
const CUT_STRING = 300;
const MAX_ID_CHARS = 256;
const ITEM_CATEGORIES = 200;
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

/** A person who has shared part of their brain with the caller, and how many of the shared categories still exist. */
export interface SharedBrainView {
  readonly userId: string;
  readonly username?: string;
  readonly displayName?: string;
  readonly categoryCount: number;
}
/** A shared category with the number of items filed under it (all of them: the grant names the category, items come with it). */
export interface SharedCategoryEntry {
  readonly id: string;
  readonly name?: string;
  readonly itemCount: number;
  readonly itemCountCapped?: true;
}
export interface SharedItemView {
  readonly id: string;
  readonly data: JsonObject;
  readonly dataTruncated?: true;
}
export interface SharedCategoryItems {
  readonly category: SharedCategoryView;
  readonly items: readonly SharedItemView[];
  readonly nextCursor: string | null;
}
/** One shared item: only the categories that are shared with the caller are named. */
export interface SharedItemDetail {
  readonly item: SharedItemView;
  readonly categories: ReadonlyArray<SharedCategoryView & { readonly weight: number }>;
}

export interface Sharing {
  /** Who in the circle has shared something with the caller, by user id. Read only. */
  sharedWithMe(token: unknown, circleId: unknown, page?: PageRequest): Promise<Result<Page<SharedBrainView>, CirclesError>>;
  /** The categories `ownerId` shares with the caller, with item counts. */
  sharedCategories(token: unknown, circleId: unknown, ownerId: unknown, page?: PageRequest): Promise<Result<Page<SharedCategoryEntry>, CirclesError>>;
  /** The items under one shared category. */
  sharedCategoryItems(token: unknown, circleId: unknown, ownerId: unknown, categoryId: unknown, page?: PageRequest): Promise<Result<SharedCategoryItems, CirclesError>>;
  /** One item filed under at least one shared category. */
  sharedItem(token: unknown, circleId: unknown, ownerId: unknown, itemId: unknown): Promise<Result<SharedItemDetail, CirclesError>>;
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

  const noBrain = (): CirclesError => circlesError('NOT_FOUND', 'no such shared brain');
  const noCategory = (): CirclesError => circlesError('NOT_FOUND', 'no such category');
  const noItem = (): CirclesError => circlesError('NOT_FOUND', 'no such item');
  const clip = (text: string, max: number): string => [...text].slice(0, max).join('');

  function capData(data: JsonValue | undefined): { data: JsonObject; truncated: boolean } {
    const whole = isObject(data) ? (data as JsonObject) : {};
    if (JSON.stringify(whole).length <= MAX_DATA_CHARS) return { data: whole, truncated: false };
    const cut: JsonObject = {};
    for (const [key, value] of Object.entries(whole)) cut[key] = typeof value === 'string' ? clip(value, CUT_STRING) : value;
    return { data: JSON.stringify(cut).length <= MAX_DATA_CHARS ? cut : {}, truncated: true };
  }
  const itemView = (id: string, data: JsonValue | undefined): SharedItemView => {
    const capped = capData(data);
    return Object.freeze({ id, data: capped.data, ...(capped.truncated ? { dataTruncated: true as const } : {}) });
  };

  /** The grant `ownerId` gave the caller in this circle, as it is right now; one answer for every way of not having one. */
  async function grantFrom(me: { userId: string; circleId: string }, ownerId: unknown): Promise<Result<Grant, CirclesError>> {
    if (!isUserId(ownerId) || ownerId === me.userId) return err(noBrain());
    if ((await store.membershipOf(me.circleId, ownerId)) === undefined) return err(noBrain());
    const grant = await store.getGrant(me.circleId, ownerId, me.userId);
    return grant === undefined || grant.categories.length === 0 ? err(noBrain()) : ok(grant);
  }

  /** A graph read of the owner's graph: a missing graph reads as nothing there. */
  async function read(ownerId: string, input: Record<string, unknown>): Promise<Result<unknown, CirclesError>> {
    const r = await query(graphAdapter, { version: 1, graphId: userGraphId(ownerId), ...input } as never);
    if (r.ok) return ok(r.value);
    if (r.error.code === 'GRAPH_NOT_FOUND') return err(circlesError('NOT_FOUND', 'gone'));
    if (r.error.code === 'VALIDATION_ERROR' && r.error.path?.join('.') === 'page.cursor') return err(circlesError('INVALID_INPUT', 'cursor is not one this service gave for this request', { field: 'cursor' }));
    return err(storageFailure());
  }

  const encodeCursor = (id: string): string => `s${Buffer.from(id, 'utf8').toString('base64url')}`;
  function decodeCursor(cursor: string | null): Result<string | null, CirclesError> {
    if (cursor === null) return ok(null);
    const bad = err(circlesError('INVALID_INPUT', 'that cursor is not one this service gave', { field: 'cursor' }));
    if (cursor.length > 2048 || !/^s[A-Za-z0-9_-]*$/.test(cursor)) return bad;
    const id = Buffer.from(cursor.slice(1), 'base64url').toString('utf8');
    return encodeCursor(id) === cursor ? ok(id) : bad;
  }

  async function listPage<T>(fetch: () => Promise<T>): Promise<Result<T, CirclesError>> {
    try {
      return ok(await fetch());
    } catch (cause) {
      if (cause instanceof RangeError) return err(circlesError('INVALID_INPUT', 'that cursor is not one this service gave', { field: 'cursor' }));
      throw cause;
    }
  }

  return {
    sharedWithMe: (token, circleId, request) =>
      guarded(async () => {
        const me = await memberOf(token, circleId);
        if (!me.ok) return me;
        const page = pageOf(request);
        if (!page.ok) return page;
        const listed = await listPage(() => store.listGrantsTo(me.value.circleId, me.value.userId, page.value));
        if (!listed.ok) return listed;
        const items: SharedBrainView[] = [];
        for (const grant of listed.value.items) {
          const names = await existing(grant.ownerId, grant.categories);
          if (!names.ok) return names;
          const person = await directory.get(grant.ownerId);
          items.push(Object.freeze({ userId: grant.ownerId, ...(person === undefined ? {} : { username: person.username, displayName: person.displayName }), categoryCount: grant.categories.filter((id) => names.value.has(id)).length }));
        }
        return ok(Object.freeze({ items: Object.freeze(items), nextCursor: listed.value.nextCursor }));
      }),

    sharedCategories: (token, circleId, ownerId, request) =>
      guarded(async () => {
        const me = await memberOf(token, circleId);
        if (!me.ok) return me;
        const grant = await grantFrom(me.value, ownerId);
        if (!grant.ok) return grant;
        const page = pageOf(request);
        if (!page.ok) return page;
        const after = decodeCursor(page.value.cursor);
        if (!after.ok) return after;
        const ids = grant.value.categories; // sorted, as the store keeps them
        let pos = after.value === null ? 0 : ids.findIndex((id) => id > (after.value as string));
        if (pos === -1) pos = ids.length;
        const items: SharedCategoryEntry[] = [];
        while (items.length < page.value.limit && pos < ids.length) {
          const chunk = ids.slice(pos, pos + BATCH);
          const names = await existing(grant.value.ownerId, chunk);
          if (!names.ok) return names;
          for (const id of chunk) {
            pos++;
            if (!names.value.has(id)) continue;
            const counted = await read(grant.value.ownerId, { from: { partition: 'category', ids: [id] }, traverse: { depth: 1 }, filter: { partition: 'item' }, return: { shape: 'count' } });
            if (!counted.ok) return counted;
            const { count, truncated } = counted.value as CountOutput;
            const name = names.value.get(id);
            items.push(Object.freeze({ id, ...(name === undefined ? {} : { name }), itemCount: count, ...(truncated ? { itemCountCapped: true as const } : {}) }));
            if (items.length === page.value.limit) break;
          }
        }
        return ok(Object.freeze({ items: Object.freeze(items), nextCursor: pos < ids.length ? encodeCursor(ids[pos - 1] as string) : null }));
      }),

    sharedCategoryItems: (token, circleId, ownerId, categoryId, request) =>
      guarded(async () => {
        const me = await memberOf(token, circleId);
        if (!me.ok) return me;
        const grant = await grantFrom(me.value, ownerId);
        if (!grant.ok) return grant;
        if (typeof categoryId !== 'string' || categoryId === '') return err(circlesError('INVALID_INPUT', 'id must be text', { field: 'id' }));
        const page = pageOf(request);
        if (!page.ok) return page;
        if (categoryId.length > MAX_ID_CHARS || !grant.value.categories.includes(categoryId)) return err(noCategory());
        const there = await existing(grant.value.ownerId, [categoryId]);
        if (!there.ok) return there;
        if (!there.value.has(categoryId)) return err(noCategory());
        const listed = await read(grant.value.ownerId, { from: { partition: 'category', ids: [categoryId] }, traverse: { depth: 1 }, filter: { partition: 'item' }, return: { shape: 'nodes', includeData: true }, page: page.value });
        if (!listed.ok) return listed.error.code === 'NOT_FOUND' ? err(noCategory()) : listed;
        const { nodes, nextCursor } = listed.value as NodesOutput;
        const name = there.value.get(categoryId);
        return ok(Object.freeze({ category: Object.freeze({ id: categoryId, ...(name === undefined ? {} : { name }) }), items: Object.freeze(nodes.filter((n) => n.partition === 'item').map((n) => itemView(n.id, n.data))), nextCursor }));
      }),

    sharedItem: (token, circleId, ownerId, itemId) =>
      guarded(async () => {
        const me = await memberOf(token, circleId);
        if (!me.ok) return me;
        const grant = await grantFrom(me.value, ownerId);
        if (!grant.ok) return grant;
        if (typeof itemId !== 'string' || itemId === '') return err(circlesError('INVALID_INPUT', 'id must be text', { field: 'id' }));
        if (itemId.length > MAX_ID_CHARS) return err(noItem());
        const r = await read(grant.value.ownerId, { from: { partition: 'item', ids: [itemId] }, traverse: { depth: 1 }, return: { shape: 'subgraph', includeData: true }, page: { limit: ITEM_CATEGORIES + 1, cursor: null } });
        if (!r.ok) return r.error.code === 'NOT_FOUND' ? err(noItem()) : r;
        const out = r.value as SubgraphOutput;
        const item = out.nodes.find((n) => n.partition === 'item' && n.id === itemId);
        if (item === undefined) return err(noItem());
        const shared = new Set(grant.value.categories);
        const names = new Map(out.nodes.filter((n) => n.partition === 'category').map((n) => [n.id, nameOf(n.data)] as const));
        const categories = out.edges
          .filter((e) => e.item === itemId && shared.has(e.category))
          .map((e) => {
            const name = names.get(e.category);
            return Object.freeze({ id: e.category, ...(name === undefined ? {} : { name }), weight: e.weight });
          });
        if (categories.length === 0) return err(noItem());
        return ok(Object.freeze({ item: itemView(item.id, item.data), categories: Object.freeze(categories) }));
      }),

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

