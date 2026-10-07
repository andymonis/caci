import { createRegistrationThrottle as createWindowLimiter, type Authenticated, type UserController, type UserStore } from '../users/index.js';
import { authorise } from './authorise.js';
import { newCircleId, newInvitationId } from './ids.js';
import { circlesError, type CirclesError } from './errors.js';
import { err, ok, type Result } from './result.js';
import type { CirclePage, CircleStore, CircleSummary, Invitation, Membership } from './store.js';
import type { Circle, CircleRole } from './types.js';
import { parseCreateCircle, parseInvite, parseRoleChange, parseUpdateCircle } from './validate.js';

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

/** An open invitation as owners and managers of the circle see it. */
export interface InvitationView {
  readonly id: string;
  /** Who it is addressed to. */
  readonly username: string;
  readonly role: CircleRole;
  readonly invitedBy: { readonly userId: string; readonly displayName?: string };
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** An invitation as the person it is addressed to sees it: enough to decide, nothing more. */
export interface MyInvitationView {
  readonly id: string;
  readonly circle: { readonly id: string; readonly name: string };
  readonly role: CircleRole;
  readonly invitedBy: { readonly displayName?: string };
  readonly createdAt: number;
  readonly expiresAt: number;
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
  /** How many people one circle may hold. Default 50. */
  readonly maxMembersPerCircle?: number;
  /** How many invitations one circle may have open. Default 50. */
  readonly maxOpenInvitationsPerCircle?: number;
  /** How many invitations one person may send in an hour. Default 30. */
  readonly invitationsPerHour?: number;
  /** How long an invitation stays open. Default 7. */
  readonly invitationDays?: number;
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
  /** Makes invitation ids. Tests only. */
  readonly newInvitationId?: () => string;
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

  /**
   * Owners and managers invite a username with a role they may give. The answer is `{ invited: true }`
   * for every target (an account that exists, one that does not, a person already in, a repeat), and the
   * controller looks nobody up, so nothing here can be used to find out who has an account.
   */
  invite(token: unknown, circleId: unknown, input: unknown): Promise<Result<{ readonly invited: true }, CirclesError>>;
  /** The circle's open invitations (owners and managers). */
  invitations(token: unknown, circleId: unknown, page?: PageRequest): Promise<Result<Page<InvitationView>, CirclesError>>;
  /** Withdraws an open invitation of this circle, if the caller may give that role. */
  revokeInvitation(token: unknown, circleId: unknown, invitationId: unknown): Promise<Result<true, CirclesError>>;
  /** The open invitations addressed to the caller's username. */
  myInvitations(token: unknown, page?: PageRequest): Promise<Result<Page<MyInvitationView>, CirclesError>>;
  /** Joins the circle with the offered role. Anything but the caller's own open invitation is `NOT_FOUND`. */
  accept(token: unknown, invitationId: unknown): Promise<Result<CircleView, CirclesError>>;
  decline(token: unknown, invitationId: unknown): Promise<Result<true, CirclesError>>;

  /**
   * Owners change anyone else's role to any role; managers only move a `member` or `observer` between those
   * two. Nobody changes their own role. `{ role }`. Returns the person as the roster shows them.
   */
  changeRole(token: unknown, circleId: unknown, userId: unknown, input: unknown): Promise<Result<MemberView, CirclesError>>;
  /** Owners remove anyone else but the last owner; managers only a `member` or `observer`. Leaving is `leave`. */
  removeMember(token: unknown, circleId: unknown, userId: unknown): Promise<Result<true, CirclesError>>;
}

export const DEFAULT_CIRCLE_LIMITS = Object.freeze({ maxCirclesPerUser: 20, maxMembersPerCircle: 50, maxOpenInvitationsPerCircle: 50, invitationsPerHour: 30, invitationDays: 7 });
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
const ID_ATTEMPTS = 3;

const STORAGE = 'the circle service could not complete the request';
const notFound = (): CirclesError => circlesError('NOT_FOUND', 'no such circle');
const noMember = (): CirclesError => circlesError('NOT_FOUND', 'no such member');
const noInvitation = (): CirclesError => circlesError('NOT_FOUND', 'no such invitation');
const INVITED = Object.freeze({ invited: true as const });
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
  const maxMembers = whole(init.limits?.maxMembersPerCircle, DEFAULT_CIRCLE_LIMITS.maxMembersPerCircle, 'maxMembersPerCircle');
  const maxInvitations = whole(init.limits?.maxOpenInvitationsPerCircle, DEFAULT_CIRCLE_LIMITS.maxOpenInvitationsPerCircle, 'maxOpenInvitationsPerCircle');
  const perHour = whole(init.limits?.invitationsPerHour, DEFAULT_CIRCLE_LIMITS.invitationsPerHour, 'invitationsPerHour');
  const invitationDays = whole(init.limits?.invitationDays, DEFAULT_CIRCLE_LIMITS.invitationDays, 'invitationDays');
  const hourly = createWindowLimiter({ max: perHour, windowMs: HOUR_MS });
  const clock = init.clock ?? Date.now;
  const makeId = init.newCircleId ?? (() => newCircleId());
  const makeInvitationId = init.newInvitationId ?? (() => newInvitationId());
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

  interface Who {
    readonly id: string;
    readonly username: string;
  }
  async function whoIs(token: unknown): Promise<Result<Who, CirclesError>> {
    let resolved: Awaited<ReturnType<UserController['resolve']>>;
    try {
      resolved = await users.resolve(token);
    } catch {
      return err(storageFailure());
    }
    if (resolved.ok) {
      const { user } = resolved.value as Authenticated;
      return ok({ id: user.id, username: user.username });
    }
    return err(resolved.error.code === 'UNAUTHENTICATED' ? circlesError('UNAUTHENTICATED', 'not signed in') : storageFailure());
  }

  /** The caller and their membership of the circle, or the one answer for "no such circle". */
  async function member(token: unknown, circleId: unknown): Promise<Result<{ userId: string; circleId: string; role: CircleRole }, CirclesError>> {
    const who = await whoIs(token);
    if (!who.ok) return who;
    if (typeof circleId !== 'string' || circleId === '') return err(notFound());
    const membership = await store.membershipOf(circleId, who.value.id);
    if (membership === undefined) return err(notFound());
    return ok({ userId: who.value.id, circleId, role: membership.role });
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

  const LAST_OWNER = 'a circle must keep an owner: make someone else an owner first, or delete the circle';
  async function memberView(membership: Membership): Promise<MemberView> {
    const person = await directory.get(membership.userId);
    return Object.freeze({ userId: membership.userId, ...(person === undefined ? {} : { username: person.username, displayName: person.displayName }), role: membership.role, joinedAt: membership.joinedAt });
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
          const made = await store.createCircle({ id: makeId(), name: parsed.value.name, ...(parsed.value.description === undefined ? {} : { description: parsed.value.description }), createdAt }, who.value.id, { maxCirclesPerUser: maxCircles });
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
          const listed = await store.listCirclesOf(who.value.id, p.value);
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
        for (const membership of listed.items) items.push(await memberView(membership));
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

    invite: (token, circleId, input) =>
      guarded(async () => {
        const m = await member(token, circleId);
        if (!m.ok) return m;
        // owners and managers may invite at all; which roles they may give depends on the input, so that comes next
        if (!authorise(m.value.role, 'invite', { role: 'member' })) return err(forbidden());
        const parsed = parseInvite(input);
        if (!parsed.ok) return parsed;
        if (!authorise(m.value.role, 'invite', { role: parsed.value.role })) return err(forbidden());
        const now = clock();
        const wait = hourly.check(m.value.userId, now);
        if (!wait.allowed) return err(circlesError('THROTTLED', `you have sent the most invitations allowed in an hour (${perHour})`, { retryAfterMs: wait.retryAfterMs }));
        hourly.record(m.value.userId, now);
        // nobody is looked up: the invitation is stored for the name whether or not an account has it
        for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
          const made = await store.createInvitation(
            { id: makeInvitationId(), circleId: m.value.circleId, username: parsed.value.username, role: parsed.value.role, invitedBy: m.value.userId, createdAt: now, expiresAt: now + invitationDays * DAY_MS },
            { maxOpenInvitationsPerCircle: maxInvitations },
            now,
          );
          if (made.ok) return ok(INVITED);
          if (made.error.code === 'NOT_FOUND') return err(notFound());
          if (made.error.code !== 'CONFLICT') return made;
        }
        return err(storageFailure());
      }),

    invitations: (token, circleId, page) =>
      guarded(async () => {
        const m = await member(token, circleId);
        if (!m.ok) return m;
        if (!authorise(m.value.role, 'invite', { role: 'member' })) return err(forbidden());
        const p = pageOf(page);
        if (!p.ok) return p;
        let listed: { items: readonly Invitation[]; nextCursor: string | null };
        try {
          listed = await store.listInvitationsOfCircle(m.value.circleId, clock(), p.value);
        } catch (cause) {
          if (cause instanceof RangeError) return err(badCursor());
          throw cause;
        }
        const items: InvitationView[] = [];
        for (const i of listed.items) {
          const person = await directory.get(i.invitedBy);
          items.push(Object.freeze({ id: i.id, username: i.username, role: i.role, invitedBy: Object.freeze({ userId: i.invitedBy, ...(person === undefined ? {} : { displayName: person.displayName }) }), createdAt: i.createdAt, expiresAt: i.expiresAt }));
        }
        return ok(Object.freeze({ items: Object.freeze(items), nextCursor: listed.nextCursor }));
      }),

    revokeInvitation: (token, circleId, invitationId) =>
      guarded(async () => {
        const m = await member(token, circleId);
        if (!m.ok) return m;
        if (!authorise(m.value.role, 'revokeInvitation', { role: 'member' })) return err(forbidden());
        if (typeof invitationId !== 'string' || invitationId === '') return err(noInvitation());
        const invitation = await store.getInvitation(invitationId);
        if (invitation === undefined || invitation.circleId !== m.value.circleId) return err(noInvitation());
        if (!authorise(m.value.role, 'revokeInvitation', { role: invitation.role })) return err(forbidden());
        const revoked = await store.revokeInvitation(invitationId, m.value.circleId, clock());
        return revoked ? ok(true as const) : err(noInvitation());
      }),

    myInvitations: (token, page) =>
      guarded(async () => {
        const who = await whoIs(token);
        if (!who.ok) return who;
        const p = pageOf(page);
        if (!p.ok) return p;
        let listed: { items: readonly Invitation[]; nextCursor: string | null };
        try {
          listed = await store.listInvitationsFor(who.value.username, clock(), p.value);
        } catch (cause) {
          if (cause instanceof RangeError) return err(badCursor());
          throw cause;
        }
        const items: MyInvitationView[] = [];
        for (const i of listed.items) {
          const circle = await store.getCircle(i.circleId);
          if (circle === undefined) continue;
          const person = await directory.get(i.invitedBy);
          items.push(Object.freeze({ id: i.id, circle: Object.freeze({ id: circle.id, name: circle.name }), role: i.role, invitedBy: Object.freeze(person === undefined ? {} : { displayName: person.displayName }), createdAt: i.createdAt, expiresAt: i.expiresAt }));
        }
        return ok(Object.freeze({ items: Object.freeze(items), nextCursor: listed.nextCursor }));
      }),

    accept: (token, invitationId) =>
      guarded(async () => {
        const who = await whoIs(token);
        if (!who.ok) return who;
        if (typeof invitationId !== 'string' || invitationId === '') return err(noInvitation());
        const joined = await store.acceptInvitation(invitationId, who.value.id, who.value.username, clock(), { maxCirclesPerUser: maxCircles, maxMembersPerCircle: maxMembers });
        if (!joined.ok) return joined.error.code === 'NOT_FOUND' ? err(noInvitation()) : joined;
        const circle = await store.getCircle(joined.value.circleId);
        if (circle === undefined) return err(noInvitation());
        return ok(view(circle, joined.value.role, await countMembers(circle.id)));
      }),

    decline: (token, invitationId) =>
      guarded(async () => {
        const who = await whoIs(token);
        if (!who.ok) return who;
        if (typeof invitationId !== 'string' || invitationId === '') return err(noInvitation());
        return (await store.declineInvitation(invitationId, who.value.username, clock())) ? ok(true as const) : err(noInvitation());
      }),

    changeRole: (token, circleId, userId, input) =>
      guarded(async () => {
        const m = await member(token, circleId);
        if (!m.ok) return m;
        // owners and managers may change roles at all; which changes depends on who and to what, so that comes next
        if (!authorise(m.value.role, 'changeRole', { target: 'member', role: 'member', self: false })) return err(forbidden());
        const parsed = parseRoleChange(input);
        if (!parsed.ok) return parsed;
        if (typeof userId !== 'string' || userId === '') return err(noMember());
        const target = await store.membershipOf(m.value.circleId, userId);
        if (target === undefined) return err(noMember());
        if (userId === m.value.userId) return err(circlesError('FORBIDDEN', 'nobody changes their own role: ask another owner'));
        if (!authorise(m.value.role, 'changeRole', { target: target.role, role: parsed.value, self: false })) return err(forbidden());
        const changed = await store.changeRole(m.value.circleId, userId, parsed.value);
        if (!changed.ok) {
          if (changed.error.code === 'LAST_OWNER') return err(circlesError('LAST_OWNER', LAST_OWNER));
          return changed.error.code === 'NOT_FOUND' ? err(noMember()) : changed;
        }
        return ok(await memberView(changed.value));
      }),

    removeMember: (token, circleId, userId) =>
      guarded(async () => {
        const m = await member(token, circleId);
        if (!m.ok) return m;
        if (!authorise(m.value.role, 'removeMember', { target: 'member', self: false })) return err(forbidden());
        if (typeof userId !== 'string' || userId === '') return err(noMember());
        const target = await store.membershipOf(m.value.circleId, userId);
        if (target === undefined) return err(noMember());
        if (userId === m.value.userId) return err(circlesError('FORBIDDEN', 'to leave a circle, leave it; nobody removes themselves'));
        if (!authorise(m.value.role, 'removeMember', { target: target.role, self: false })) return err(forbidden());
        const removed = await store.removeMember(m.value.circleId, userId);
        if (!removed.ok) return removed.error.code === 'LAST_OWNER' ? err(circlesError('LAST_OWNER', LAST_OWNER)) : removed;
        return removed.value ? ok(true as const) : err(noMember());
      }),
  };
}
