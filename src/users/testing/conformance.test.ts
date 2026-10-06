import { describe, expect, it } from 'vitest';
import { err, ok, type Result } from '../../graph_store/index.js';
import { usersError, type UsersError } from '../errors.js';
import { createMemoryUserStore } from '../memory-store.js';
import type { CreateOptions, GuardOptions, UserList, UserPage, UserPatch, UserRecord, UserStore } from '../store.js';
import type { User } from '../types.js';
import { userStoreCases } from './cases.js';
import { runUserStoreConformance, type TestApi } from './index.js';

// the real thing: the memory store through Vitest itself (also in ../memory-store.test.ts)
runUserStoreConformance(() => createMemoryUserStore(), { describe, it });

/** A runner that records what the harness registers, and can execute it afterwards. */
function recordingRunner() {
  const names: string[] = [];
  const bodies: Array<() => Promise<void> | void> = [];
  const stack: string[] = [];
  const api: TestApi = {
    describe: (name, body) => {
      stack.push(name);
      body();
      stack.pop();
    },
    it: (name, body) => {
      names.push([...stack, name].join(' > '));
      bodies.push(body);
    },
  };
  return { api, names, bodies };
}

describe('runUserStoreConformance (the harness itself)', () => {
  it('registers every case under "user store conformance"', () => {
    const { api, names } = recordingRunner();
    runUserStoreConformance(() => createMemoryUserStore(), api);
    expect(names).toEqual(userStoreCases().map((c) => `user store conformance > ${c.name}`));
    expect(names.length).toBeGreaterThanOrEqual(20);
  });

  it('makes a fresh store per test and disposes each one, also when a test fails', async () => {
    const made: UserStore[] = [];
    const disposed: UserStore[] = [];
    const { api, bodies } = recordingRunner();
    runUserStoreConformance(
      () => {
        const store = createMemoryUserStore();
        made.push(store);
        return store;
      },
      api,
      { dispose: (store) => void disposed.push(store) },
    );
    for (const body of bodies) await body();
    expect(new Set(made).size).toBe(made.length);
    expect(disposed).toEqual(made);

    const failing = recordingRunner();
    let disposals = 0;
    runUserStoreConformance(() => ({ ...createMemoryUserStore(), count: async () => 99 }), failing.api, { dispose: () => void disposals++ });
    const results = await Promise.allSettled(failing.bodies.map((b) => b()));
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
    expect(disposals).toBeGreaterThan(0);
  });

  it('accepts an async factory', async () => {
    const { api, bodies } = recordingRunner();
    runUserStoreConformance(async () => createMemoryUserStore(), api);
    await bodies[0]?.();
  });
});

// ---- deliberately broken stores: each must be caught by the suite ----

type Defect =
  | 'case-sensitive'
  | 'check-then-put'
  | 'leaks-hash'
  | 'aliases'
  | 'update-changes-created-at'
  | 'delete-missing-is-error'
  | 'inclusive-cursor'
  | 'no-last-admin-guard'
  | 'first-admin-not-atomic'
  | 'no-limit-check'
  | 'duplicate-id-allowed'
  | 'null-email-kept'
  | 'update-missing-creates'
  | 'unsorted-list'
  | 'login-by-case-sensitive-name'
  | 'shared-state';

const shared = new Map<string, { user: User; hash: string }>();

/** A simple, correct-by-default store with one switchable defect. */
function naiveStore(defect: Defect | undefined): UserStore {
  const rows = defect === 'shared-state' ? shared : new Map<string, { user: User; hash: string }>();
  const key = (name: string): string => (defect === 'case-sensitive' ? name : name.toLowerCase());
  const byName = (name: string) => [...rows.values()].find((r) => key(r.user.username) === key(name));
  const copy = (u: User): User => (defect === 'aliases' ? u : { ...u });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  const store: UserStore = {
    create: async (record: UserRecord, options: CreateOptions = {}): Promise<Result<User, UsersError>> => {
      const username = defect === 'case-sensitive' ? record.username : record.username.toLowerCase();
      const taken = byName(username) !== undefined;
      if (defect === 'check-then-put') await tick();
      if (taken) return err(usersError('CONFLICT', 'taken'));
      if (defect !== 'duplicate-id-allowed' && rows.has(record.id)) return err(usersError('CONFLICT', 'id'));
      const firstNow = rows.size === 0;
      if (defect === 'first-admin-not-atomic') await tick();
      const user: User = {
        id: record.id,
        username,
        displayName: record.displayName,
        ...(record.email === undefined ? {} : { email: record.email }),
        role: options.adminIfFirst === true && firstNow ? 'admin' : record.role,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
      };
      rows.set(record.id + (defect === 'duplicate-id-allowed' ? `#${rows.size}` : ''), { user, hash: record.passwordHash });
      return ok(copy(user));
    },
    get: async (id) => {
      const row = rows.get(id);
      if (row === undefined) return undefined;
      return defect === 'leaks-hash' ? ({ ...row.user, passwordHash: row.hash } as User) : copy(row.user);
    },
    getByUsername: async (username) => {
      const row = defect === 'login-by-case-sensitive-name' ? [...rows.values()].find((r) => r.user.username === username) : byName(username);
      return row === undefined ? undefined : copy(row.user);
    },
    credentialOf: async (id) => {
      const row = rows.get(id);
      return row === undefined ? undefined : { user: copy(row.user), passwordHash: row.hash };
    },
    credentialByUsername: async (username) => {
      const row = defect === 'login-by-case-sensitive-name' ? [...rows.values()].find((r) => r.user.username === username) : byName(username);
      return row === undefined ? undefined : { user: copy(row.user), passwordHash: row.hash };
    },
    update: async (id: string, patch: UserPatch, options: GuardOptions = {}): Promise<Result<User, UsersError>> => {
      const row = rows.get(id);
      if (row === undefined) {
        if (defect === 'update-missing-creates') {
          rows.set(id, { user: { id, username: id, displayName: patch.displayName ?? '', role: 'user', createdAt: patch.updatedAt, updatedAt: patch.updatedAt }, hash: '' });
          return ok(rows.get(id)?.user as User);
        }
        return err(usersError('NOT_FOUND', 'no'));
      }
      const admins = [...rows.values()].filter((r) => r.user.role === 'admin').length;
      if (defect !== 'no-last-admin-guard' && options.protectLastAdmin === true && row.user.role === 'admin' && patch.role === 'user' && admins === 1) return err(usersError('LAST_ADMIN', 'last'));
      if (defect === 'check-then-put') await tick();
      const next: User = {
        ...row.user,
        ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
        ...(patch.role === undefined ? {} : { role: patch.role }),
        updatedAt: patch.updatedAt,
        ...(defect === 'update-changes-created-at' ? { createdAt: patch.updatedAt } : {}),
      };
      if (patch.email === null) {
        if (defect === 'null-email-kept') (next as { email?: unknown }).email = null;
        else delete (next as { email?: string }).email;
      } else if (patch.email !== undefined) (next as { email?: string }).email = patch.email;
      rows.set(id, { user: next, hash: patch.passwordHash ?? row.hash });
      return ok(copy(next));
    },
    delete: async (id: string, options: GuardOptions = {}): Promise<Result<boolean, UsersError>> => {
      const row = rows.get(id);
      if (row === undefined) return defect === 'delete-missing-is-error' ? err(usersError('NOT_FOUND', 'no')) : ok(false);
      const admins = [...rows.values()].filter((r) => r.user.role === 'admin').length;
      if (defect !== 'no-last-admin-guard' && options.protectLastAdmin === true && row.user.role === 'admin' && admins === 1) return err(usersError('LAST_ADMIN', 'last'));
      if (defect === 'check-then-put') await tick();
      rows.delete(id);
      return ok(true);
    },
    list: async (page: UserPage): Promise<UserList> => {
      if (defect !== 'no-limit-check' && (!Number.isInteger(page.limit) || page.limit < 1)) throw new RangeError('limit');
      const all = [...rows.values()].map((r) => r.user);
      if (defect !== 'unsorted-list') all.sort((a, b) => (a.username < b.username ? -1 : 1));
      let rest = all;
      if (page.cursor !== null) {
        if (!/^c[A-Za-z0-9_-]+$/.test(page.cursor)) throw new RangeError('cursor');
        const after = Buffer.from(page.cursor.slice(1), 'base64url').toString('utf8');
        rest = all.filter((u) => (defect === 'inclusive-cursor' ? u.username >= after : u.username > after));
      }
      const shown = rest.slice(0, Math.max(1, page.limit));
      const last = shown.at(-1);
      return { items: shown.map(copy), nextCursor: rest.length > page.limit && last !== undefined ? 'c' + Buffer.from(last.username).toString('base64url') : null };
    },
    count: async () => rows.size,
  };
  return store;
}

async function failures(make: () => UserStore): Promise<string[]> {
  const failed: string[] = [];
  for (const testCase of userStoreCases()) {
    try {
      await testCase.run(make(), async () => make());
    } catch {
      failed.push(testCase.name);
    }
  }
  return failed;
}

describe('the suite catches deliberately broken stores', () => {
  it('the naive store with no defect passes everything (so the broken ones fail for the right reason)', async () => {
    expect(await failures(() => naiveStore(undefined))).toEqual([]);
  });

  const expectations: ReadonlyArray<readonly [Defect, RegExp]> = [
    ['case-sensitive', /unique whatever their case/],
    ['check-then-put', /eight simultaneous creates of one username/],
    ['leaks-hash', /never contain a hash/],
    ['aliases', /copy/],
    ['update-changes-created-at', /update changes only what it is given/],
    ['delete-missing-is-error', /delete removes the user/],
    ['inclusive-cursor', /paging/],
    ['no-last-admin-guard', /last admin/],
    ['first-admin-not-atomic', /first user can be made admin atomically/],
    ['no-limit-check', /RangeError/],
    ['duplicate-id-allowed', /user id cannot be used twice/],
    ['null-email-kept', /email/],
    ['update-missing-creates', /updating a missing user/],
    ['unsorted-list', /by username in plain order/],
    ['login-by-case-sensitive-name', /unique whatever their case/],
    ['shared-state', /share nothing/],
  ];

  it.each(expectations)('catches "%s", by the case aimed at it', async (defect, aimedAt) => {
    shared.clear();
    const failed = await failures(() => naiveStore(defect));
    expect(failed.length, `${defect} was not caught`).toBeGreaterThan(0);
    expect(failed.some((name) => aimedAt.test(name)), `${defect}: failed ${JSON.stringify(failed)}`).toBe(true);
  });
});
