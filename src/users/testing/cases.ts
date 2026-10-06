import assert from 'node:assert/strict';
import type { Result } from '../../graph_store/index.js';
import type { UsersError } from '../errors.js';
import type { UserRecord, UserStore } from '../store.js';
import type { User } from '../types.js';
import type { UserStoreCase } from './types.js';

const HASH = 'scrypt$16$1$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SECRET_HASH = 'scrypt$16$1$1$c2VjcmV0c2VjcmV0c2VjcmV0$SECRETHASHSECRETHASHSECRETHASHSECRETHASH123';

const record = (n: number | string, extra: Partial<UserRecord> = {}): UserRecord => ({
  id: `u${String(n).padStart(16, '0')}`,
  username: `user${n}`,
  displayName: `User ${n}`,
  role: 'user',
  passwordHash: HASH,
  createdAt: 1000 + (typeof n === 'number' ? n : 0),
  ...extra,
});
const must = <T>(result: Result<T, UsersError>): T => {
  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  return result.value;
};
const code = <T>(result: Result<T, UsersError>): string | undefined => (result.ok ? undefined : result.error.code);
const allPages = async (store: UserStore, limit: number): Promise<User[]> => {
  const out: User[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await store.list({ limit, cursor });
    out.push(...page.items);
    cursor = page.nextCursor;
    if (cursor === null) return out;
  }
  throw new Error('paging did not finish: the cursor never ended');
};

export function userStoreCases(): readonly UserStoreCase[] {
  return [
    {
      name: 'create then get, getByUsername and the credential accessors round-trip every field',
      run: async (store) => {
        const created = must(await store.create(record(1, { email: 'ann@example.com', passwordHash: SECRET_HASH })));
        assert.deepEqual(created, { id: record(1).id, username: 'user1', displayName: 'User 1', email: 'ann@example.com', role: 'user', createdAt: 1001, updatedAt: 1001 });
        assert.deepEqual(await store.get(record(1).id), created);
        assert.deepEqual(await store.getByUsername('user1'), created);
        assert.deepEqual(await store.credentialOf(record(1).id), { user: created, passwordHash: SECRET_HASH });
        assert.deepEqual(await store.credentialByUsername('user1'), { user: created, passwordHash: SECRET_HASH });
        assert.equal(await store.count(), 1);
      },
    },
    {
      name: 'a user without an email has no email key at all',
      run: async (store) => {
        const created = must(await store.create(record(1)));
        assert.equal('email' in created, false);
        assert.equal('email' in ((await store.get(record(1).id)) as User), false);
      },
    },
    {
      name: 'missing users are undefined, not errors',
      run: async (store) => {
        assert.equal(await store.get('nobody'), undefined);
        assert.equal(await store.getByUsername('nobody'), undefined);
        assert.equal(await store.credentialOf('nobody'), undefined);
        assert.equal(await store.credentialByUsername('nobody'), undefined);
      },
    },
    {
      name: 'usernames are unique whatever their case, and are stored and found in lower case',
      run: async (store) => {
        const first = must(await store.create(record(1, { username: 'Ann.Smith' })));
        assert.equal(first.username, 'ann.smith');
        assert.equal(code(await store.create(record(2, { username: 'ann.smith' }))), 'CONFLICT');
        assert.equal(code(await store.create(record(3, { username: 'ANN.SMITH' }))), 'CONFLICT');
        assert.equal((await store.getByUsername('ANN.smith'))?.id, record(1).id);
        assert.equal((await store.credentialByUsername('Ann.Smith'))?.user.id, record(1).id);
        assert.equal(await store.count(), 1);
      },
    },
    {
      name: 'a user id cannot be used twice, and a refused create leaves nothing behind',
      run: async (store) => {
        must(await store.create(record(1)));
        assert.equal(code(await store.create(record(1, { username: 'someone-else' }))), 'CONFLICT');
        assert.equal(await store.getByUsername('someone-else'), undefined);
        assert.equal(await store.count(), 1);
      },
    },
    {
      name: 'of eight simultaneous creates of one username, exactly one succeeds',
      run: async (store) => {
        const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.create(record(i + 1, { username: 'racer' }))));
        assert.equal(results.filter((r) => r.ok).length, 1);
        assert.deepEqual(new Set(results.filter((r) => !r.ok).map(code)), new Set(['CONFLICT']));
        assert.equal(await store.count(), 1);
      },
    },
    {
      name: 'the first user can be made admin atomically: of eight simultaneous first creates, exactly one is admin',
      run: async (store) => {
        await Promise.all(Array.from({ length: 8 }, (_, i) => store.create(record(i + 1), { adminIfFirst: true })));
        const everyone = await allPages(store, 100);
        assert.equal(everyone.length, 8);
        assert.equal(everyone.filter((u) => u.role === 'admin').length, 1);
      },
    },
    {
      name: 'adminIfFirst changes nothing once someone exists, and is not applied without the option',
      run: async (store) => {
        assert.equal(must(await store.create(record(1))).role, 'user'); // no option: stays a user even when first
        assert.equal(must(await store.create(record(2), { adminIfFirst: true })).role, 'user'); // not first any more
        const fresh = await store.count();
        assert.equal(fresh, 2);
      },
    },
    {
      name: 'a requested admin role is kept',
      run: async (store) => {
        assert.equal(must(await store.create(record(1, { role: 'admin' }))).role, 'admin');
      },
    },
    {
      name: 'update changes only what it is given, and never the id, username or createdAt',
      run: async (store) => {
        must(await store.create(record(1, { email: 'old@example.com' })));
        const updated = must(await store.update(record(1).id, { displayName: 'New Name', updatedAt: 5000 }));
        assert.deepEqual(updated, { id: record(1).id, username: 'user1', displayName: 'New Name', email: 'old@example.com', role: 'user', createdAt: 1001, updatedAt: 5000 });
        assert.deepEqual(await store.get(record(1).id), updated);
        const roled = must(await store.update(record(1).id, { role: 'admin', updatedAt: 6000 }));
        assert.equal(roled.role, 'admin');
        assert.equal(roled.displayName, 'New Name');
        assert.equal(roled.createdAt, 1001);
      },
    },
    {
      name: 'update can set, change and remove the email (null removes it)',
      run: async (store) => {
        must(await store.create(record(1)));
        assert.equal(must(await store.update(record(1).id, { email: 'a@example.com', updatedAt: 2 })).email, 'a@example.com');
        assert.equal(must(await store.update(record(1).id, { email: 'b@example.com', updatedAt: 3 })).email, 'b@example.com');
        const removed = must(await store.update(record(1).id, { email: null, updatedAt: 4 }));
        assert.equal('email' in removed, false);
        assert.equal('email' in ((await store.get(record(1).id)) as User), false);
      },
    },
    {
      name: 'update replaces the password hash only when given one',
      run: async (store) => {
        must(await store.create(record(1, { passwordHash: SECRET_HASH })));
        must(await store.update(record(1).id, { displayName: 'Same Hash', updatedAt: 2 }));
        assert.equal((await store.credentialOf(record(1).id))?.passwordHash, SECRET_HASH);
        must(await store.update(record(1).id, { passwordHash: HASH, updatedAt: 3 }));
        assert.equal((await store.credentialOf(record(1).id))?.passwordHash, HASH);
        assert.equal((await store.credentialByUsername('user1'))?.passwordHash, HASH);
      },
    },
    {
      name: 'updating a missing user is NOT_FOUND and creates nothing',
      run: async (store) => {
        assert.equal(code(await store.update('nobody', { displayName: 'X', updatedAt: 1 })), 'NOT_FOUND');
        assert.equal(await store.count(), 0);
      },
    },
    {
      name: 'delete removes the user and frees the username, and is idempotent',
      run: async (store) => {
        must(await store.create(record(1)));
        assert.equal(must(await store.delete(record(1).id)), true);
        assert.equal(must(await store.delete(record(1).id)), false);
        assert.equal(must(await store.delete('never-existed')), false);
        assert.equal(await store.get(record(1).id), undefined);
        assert.equal(await store.getByUsername('user1'), undefined);
        assert.equal(await store.credentialByUsername('user1'), undefined);
        assert.equal(await store.count(), 0);
        must(await store.create(record(2, { username: 'user1' }))); // the name is free again
      },
    },
    {
      name: 'the last admin cannot be deleted or demoted when guarded, but can be when not',
      run: async (store) => {
        must(await store.create(record(1, { role: 'admin' })));
        must(await store.create(record(2)));
        assert.equal(code(await store.delete(record(1).id, { protectLastAdmin: true })), 'LAST_ADMIN');
        assert.equal(code(await store.update(record(1).id, { role: 'user', updatedAt: 9 }, { protectLastAdmin: true })), 'LAST_ADMIN');
        assert.equal((await store.get(record(1).id))?.role, 'admin');
        assert.equal(must(await store.delete(record(2).id, { protectLastAdmin: true })), true); // not an admin
        must(await store.update(record(1).id, { displayName: 'Still Admin', role: 'admin', updatedAt: 9 }, { protectLastAdmin: true })); // not a demotion
        assert.equal(must(await store.update(record(1).id, { role: 'user', updatedAt: 10 })).role, 'user'); // unguarded
      },
    },
    {
      name: 'with two admins one can go, and of two simultaneous guarded deletes of the two, exactly one succeeds',
      run: async (store) => {
        must(await store.create(record(1, { role: 'admin' })));
        must(await store.create(record(2, { role: 'admin' })));
        const results = await Promise.all([store.delete(record(1).id, { protectLastAdmin: true }), store.delete(record(2).id, { protectLastAdmin: true })]);
        assert.equal(results.filter((r) => r.ok && r.value).length, 1);
        assert.equal(results.filter((r) => code(r) === 'LAST_ADMIN').length, 1);
        assert.equal((await allPages(store, 10)).filter((u) => u.role === 'admin').length, 1);
      },
    },
    {
      name: 'of simultaneous guarded demotions of the only two admins, exactly one succeeds',
      run: async (store) => {
        must(await store.create(record(1, { role: 'admin' })));
        must(await store.create(record(2, { role: 'admin' })));
        const results = await Promise.all([store.update(record(1).id, { role: 'user', updatedAt: 5 }, { protectLastAdmin: true }), store.update(record(2).id, { role: 'user', updatedAt: 5 }, { protectLastAdmin: true })]);
        assert.equal(results.filter((r) => r.ok).length, 1);
        assert.equal((await allPages(store, 10)).filter((u) => u.role === 'admin').length, 1);
      },
    },
    {
      name: 'get, getByUsername and list never contain a hash; only the credential accessors do',
      run: async (store) => {
        must(await store.create(record(1, { passwordHash: SECRET_HASH })));
        must(await store.update(record(1).id, { displayName: 'After Update', updatedAt: 3 }));
        const everything = [await store.get(record(1).id), await store.getByUsername('user1'), await allPages(store, 10), must(await store.update(record(1).id, { updatedAt: 4 }))];
        for (const value of everything) {
          assert.equal(JSON.stringify(value).includes('SECRETHASH'), false);
          assert.equal(JSON.stringify(value).includes('scrypt'), false);
          assert.equal(JSON.stringify(value).toLowerCase().includes('passwordhash'), false);
        }
        assert.equal((await store.credentialOf(record(1).id))?.passwordHash, SECRET_HASH);
      },
    },
    {
      name: 'what a store returns is a copy: changing it changes nothing in the store',
      run: async (store) => {
        const created = must(await store.create(record(1)));
        (created as { displayName: string }).displayName = 'tampered';
        const fetched = (await store.get(record(1).id)) as User;
        (fetched as { displayName: string }).displayName = 'tampered again';
        const listed = (await store.list({ limit: 10, cursor: null })).items[0] as User;
        (listed as { role: string }).role = 'admin';
        const credential = (await store.credentialOf(record(1).id)) as { user: User };
        (credential.user as { username: string }).username = 'tampered';
        const again = (await store.get(record(1).id)) as User;
        assert.equal(again.displayName, 'User 1');
        assert.equal(again.role, 'user');
        assert.equal(again.username, 'user1');
      },
    },
    {
      name: 'the record handed to create is not kept: changing it afterwards changes nothing',
      run: async (store) => {
        const input = { ...record(1) } as { -readonly [K in keyof UserRecord]: UserRecord[K] };
        must(await store.create(input));
        input.displayName = 'changed after the fact';
        input.passwordHash = 'x';
        assert.equal((await store.get(record(1).id))?.displayName, 'User 1');
        assert.equal((await store.credentialOf(record(1).id))?.passwordHash, HASH);
      },
    },
    {
      name: 'list is by username in plain order, and paging walks everything once',
      run: async (store) => {
        const names = ['bob', 'Alice', 'carol', 'a.b', 'a_b', 'a-b', 'zed', 'bo'];
        for (const [i, username] of names.entries()) must(await store.create(record(i + 1, { username })));
        const expected = names.map((n) => n.toLowerCase()).sort();
        for (const limit of [1, 2, 3, 8, 100]) assert.deepEqual((await allPages(store, limit)).map((u) => u.username), expected, `limit ${limit}`);
        assert.equal(await store.count(), 8);
      },
    },
    {
      name: 'a page that exactly fills the limit has no next cursor, and an empty store lists nothing',
      run: async (store) => {
        assert.deepEqual(await store.list({ limit: 5, cursor: null }), { items: [], nextCursor: null });
        for (let i = 1; i <= 3; i++) must(await store.create(record(i)));
        const exact = await store.list({ limit: 3, cursor: null });
        assert.equal(exact.items.length, 3);
        assert.equal(exact.nextCursor, null);
        const partial = await store.list({ limit: 2, cursor: null });
        assert.equal(typeof partial.nextCursor, 'string');
        assert.notEqual(partial.nextCursor, '');
      },
    },
    {
      name: 'paging is stable: users added or deleted between pages are neither skipped nor repeated',
      run: async (store) => {
        for (const name of ['b', 'd', 'f', 'h']) must(await store.create(record(name.charCodeAt(0), { username: `user-${name}` })));
        const first = await store.list({ limit: 2, cursor: null });
        assert.deepEqual(first.items.map((u) => u.username), ['user-b', 'user-d']);
        must(await store.create(record(1, { username: 'user-a' }))); // before the cursor: never seen
        must(await store.create(record(2, { username: 'user-e' }))); // after it: seen
        must(await store.delete(record('f'.charCodeAt(0)).id)); // after it: gone
        must(await store.delete(record('b'.charCodeAt(0)).id)); // already shown
        const rest = await store.list({ limit: 10, cursor: first.nextCursor });
        assert.deepEqual(rest.items.map((u) => u.username), ['user-e', 'user-h']);
        assert.equal(rest.nextCursor, null);
      },
    },
    {
      name: 'a page limit that is not a positive whole number, and a cursor the store never gave, are refused with a RangeError',
      run: async (store) => {
        must(await store.create(record(1)));
        for (const limit of [0, -1, 1.5, Number.NaN]) await assert.rejects(store.list({ limit, cursor: null }), RangeError);
        for (const cursor of ['', 'garbage', 'c!!!', 'x', '\u0000']) await assert.rejects(store.list({ limit: 5, cursor }), RangeError);
      },
    },
    {
      name: 'usernames and ids with unusual but legal characters round-trip exactly',
      run: async (store) => {
        const names = ['a.b-c_d', '0.0.0', '___', '---', 'x'.repeat(32), 'a1'];
        for (const [i, username] of names.entries()) must(await store.create(record(i + 1, { username })));
        for (const username of names) assert.equal((await store.getByUsername(username))?.username, username);
        assert.equal(await store.count(), names.length);
      },
    },
    {
      name: 'two stores from the same factory share nothing',
      run: async (store, makeAnother) => {
        const other = await makeAnother();
        must(await store.create(record(1)));
        assert.equal(await other.get(record(1).id), undefined);
        assert.equal(await other.count(), 0);
        must(await other.create(record(1))); // the same username and id are free there
      },
    },
  ];
}
