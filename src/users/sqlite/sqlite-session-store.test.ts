import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../sqlite/db.js';
import { prepareSchema } from '../../sqlite/prepare.js';
import type { SessionStore } from '../session-store.js';
import { runSessionStoreConformance } from '../testing/index.js';
import { hashToken } from '../tokens.js';
import { USERS_APPLICATION_ID, USERS_MIGRATIONS, USERS_SCHEMA_VERSION } from './schema.js';
import { createSqliteSessionStore, type SqliteSessionStore } from './sqlite-session-store.js';
import { createSqliteUserStore } from './sqlite-store.js';

const dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-sessions-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const sessionsAt = (path: string, options = {}): SqliteSessionStore => {
  const store = createSqliteSessionStore({ path, ...options });
  stores.push(store);
  return store;
};
const usersAt = (path: string) => {
  const store = createSqliteUserStore({ path });
  stores.push(store);
  return store;
};
const T0 = 1_000_000_000_000;

// The whole session store contract: in memory, and on a real file per test.
runSessionStoreConformance((options) => createSqliteSessionStore(options), { describe, it }, { dispose: (s) => (s as SqliteSessionStore).close() });
{
  const homes = new Map<SessionStore, string>();
  describe('on a file', () => {
    runSessionStoreConformance(
      (options) => {
        const dir = mkdtempSync(join(tmpdir(), 'caci-sessions-conf-'));
        const store = createSqliteSessionStore({ ...options, path: join(dir, 'users.db') });
        homes.set(store, dir);
        return store;
      },
      { describe, it },
      {
        dispose: (s) => {
          (s as SqliteSessionStore).close();
          rmSync(homes.get(s) as string, { recursive: true, force: true });
        },
      },
    );
  });
}

describe('sessions in the database file', () => {
  it('never write the token itself, anywhere in the file: only its SHA-256', async () => {
    const path = join(tmp(), 'users.db');
    const store = sessionsAt(path);
    const token = await store.create('ann', T0);
    await store.resolve(token, T0 + 70_000); // a renewal writes too
    store.close();
    const bytes = Buffer.concat(readdirSync(join(path, '..')).map((name) => readFileSync(join(path, '..', name))));
    expect(bytes.includes(Buffer.from(token))).toBe(false);
    expect(bytes.includes(Buffer.from(token, 'base64url'))).toBe(false);
    expect(bytes.includes(Buffer.from(hashToken(token)))).toBe(true); // the hash is there
  });

  it('a stolen copy of the database cannot be used to log in: the stored hash is not a token', async () => {
    const path = join(tmp(), 'users.db');
    const store = sessionsAt(path);
    await store.create('ann', T0);
    const db = openDb({ path });
    const rows = db.all<{ token_hash: string }>('SELECT token_hash FROM sessions');
    db.close();
    expect(rows).toHaveLength(1);
    for (const attempt of [rows[0]?.token_hash as string, Buffer.from(rows[0]?.token_hash as string, 'hex').toString('base64url')]) expect(await store.resolve(attempt, T0 + 1)).toBeUndefined();
  });

  it('survive a restart: a token still works after the store is closed and opened again', async () => {
    const path = join(tmp(), 'users.db');
    const first = sessionsAt(path);
    const token = await first.create('ann', T0);
    first.close();
    expect(await sessionsAt(path).resolve(token, T0 + 1000)).toBe('ann');
  });

  it('keep the renewed time across a restart too', async () => {
    const path = join(tmp(), 'users.db');
    const first = sessionsAt(path, { idleMs: 100_000, absoluteMs: 1_000_000, renewEveryMs: 60_000 });
    const token = await first.create('ann', T0);
    await first.resolve(token, T0 + 90_000);
    first.close();
    expect(await sessionsAt(path, { idleMs: 100_000, absoluteMs: 1_000_000, renewEveryMs: 60_000 }).resolve(token, T0 + 180_000)).toBe('ann'); // 90 s since the renewal, though 180 s since login
  });

  it('are shared by two stores on one file', async () => {
    const path = join(tmp(), 'users.db');
    const a = sessionsAt(path);
    const b = sessionsAt(path);
    const token = await a.create('ann', T0);
    expect(await b.resolve(token, T0 + 1)).toBe('ann');
    expect(await b.revoke(token)).toBe(true);
    expect(await a.resolve(token, T0 + 1)).toBeUndefined();
  });

  it('end when their user is deleted from the user store (the database does it, not the caller)', async () => {
    const path = join(tmp(), 'users.db');
    const users = usersAt(path);
    const sessions = sessionsAt(path);
    const record = (n: number) => ({ id: `u${String(n).padStart(16, '0')}`, username: `user${n}`, displayName: 'x', role: 'user' as const, passwordHash: 'h', createdAt: 1 });
    await users.create(record(1));
    await users.create(record(2));
    const ann = [await sessions.create(record(1).id, T0), await sessions.create(record(1).id, T0)];
    const bob = await sessions.create(record(2).id, T0);
    await users.delete(record(1).id);
    for (const token of ann) expect(await sessions.resolve(token, T0 + 1)).toBeUndefined();
    expect(await sessions.resolve(bob, T0 + 1)).toBe(record(2).id);
    // and a session for a user that has no row is allowed (the store does not know about users)
    expect(typeof (await sessions.create('someone-with-no-row', T0))).toBe('string');
  });

  it('are added to a version 1 user database without touching its users', async () => {
    const path = join(tmp(), 'users.db');
    const db = openDb({ path });
    prepareSchema(db, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS.slice(0, 1), foreignCode: 'NOT_A_USERS_DATABASE' });
    db.run("INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES ('u0000000000000001', 'ann', 'Ann', 'admin', 'h', 1, 1)");
    expect(db.pragma('user_version')).toBe(1);
    db.close();

    const sessions = sessionsAt(path); // opening upgrades it
    const token = await sessions.create('u0000000000000001', T0);
    expect(await sessions.resolve(token, T0 + 1)).toBe('u0000000000000001');
    const after = openDb({ path });
    expect(after.pragma('user_version')).toBe(USERS_SCHEMA_VERSION);
    expect(after.get<{ username: string; role: string }>("SELECT username, role FROM users WHERE id = 'u0000000000000001'")).toEqual({ username: 'ann', role: 'admin' });
    after.close();
    expect((await usersAt(path).getByUsername('ann'))?.role).toBe('admin');
  });

  it('a limit of sessions per user is enforced by the database as well (counted in one transaction)', async () => {
    const path = join(tmp(), 'users.db');
    const store = sessionsAt(path, { maxPerUser: 2 });
    for (let i = 0; i < 6; i++) await store.create('ann', T0 + i);
    const db = openDb({ path });
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM sessions WHERE user_id = 'ann'")?.n).toBe(2);
    db.close();
  });

  it('a create that fails halfway (a repeated token) rolls back, and the store keeps working', async () => {
    const draws = [1, 1, 2];
    let n = 0;
    const store = sessionsAt(join(tmp(), 'users.db'), { maxPerUser: 2, randomBytes: (len: number) => new Uint8Array(len).fill(draws[n++] ?? 3) });
    const first = await store.create('ann', T0);
    await expect(store.create('ann', T0 + 1)).rejects.toThrow(); // the same token again: the insert fails after the make-room delete
    expect(await store.resolve(first, T0 + 2)).toBe('ann'); // nothing was lost to the half-done create
    expect(typeof (await store.create('ann', T0 + 3))).toBe('string'); // and the next one works (the transaction was ended)
  });

  it('refuse nonsense settings when made', () => {
    expect(() => createSqliteSessionStore({ idleMs: 0 })).toThrow(TypeError);
  });

  it('use the random source they are given', async () => {
    const store = createSqliteSessionStore({ randomBytes: (n) => new Uint8Array(n).fill(9) });
    stores.push(store);
    expect(await store.create('ann', 0)).toBe(Buffer.alloc(32, 9).toString('base64url'));
  });
});
