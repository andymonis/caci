import type { Authenticated, UserController, UserStore } from '../users/index.js';
import { authorise } from './authorise.js';
import { newCircleId } from './ids.js';
import { circlesError, type CirclesError } from './errors.js';
import { err, ok, type Result } from './result.js';
import type { CirclePage, CircleStore, CircleSummary, Membership } from './store.js';
import type { Circle, CircleRole } from './types.js';
import { parseCreateCircle, parseUpdateCircle } from './validate.js';

/** A circle as a signed-in member sees it: with their own role and how many people are in it. */
export interface CircleView {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The caller's role in it. */
  readonly role: CircleRole;
  readonly memberCount: number;
}

/** One person in a circle: names for people to recognise them by, never an email, a hash or a graph. */
export interface MemberView {
  readonly userId: string;
  readonly username?: string;
  readonly displayName?: string;
  readonly role: CircleRole;
  readonly joinedAt: number;
}

export interface PageRequest {
  readonly limit?: number;
  readonly cursor?: string | null;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface CircleControllerLimits {
  /** How many circles one person may be in. Default 20. */
  readonly maxCirclesPerUser?: number;
}

export interface CircleControllerInit {
  /** Only the session check is used. */
  readonly users: Pick<UserController, 'resolve'>;
  /** Only `get` is used, to put names to user ids; only a username and a display name are ever shown. */
  readonly directory: Pick<UserStore, 'get'>;
  readonly store: CircleStore;
  readonly limits?: CircleControllerLimits;
  /** Milliseconds since 1970. */
  readonly clock?: () => number;
  /** Makes circle ids. Tests only. */
  readonly newCircleId?: () => string;
}

/**
 * Circles and their rosters (R-004). Every method takes the session token and acts only for the person
 * it belongs to; none takes a user id for the caller. Someone who is not a member of a circle gets
 * exactly the answer for a circle that does not exist. The caller's role is read from the store on
 * every request, so a demotion takes effect at once.
 */
export interface CircleController {
  create(token: unknown, input: unknown): Promise<Result<CircleView, CirclesError>>;
  get(token: unknown, circleId: unknown): Promise<Result<CircleView, CirclesError>>;
  /** The circles the caller is in, by id, a page at a time. */
  list(token: unknown, page?: PageRequest): Promise<Result<Page<CircleView>, CirclesError>>;
  /** Owners and managers. `{ name?, description? }`; `description: null` removes it. */
  update(token: unknown, circleId: unknown, input: unknown): Promise<Result<CircleView, CirclesError>>;
  /** Owners only. Removes the circle, its members and its invitations. */
  delete(token: unknown, circleId: unknown): Promise<Result<true, CirclesError>>;
  members(token: unknown, circleId: unknown, page?: PageRequest): Promise<Result<Page<MemberView>, CirclesError>>;
  /** Anyone may leave, except the only owner (`LAST_OWNER`). */
  leave(token: unknown, circleId: unknown): Promise<Result<true, CirclesError>>;
}

export const DEFAULT_CIRCLE_LIMITS = Object.freeze({ maxCirclesPerUser: 20 });
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
const ID_ATTEMPTS = 3;

const STORAGE = 'the circle service could not complete the request';
const notFound = (): CirclesError => circlesError('NOT_FOUND', 'no such circle');
const forbidden = (): CirclesError => circlesError('FORBIDDEN', 'your role in this circle does not allow that');

function whole(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`createCircleController: ${name} must be a positive whole number`);
  return value;
}

export function createCircleController(init: CircleControllerInit): CircleController {
  if (typeof init?.users?.resolve !== 'function' || typeof init.directory?.get !== 'function' || init.store === undefined) {
    throw new TypeError('createCircleController needs a user controller (resolve), a directory (get) and a circle store');
  }
  const { users, directory, store } = init;
  const maxCircles = whole(init.limits?.maxCirclesPerUser, DEFAULT_CIRCLE_LIMITS.maxCirclesPerUser, 'maxCirclesPerUser');
  const clock = init.clock ?? Date.now;
  const makeId = init.newCircleId ?? (() => newCircleId());
  const storageFailure = (): CirclesError => circlesError('STORAGE_ERROR', STORAGE);

  /** Runs `body`; anything it throws is a storage failure with a fixed message (never the thrown text). */
  async function guarded<T>(body: () => Promise<Result<T, CirclesError>>): Promise<Result<T, CirclesError>> {
    try {
      const result = await body();
      // a store's own storage failure may carry a path or a lock message: say the same fixed thing for all of them
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

  /** The caller and their membership of the circle, or the one answer for "no such circle". */
  async function member(token: unknown, circleId: unknown): Promise<Result<{ userId: string; circleId: string; role: CircleRole }, CirclesError>> {
    const who = await whoIs(token);
    if (!who.ok) return who;
    if (typeof circleId !== 'string' || circleId === '') return err(notFound());
    const membership = await store.membershipOf(circleId, who.value);
    if (membership === undefined) return err(notFound());
    return ok({ userId: who.value, circleId, role: membership.role });
  }

  async function countMembers(circleId: string): Promise<number> {
    let total = 0;
    let cursor: string | null = null;
    for (let guard = 0; guard < 1000; guard++) {
      const page = await store.listMembers(circleId, { limit: MAX_PAGE_SIZE, cursor });
      total += page.items.length;
      cursor = page.nextCursor;
      if (cursor === null) return total;
    }
    return total;
  }

  const view = (circle: Circle, role: CircleRole, memberCount: number): CircleView =>
    Object.freeze({ id: circle.id, name: circle.name, ...(circle.description === undefined ? {} : { description: circle.description }), createdAt: circle.createdAt, updatedAt: circle.updatedAt, role, memberCount });
  const summaryView = (s: CircleSummary): CircleView => view(s.circle, s.role, s.memberCount);

  function pageOf(request: PageRequest | undefined): Result<CirclePage, CirclesError> {
    const limit = request?.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return err(circlesError('INVALID_INPUT', `limit must be a whole number from 1 to ${MAX_PAGE_SIZE}`, { field: 'limit' }));
    const cursor = request?.cursor ?? null;
    if (cursor !== null && typeof cursor !== 'string') return err(circlesError('INVALID_INPUT', 'cursor must be text', { field: 'cursor' }));
    return ok({ limit, cursor });
  }
  const badCursor = (): CirclesError => circlesError('INVALID_INPUT', 'that cursor is not one this service gave', { field: 'cursor' });

  return {
    create: (token, input) =>
      guarded(async () => {
        const who = await whoIs(token);
        if (!who.ok) return who;
        const parsed = parseCreateCircle(input);
        if (!parsed.ok) return parsed;
        for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
          const createdAt = clock();
          const made = await store.createCircle({ id: makeId(), name: parsed.value.name, ...(parsed.value.description === undefined ? {} : { description: parsed.value.description }), createdAt }, who.value, { maxCirclesPerUser: maxCircles });
          if (made.ok) return ok(view(made.value, 'owner', 1));
          if (made.error.code !== 'CONFLICT') return made;
        }
        return err(storageFailure());
      }),

    get: (token, circleId) =>
      guarded(async () => {
        const m = await member(token, circleId);
        if (!m.ok) return m;
        const circle = await store.getCircle(m.value.circleId);
        if (circle === undefined) return err(notFound());
        return ok(view(circle, m.value.role, await countMembers(circle.id)));
      }),

    list: (token, page) =>
      guarded(async () => {
        const who = await whoIs(token);
        if (!who.ok) return who;
        const p = pageOf(page);
        if (!p.ok) return p;
        try {
          const listed = await store.listCirclesOf(who.value, p.value);
          return ok(Object.freeze({ items: Object.freeze(listed.items.map(summaryView)), nextCursor: listed.nextCursor }));
        } catch (cause) {
          if (cause instanceof RangeError) return err(badCursor());
          throw cause;
        }
      }),

    update: (token, circleId, input) =>
      guarded(async () => {
        const m = await member(token, circleId);
        if (!m.ok) return m;
        if (!authorise(m.value.role, 'updateCircle')) return err(forbidden());
        const parsed = parseUpdateCircle(input);
        if (!parsed.ok) return parsed;
        const updated = await store.updateCircle(m.value.circleId, { ...parsed.value, updatedAt: clock() });
        if (!updated.ok) return updated.error.code === 'NOT_FOUND' ? err(notFound()) : updated;
        return ok(view(updated.value, m.value.role, await countMembers(m.value.circleId)));
      }),

    delete: (token, circleId) =>
      guarded(async () => {
        const m = await member(token, circleId);
        if (!m.ok) return m;
        if (!authorise(m.value.role, 'deleteCircle')) return err(forbidden());
        await store.deleteCircle(m.value.circleId);
        return ok(true as const);
      }),

    members: (token, circleId, page) =>
      guarded(async () => {
        const m = await member(token, circleId);
        if (!m.ok) return m;
        if (!authorise(m.value.role, 'listMembers')) return err(forbidden());
        const p = pageOf(page);
        if (!p.ok) return p;
        let listed: { items: readonly Membership[]; nextCursor: string | null };
        try {
          listed = await store.listMembers(m.value.circleId, p.value);
        } catch (cause) {
          if (cause instanceof RangeError) return err(badCursor());
          throw cause;
        }
        const items: MemberView[] = [];
        for (const membership of listed.items) {
          const person = await directory.get(membership.userId);
          items.push(Object.freeze({ userId: membership.userId, ...(person === undefined ? {} : { username: person.username, displayName: person.displayName }), role: membership.role, joinedAt: membership.joinedAt }));
        }
        return ok(Object.freeze({ items: Object.freeze(items), nextCursor: listed.nextCursor }));
      }),

    leave: (token, circleId) =>
      guarded(async () => {
        const m = await member(token, circleId);
        if (!m.ok) return m;
        if (!authorise(m.value.role, 'leave')) return err(forbidden());
        const left = await store.removeMember(m.value.circleId, m.value.userId);
        if (!left.ok) {
          return err(left.error.code === 'LAST_OWNER' ? circlesError('LAST_OWNER', 'you are the only owner: make someone else an owner, or delete the circle') : left.error);
        }
        return ok(true as const);
      }),
  };
}
