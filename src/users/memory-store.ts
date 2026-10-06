import { err, ok, type Result } from '../graph_store/index.js';
import { checkLimit, decodeCursor, encodeCursor } from './cursor.js';
import { usersError, type UsersError } from './errors.js';
import type { Credential, CreateOptions, GuardOptions, UserList, UserPage, UserPatch, UserRecord, UserStore } from './store.js';
import type { User } from './types.js';

interface Stored {
  readonly user: User;
  readonly passwordHash: string;
}

const copy = (user: User): User => ({ ...user });

/**
 * The reference user store: in memory, for tests and as the model the SQLite store must match.
 * Every method runs to completion without awaiting, so no two calls interleave and each is atomic.
 */
export function createMemoryUserStore(): UserStore {
  const byId = new Map<string, Stored>();
  const idOfUsername = new Map<string, string>();

  const admins = (): number => [...byId.values()].filter((s) => s.user.role === 'admin').length;
  const credential = (stored: Stored | undefined): Credential | undefined => (stored === undefined ? undefined : { user: copy(stored.user), passwordHash: stored.passwordHash });
  const byUsername = (username: string): Stored | undefined => {
    const id = idOfUsername.get(username.toLowerCase());
    return id === undefined ? undefined : byId.get(id);
  };

  return {
    create: async (record: UserRecord, options: CreateOptions = {}): Promise<Result<User, UsersError>> => {
      const username = record.username.toLowerCase();
      if (idOfUsername.has(username)) return err(usersError('CONFLICT', 'that username is taken', { field: 'username' }));
      if (byId.has(record.id)) return err(usersError('CONFLICT', 'that user id already exists', { field: 'id' }));
      const role = options.adminIfFirst === true && byId.size === 0 ? 'admin' : record.role;
      const user: User = {
        id: record.id,
        username,
        displayName: record.displayName,
        ...(record.email === undefined ? {} : { email: record.email }),
        role,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
      };
      byId.set(user.id, { user, passwordHash: record.passwordHash });
      idOfUsername.set(username, user.id);
      return ok(copy(user));
    },

    get: async (id) => {
      const stored = byId.get(id);
      return stored === undefined ? undefined : copy(stored.user);
    },
    getByUsername: async (username) => {
      const stored = byUsername(username);
      return stored === undefined ? undefined : copy(stored.user);
    },
    credentialOf: async (id) => credential(byId.get(id)),
    credentialByUsername: async (username) => credential(byUsername(username)),

    update: async (id: string, patch: UserPatch, options: GuardOptions = {}): Promise<Result<User, UsersError>> => {
      const stored = byId.get(id);
      if (stored === undefined) return err(usersError('NOT_FOUND', 'no such user'));
      if (options.protectLastAdmin === true && stored.user.role === 'admin' && patch.role === 'user' && admins() === 1) {
        return err(usersError('LAST_ADMIN', 'the last admin cannot be demoted'));
      }
      const rest: Omit<User, 'email'> = { id: stored.user.id, username: stored.user.username, displayName: stored.user.displayName, role: stored.user.role, createdAt: stored.user.createdAt, updatedAt: stored.user.updatedAt };
      const email = patch.email === undefined ? stored.user.email : patch.email === null ? undefined : patch.email;
      const user: User = {
        ...rest,
        ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
        ...(email === undefined ? {} : { email }),
        ...(patch.role === undefined ? {} : { role: patch.role }),
        updatedAt: patch.updatedAt,
      };
      byId.set(id, { user, passwordHash: patch.passwordHash ?? stored.passwordHash });
      return ok(copy(user));
    },

    delete: async (id: string, options: GuardOptions = {}): Promise<Result<boolean, UsersError>> => {
      const stored = byId.get(id);
      if (stored === undefined) return ok(false);
      if (options.protectLastAdmin === true && stored.user.role === 'admin' && admins() === 1) {
        return err(usersError('LAST_ADMIN', 'the last admin cannot be deleted'));
      }
      byId.delete(id);
      idOfUsername.delete(stored.user.username);
      return ok(true);
    },

    list: async (page: UserPage): Promise<UserList> => {
      checkLimit(page.limit);
      const after = page.cursor === null ? undefined : decodeCursor(page.cursor);
      const sorted = [...byId.values()].map((s) => s.user).sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
      const rest = after === undefined ? sorted : sorted.filter((u) => u.username > after);
      const shown = rest.slice(0, page.limit);
      const last = shown.at(-1);
      return { items: shown.map(copy), nextCursor: rest.length > page.limit && last !== undefined ? encodeCursor(last.username) : null };
    },

    count: async () => byId.size,
  };
}
