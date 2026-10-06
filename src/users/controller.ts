import { createGraph, dropGraph, err, ok, type Result, type StorageAdapter } from '../graph_store/index.js';
import { usersError, type UsersError } from './errors.js';
import { newUserId, userGraphId } from './ids.js';
import { authorise } from './authorise.js';
import { isUserId } from './ids.js';
import { createPasswordHasher, type PasswordHasher } from './password.js';
import type { SessionStore } from './session-store.js';
import type { UserList, UserStore } from './store.js';
import { createLoginThrottle, createRegistrationThrottle, throttledError, type LoginThrottle, type RegistrationThrottle } from './throttle.js';
import type { Role, User } from './types.js';
import { parseDisplayName, parseEmail, parsePassword, parseUsername } from './validate.js';

export interface UserControllerConfig {
  /** `false` closes registration (`FORBIDDEN`); existing accounts are unaffected. Default `true`. */
  readonly allowRegistration?: boolean;
}

export interface UserControllerInit {
  readonly users: UserStore;
  readonly sessions: SessionStore;
  /** Where user graphs live. The controller creates a graph for each account and drops it with the account. */
  readonly graphAdapter: StorageAdapter;
  readonly hasher?: PasswordHasher;
  readonly loginThrottle?: LoginThrottle;
  readonly registrationThrottle?: RegistrationThrottle;
  /** Milliseconds since 1970. */
  readonly clock?: () => number;
  readonly config?: UserControllerConfig;
  /** Makes user ids. Tests replace it. */
  readonly newUserId?: () => string;
}

/** What the caller is: the key throttling counts by (an address, or whatever the API trusts). */
export interface RequestContext {
  readonly clientKey: string;
}

export interface RegisterInput {
  readonly username: unknown;
  readonly displayName: unknown;
  readonly password: unknown;
  readonly email?: unknown;
}

export interface LoginInput {
  readonly username: unknown;
  readonly password: unknown;
}

/** What a person may change about themselves. Not the username, not the role. `email: null` removes the email. */
export interface UpdateMeInput {
  readonly displayName?: unknown;
  readonly email?: unknown;
}

export interface ChangePasswordInput {
  readonly currentPassword: unknown;
  readonly newPassword: unknown;
}

export interface ListUsersInput {
  /** 1 to 200; default 50. */
  readonly limit?: unknown;
  /** The `nextCursor` of the previous page. */
  readonly cursor?: unknown;
}

/** What an admin may change about someone. The username and the id never change. */
export interface UpdateUserInput {
  readonly displayName?: unknown;
  readonly email?: unknown;
  readonly role?: unknown;
}

export interface ResetPasswordInput {
  readonly newPassword: unknown;
}

export interface DeleteMeInput {
  readonly password: unknown;
}

/** A signed-in person: the account, and the one graph that is theirs. */
export interface Authenticated {
  readonly user: User;
  readonly graphId: string;
}

export interface LoggedIn extends Authenticated {
  /** The session token: give it to the client once (a cookie) and never store or log it. */
  readonly token: string;
}

/**
 * Accounts and sessions (R-002, part 1). Methods never throw: every failure is a `UsersError` result,
 * and a failure of a store or the graph store is `STORAGE_ERROR` with a fixed message.
 */
export interface UserController {
  /** Creates the account and its graph together: either both exist afterwards or neither. The first account ever made is the admin. */
  register(input: RegisterInput, context: RequestContext): Promise<Result<User, UsersError>>;
  /** A right password gives a session. A wrong password and an unknown username are the same error. */
  login(input: LoginInput, context: RequestContext): Promise<Result<LoggedIn, UsersError>>;
  /** Ends that session only. Always succeeds, so logging out twice is not an error. */
  logout(token: unknown): Promise<Result<true, UsersError>>;
  /** Who a token belongs to right now, or `UNAUTHENTICATED`. */
  resolve(token: unknown): Promise<Result<Authenticated, UsersError>>;
  /** The caller's own account, from their session. Every method below acts only on the person the token belongs to: there is no user id to give, so none to forge. */
  getMe(token: unknown): Promise<Result<Authenticated, UsersError>>;
  /** Changes the caller's display name and/or email. Anything else in the input (a username, a role) is refused by name. */
  updateMe(token: unknown, input: UpdateMeInput): Promise<Result<User, UsersError>>;
  /** Needs the current password (a wrong one counts toward the throttle), applies the password policy, and ends every OTHER session of the caller. */
  changePassword(token: unknown, input: ChangePasswordInput, context: RequestContext): Promise<Result<User, UsersError>>;
  /** Needs the password. Deletes the caller's graph, then the account and its sessions. If the graph cannot be deleted the account is kept, and the error says so. */
  deleteMe(token: unknown, input: DeleteMeInput, context: RequestContext): Promise<Result<true, UsersError>>;
  /** Admin only: every account, by username, a page at a time. */
  listUsers(token: unknown, input?: ListUsersInput): Promise<Result<UserList, UsersError>>;
  /** An admin may read anyone; a user only themselves (asking about anyone else is `FORBIDDEN`, whether or not that account exists). */
  getUser(token: unknown, userId: unknown): Promise<Result<User, UsersError>>;
  /** An admin may edit anyone's display name, email and role; a user only their own display name and email (never their role). The last admin cannot be demoted. */
  updateUser(token: unknown, userId: unknown, input: UpdateUserInput): Promise<Result<User, UsersError>>;
  /** Admin only: sets a new password (the policy applies), ends all of that user's sessions, and never reveals the old one. */
  resetPassword(token: unknown, userId: unknown, input: ResetPasswordInput): Promise<Result<User, UsersError>>;
  /** Admin only: deletes someone else's account, graph first, then the account and its sessions. Your own account goes through `deleteMe`. */
  deleteUser(token: unknown, userId: unknown): Promise<Result<true, UsersError>>;
  /** The graph of a user. The only way the rest of the system learns which graph to use. */
  graphIdOf(user: Pick<User, 'id'>): string;
}

const STORAGE_MESSAGE = 'the user service could not complete the request';
const unauthenticated = (): UsersError => usersError('UNAUTHENTICATED', 'invalid username or password');
const storageError = (): UsersError => usersError('STORAGE_ERROR', STORAGE_MESSAGE);

export function createUserController(init: UserControllerInit): UserController {
  const { users, sessions, graphAdapter } = init;
  if (users === undefined || sessions === undefined || graphAdapter === undefined) throw new TypeError('createUserController needs users, sessions and graphAdapter');
  const hasher = init.hasher ?? createPasswordHasher();
  const loginThrottle = init.loginThrottle ?? createLoginThrottle();
  const registrationThrottle = init.registrationThrottle ?? createRegistrationThrottle();
  const clock = init.clock ?? Date.now;
  const makeId = init.newUserId ?? newUserId;
  const allowRegistration = init.config?.allowRegistration ?? true;

  /** Never lets an exception out: a store failing becomes a fixed `STORAGE_ERROR`. */
  async function guarded<T>(body: () => Promise<Result<T, UsersError>>): Promise<Result<T, UsersError>> {
    try {
      return await body();
    } catch {
      return err(storageError());
    }
  }

  /** The user's graph exists, created if it is missing (it repairs a registration that stopped between the two steps). `CONFLICT` means it was already there. */
  async function ensureGraph(userId: string): Promise<boolean> {
    const made = await createGraph(graphAdapter, userGraphId(userId));
    return made.ok || made.error.code === 'CONFLICT';
  }

  const notSignedIn = (): UsersError => usersError('UNAUTHENTICATED', 'not signed in');

  async function whoIs(token: unknown): Promise<Result<Authenticated, UsersError>> {
    if (typeof token !== 'string') return err(notSignedIn());
    const userId = await sessions.resolve(token, clock());
    if (userId === undefined) return err(notSignedIn());
    const user = await users.get(userId);
    if (user === undefined) {
      await sessions.revoke(token); // the account is gone: so is the session
      return err(notSignedIn());
    }
    return ok({ user, graphId: userGraphId(user.id) });
  }

  /** Checks a password the caller has just typed for something that matters (changing it, deleting the account), under the login throttle. */
  async function confirmPassword(user: User, password: unknown, field: string, context: RequestContext, now: number): Promise<UsersError | undefined> {
    if (typeof password !== 'string') return usersError('INVALID_INPUT', `${field} must be text`, { field });
    const verdict = loginThrottle.check(user.username, context.clientKey, now);
    if (!verdict.allowed) return throttledError(verdict.retryAfterMs);
    const credential = await users.credentialOf(user.id);
    if (credential === undefined || !(await hasher.verify(password, credential.passwordHash))) {
      loginThrottle.recordFailure(user.username, context.clientKey, now);
      return usersError('INVALID_INPUT', `${field} is incorrect`, { field });
    }
    loginThrottle.recordSuccess(user.username, context.clientKey, now);
    return undefined;
  }

  /** Two admins or more: used before a deletion that would otherwise throw their data away only to be refused. */
  async function hasOtherAdmin(exceptId: string): Promise<boolean> {
    let cursor: string | null = null;
    for (let guard = 0; guard < 10_000; guard++) {
      const page = await users.list({ limit: 200, cursor });
      if (page.items.some((u) => u.role === 'admin' && u.id !== exceptId)) return true;
      cursor = page.nextCursor;
      if (cursor === null) return false;
    }
    return false;
  }

  /**
   * Takes an account away with everything of theirs: the graph first (if it cannot be deleted the account
   * stays, so no data is orphaned), then the account with the store's atomic last-admin guard, then
   * the sessions. Returns the error, or nothing when it is done.
   */
  async function removeAccount(user: User): Promise<UsersError | undefined> {
    const dropped = await dropGraph(graphAdapter, userGraphId(user.id));
    if (!dropped.ok && dropped.error.code !== 'GRAPH_NOT_FOUND') {
      return usersError('STORAGE_ERROR', 'the data could not be deleted, so the account was kept');
    }
    const removed = await users.delete(user.id, { protectLastAdmin: true });
    if (!removed.ok) {
      await ensureGraph(user.id).catch(() => false); // someone else became the only admin meanwhile: give back an (empty) graph
      return removed.error;
    }
    await sessions.revokeAllFor(user.id).catch(() => undefined); // and a lingering session would fail at its next use anyway
    return undefined;
  }

  /** Who is asking and may they do this? Decided before anything about the target is looked up, so a refusal says nothing about whether the target exists. */
  async function authorised(token: unknown, action: Parameters<typeof authorise>[1], targetId?: string): Promise<Result<User, UsersError>> {
    const me = await whoIs(token);
    if (!me.ok) return me;
    if (!authorise(me.value.user, action, targetId)) return err(usersError('FORBIDDEN', 'you may not do that'));
    return ok(me.value.user);
  }

  const idOf = (value: unknown): string | undefined => (isUserId(value) ? value : undefined);
  const noSuchUser = (): UsersError => usersError('NOT_FOUND', 'no such user');

  return {
    graphIdOf: (user) => userGraphId(user.id),

    listUsers: (token, input = {}) =>
      guarded(async () => {
        const me = await authorised(token, 'listUsers');
        if (!me.ok) return me;
        const limit = input.limit === undefined ? 50 : input.limit;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) return err(usersError('INVALID_INPUT', 'limit must be a whole number from 1 to 200', { field: 'limit' }));
        const cursor = input.cursor === undefined ? null : input.cursor;
        if (cursor !== null && typeof cursor !== 'string') return err(usersError('INVALID_INPUT', 'cursor must be text', { field: 'cursor' }));
        try {
          return ok(await users.list({ limit, cursor }));
        } catch (cause) {
          if (cause instanceof RangeError) return err(usersError('INVALID_INPUT', 'cursor is not one this service gave', { field: 'cursor' }));
          throw cause;
        }
      }),

    getUser: (token, userId) =>
      guarded(async () => {
        const me = await authorised(token, 'getUser', typeof userId === 'string' ? userId : undefined);
        if (!me.ok) return me;
        const id = idOf(userId);
        const user = id === undefined ? undefined : await users.get(id);
        return user === undefined ? err(noSuchUser()) : ok(user);
      }),

    updateUser: (token, userId, input) =>
      guarded(async () => {
        const target = typeof userId === 'string' ? userId : undefined;
        const me = await authorised(token, 'updateUser', target);
        if (!me.ok) return me;
        for (const key of Object.keys(input ?? {})) {
          if (key !== 'displayName' && key !== 'email' && key !== 'role') return err(usersError('INVALID_INPUT', `${key} cannot be changed`, { field: key }));
        }
        if (input.role !== undefined) {
          // a role change is its own action: a user never gets it, not even on themselves, and then nothing at all is changed
          const allowed = await authorised(token, 'changeRole', target);
          if (!allowed.ok) return allowed;
          if (input.role !== 'user' && input.role !== 'admin') return err(usersError('INVALID_INPUT', 'role must be "user" or "admin"', { field: 'role' }));
        }
        if (input.displayName === undefined && input.email === undefined && input.role === undefined) return err(usersError('INVALID_INPUT', 'nothing to change', { field: 'displayName' }));
        let displayName: string | undefined;
        if (input.displayName !== undefined) {
          const parsed = parseDisplayName(input.displayName);
          if (!parsed.ok) return parsed;
          displayName = parsed.value;
        }
        let email: string | null | undefined;
        if (input.email === null) email = null;
        else if (input.email !== undefined) {
          const parsed = parseEmail(input.email);
          if (!parsed.ok) return parsed;
          email = parsed.value ?? null;
        }
        const id = idOf(userId);
        if (id === undefined) return err(noSuchUser());
        return users.update(id, { ...(displayName === undefined ? {} : { displayName }), ...(email === undefined ? {} : { email }), ...(input.role === undefined ? {} : { role: input.role as Role }), updatedAt: clock() }, { protectLastAdmin: true });
      }),

    resetPassword: (token, userId, input) =>
      guarded(async () => {
        const me = await authorised(token, 'resetPassword', typeof userId === 'string' ? userId : undefined);
        if (!me.ok) return me;
        const id = idOf(userId);
        const target = id === undefined ? undefined : await users.get(id);
        if (target === undefined) return err(noSuchUser());
        const fresh = parsePassword(input?.newPassword, { username: target.username });
        if (!fresh.ok) return err({ ...fresh.error, field: 'newPassword' });
        const updated = await users.update(target.id, { passwordHash: await hasher.hash(fresh.value), updatedAt: clock() });
        if (!updated.ok) return updated;
        try {
          // everything they were signed in on ends; an admin resetting their own password keeps the session they are using
          await sessions.revokeAllFor(target.id, target.id === me.value.id && typeof token === 'string' ? { except: token } : {});
        } catch {
          return err(usersError('STORAGE_ERROR', 'the password was changed, but the sessions could not be ended'));
        }
        return updated;
      }),

    deleteUser: (token, userId) =>
      guarded(async () => {
        const me = await authorised(token, 'deleteUser', typeof userId === 'string' ? userId : undefined);
        if (!me.ok) return me;
        const id = idOf(userId);
        const target = id === undefined ? undefined : await users.get(id);
        if (target === undefined) return err(noSuchUser());
        if (target.id === me.value.id) return err(usersError('INVALID_INPUT', 'to delete your own account use deleteMe, which asks for your password', { field: 'userId' }));
        const failed = await removeAccount(target);
        return failed === undefined ? ok(true as const) : err(failed);
      }),

    getMe: (token) => guarded(() => whoIs(token)),

    updateMe: (token, input) =>
      guarded(async () => {
        const me = await whoIs(token);
        if (!me.ok) return me;
        for (const key of Object.keys(input ?? {})) {
          if (key !== 'displayName' && key !== 'email') return err(usersError('INVALID_INPUT', `${key} cannot be changed here`, { field: key }));
        }
        if (input.displayName === undefined && input.email === undefined) return err(usersError('INVALID_INPUT', 'nothing to change: give displayName or email', { field: 'displayName' }));
        let displayName: string | undefined;
        if (input.displayName !== undefined) {
          const parsed = parseDisplayName(input.displayName);
          if (!parsed.ok) return parsed;
          displayName = parsed.value;
        }
        let email: string | null | undefined;
        if (input.email === null) email = null;
        else if (input.email !== undefined) {
          const parsed = parseEmail(input.email);
          if (!parsed.ok) return parsed;
          email = parsed.value ?? null;
        }
        return users.update(me.value.user.id, { ...(displayName === undefined ? {} : { displayName }), ...(email === undefined ? {} : { email }), updatedAt: clock() });
      }),

    changePassword: (token, input, context) =>
      guarded(async () => {
        const me = await whoIs(token);
        if (!me.ok) return me;
        const now = clock();
        const wrong = await confirmPassword(me.value.user, input.currentPassword, 'currentPassword', context, now);
        if (wrong !== undefined) return err(wrong);
        const fresh = parsePassword(input.newPassword, { username: me.value.user.username });
        if (!fresh.ok) return err({ ...fresh.error, field: 'newPassword' });
        if (fresh.value === (input.currentPassword as string).normalize('NFKC')) return err(usersError('INVALID_INPUT', 'the new password must be different from the current one', { field: 'newPassword' }));
        const updated = await users.update(me.value.user.id, { passwordHash: await hasher.hash(fresh.value), updatedAt: now });
        if (!updated.ok) return updated;
        try {
          await sessions.revokeAllFor(me.value.user.id, { except: token as string });
        } catch {
          return err(usersError('STORAGE_ERROR', 'the password was changed, but your other sessions could not be ended'));
        }
        return updated;
      }),

    deleteMe: (token, input, context) =>
      guarded(async () => {
        const me = await whoIs(token);
        if (!me.ok) return me;
        const { user } = me.value;
        const wrong = await confirmPassword(user, input.password, 'password', context, clock());
        if (wrong !== undefined) return err(wrong);
        // the last admin is refused before any data is touched
        if (user.role === 'admin' && !(await hasOtherAdmin(user.id))) return err(usersError('LAST_ADMIN', 'the last admin cannot delete their own account'));

        const failed = await removeAccount(user);
        if (failed !== undefined) return err(failed);
        return ok(true as const);
      }),

    register: (input, context) =>
      guarded(async () => {
        if (!allowRegistration) return err(usersError('FORBIDDEN', 'registration is closed'));
        const now = clock();
        const verdict = registrationThrottle.check(context.clientKey, now);
        if (!verdict.allowed) return err(throttledError(verdict.retryAfterMs));
        registrationThrottle.record(context.clientKey, now); // every attempt counts, whether or not it works

        const username = parseUsername(input.username);
        if (!username.ok) return username;
        const displayName = parseDisplayName(input.displayName);
        if (!displayName.ok) return displayName;
        const email = parseEmail(input.email);
        if (!email.ok) return email;
        const password = parsePassword(input.password, { username: username.value });
        if (!password.ok) return password;

        const passwordHash = await hasher.hash(password.value);
        let created: Result<User, UsersError> | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          created = await users.create(
            { id: makeId(), username: username.value, displayName: displayName.value, ...(email.value === undefined ? {} : { email: email.value }), role: 'user', passwordHash, createdAt: now },
            { adminIfFirst: true },
          );
          if (created.ok || created.error.field !== 'id') break; // a taken id is the only thing worth a second draw
        }
        if (created === undefined || !created.ok) return created ?? err(storageError());

        const user = created.value;
        if (!(await ensureGraph(user.id).catch(() => false))) {
          // either both exist or neither: take the account back out
          await users.delete(user.id).catch(() => undefined);
          return err(storageError());
        }
        return ok(user);
      }),

    login: (input, context) =>
      guarded(async () => {
        if (typeof input.username !== 'string') return err(usersError('INVALID_INPUT', 'username must be text', { field: 'username' }));
        if (typeof input.password !== 'string') return err(usersError('INVALID_INPUT', 'password must be text', { field: 'password' }));
        const now = clock();
        const verdict = loginThrottle.check(input.username, context.clientKey, now);
        if (!verdict.allowed) return err(throttledError(verdict.retryAfterMs)); // not recorded: hammering must not lengthen the hold

        const credential = await users.credentialByUsername(input.username);
        const right = credential === undefined ? await hasher.verifyAbsent(input.password) : await hasher.verify(input.password, credential.passwordHash);
        if (credential === undefined || !right) {
          loginThrottle.recordFailure(input.username, context.clientKey, now);
          return err(unauthenticated());
        }
        loginThrottle.recordSuccess(input.username, context.clientKey, now);

        if (hasher.needsRehash(credential.passwordHash)) {
          // quietly bring an old hash up to the current cost; the login does not depend on it
          await hasher
            .hash(input.password)
            .then((passwordHash) => users.update(credential.user.id, { passwordHash, updatedAt: credential.user.updatedAt }))
            .catch(() => undefined);
        }
        if (!(await ensureGraph(credential.user.id))) return err(storageError());
        const token = await sessions.create(credential.user.id, now);
        return ok({ user: credential.user, graphId: userGraphId(credential.user.id), token });
      }),

    logout: (token) =>
      guarded(async () => {
        if (typeof token === 'string') await sessions.revoke(token);
        return ok(true as const);
      }),

    resolve: (token) => guarded(() => whoIs(token)),
  };
}
