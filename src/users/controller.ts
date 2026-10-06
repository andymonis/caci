import { createGraph, err, ok, type Result, type StorageAdapter } from '../graph_store/index.js';
import { usersError, type UsersError } from './errors.js';
import { newUserId, userGraphId } from './ids.js';
import { createPasswordHasher, type PasswordHasher } from './password.js';
import type { SessionStore } from './session-store.js';
import type { UserStore } from './store.js';
import { createLoginThrottle, createRegistrationThrottle, throttledError, type LoginThrottle, type RegistrationThrottle } from './throttle.js';
import type { User } from './types.js';
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

  return {
    graphIdOf: (user) => userGraphId(user.id),

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

    resolve: (token) =>
      guarded(async () => {
        if (typeof token !== 'string') return err(usersError('UNAUTHENTICATED', 'not signed in'));
        const userId = await sessions.resolve(token, clock());
        if (userId === undefined) return err(usersError('UNAUTHENTICATED', 'not signed in'));
        const user = await users.get(userId);
        if (user === undefined) {
          await sessions.revoke(token); // the account is gone: so is the session
          return err(usersError('UNAUTHENTICATED', 'not signed in'));
        }
        return ok({ user, graphId: userGraphId(user.id) });
      }),
  };
}
