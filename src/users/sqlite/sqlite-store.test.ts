import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter } from '../../graph_store/adapters/sqlite/index.js';
import { APPLICATION_ID as GRAPH_APPLICATION_ID } from '../../graph_store/adapters/sqlite/schema.js';
import { DbError, openDb } from '../../sqlite/db.js';
import { prepareSchema } from '../../sqlite/prepare.js';
import type { UserRecord, UserStore } from '../store.js';
import { runUserStoreConformance } from '../testing/index.js';
import { USERS_APPLICATION_ID, USERS_MIGRATIONS } from './schema.js';
import { createSqliteUserStore, type SqliteUserStore } from './sqlite-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const loader = join(here, '..', '..', 'sqlite', 'ts-loader.mjs');
const dirs: string[] = [];
const stores: SqliteUserStore[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-users-'));
  dirs.push(dir);
  return dir;
};
const openAt = (path: string, busyTimeoutMs?: number): SqliteUserStore => {
  const store = createSqliteUserStore(busyTimeoutMs === undefined ? { path } : { path, busyTimeoutMs });
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HASH = 'scrypt$16$1$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const rec = (n: number, extra: Partial<UserRecord> = {}): UserRecord => ({ id: `u${String(n).padStart(16, '0')}`, username: `user${n}`, displayName: `User ${n}`, role: 'user', passwordHash: HASH, createdAt: 1000 + n, ...extra });
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (cause) {
    return cause instanceof DbError ? cause.code : `other: ${String(cause)}`;
  }
  return undefined;
};

// The whole user store contract: on a private in-memory database per test, and again on a real file per test.
runUserStoreConformance(() => createSqliteUserStore(), { describe, it }, { dispose: (store) => (store as SqliteUserStore).close() });
{
  const homes = new Map<UserStore, string>();
  describe('on a file', () => {
    runUserStoreConformance(
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'caci-users-conf-'));
        const store = createSqliteUserStore({ path: join(dir, 'users.db') });
        homes.set(store, dir);
        return store;
      },
      { describe, it },
      {
        dispose: (store) => {
          (store as SqliteUserStore).close();
          rmSync(homes.get(store) as string, { recursive: true, force: true });
        },
      },
    );
  });
}

describe('the database itself enforces the rules (not only the store code)', () => {
  const raw = () => {
    const db = openDb();
    prepareSchema(db, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS, foreignCode: 'NOT_A_USERS_DATABASE' });
    return db;
  };
  const insert = (db: ReturnType<typeof raw>, id: string, username: string, role = 'user') =>
    db.run("INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES (?, ?, 'n', ?, 'h', 1, 1)", id, username, role);

  it('refuses a repeated username and a repeated id', () => {
    const db = raw();
    insert(db, 'a', 'ann');
    expect(() => insert(db, 'b', 'ann')).toThrow(/UNIQUE/);
    expect(() => insert(db, 'a', 'bob')).toThrow(/UNIQUE|PRIMARY/);
    db.close();
  });

  it('refuses a username that is not lower case, or empty, so a plain UNIQUE is a case-insensitive one', () => {
    const db = raw();
    expect(() => insert(db, 'a', 'Ann')).toThrow(/CHECK/);
    expect(() => insert(db, 'b', '')).toThrow(/CHECK/);
    insert(db, 'c', 'ann');
    db.close();
  });

  it('refuses a role that is not user or admin', () => {
    const db = raw();
    expect(() => insert(db, 'a', 'ann', 'root')).toThrow(/CHECK/);
    db.close();
  });
});

describe('the database file', () => {
  it('keeps every field across close and reopen, and does not recreate the schema', async () => {
    const path = join(tmp(), 'users.db');
    const first = openAt(path);
    await first.create(rec(1, { email: 'ann@example.com', passwordHash: 'scrypt$16$1$1$SECRETSALT0000000000$SECRETKEY' }), { adminIfFirst: true });
    await first.create(rec(2));
    await first.update(rec(2).id, { displayName: 'Changed', updatedAt: 9999 });
    const before = await first.list({ limit: 10, cursor: null });
    first.close();

    const second = openAt(path);
    expect(await second.list({ limit: 10, cursor: null })).toEqual(before);
    expect((await second.credentialByUsername('USER1'))?.passwordHash).toBe('scrypt$16$1$1$SECRETSALT0000000000$SECRETKEY');
    expect((await second.get(rec(1).id))?.role).toBe('admin');
    expect((await second.get(rec(2).id))?.updatedAt).toBe(9999);
    expect((await second.create(rec(3))).ok).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('is created readable and writable by its owner only, including its -wal and -shm files', async () => {
    const path = join(tmp(), 'users.db');
    const store = openAt(path);
    await store.create(rec(1));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) expect(statSync(path + suffix).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('an existing file keeps the mode its owner gave it', () => {
    const path = join(tmp(), 'users.db');
    createSqliteUserStore({ path }).close();
    chmodSync(path, 0o640);
    openAt(path);
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it('is marked with its own application id ("CaUs"), different from the graph database\'s', () => {
    expect(USERS_APPLICATION_ID).toBe(0x43615573);
    expect(USERS_APPLICATION_ID).not.toBe(GRAPH_APPLICATION_ID);
    const path = join(tmp(), 'users.db');
    createSqliteUserStore({ path }).close();
    const db = openDb({ path });
    expect(db.pragma('application_id')).toBe(USERS_APPLICATION_ID);
    expect(db.pragma('user_version')).toBe(3);
    db.close();
  });

  it('a statement that fails inside a transaction rolls it back, and the store keeps working', async () => {
    const store = openAt(join(tmp(), 'users.db'));
    await store.create(rec(1));
    const bad = await store.update(rec(1).id, { displayName: 'Half done', role: 'root' as never, updatedAt: 5 });
    expect(bad).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(JSON.stringify(bad)).not.toContain('UPDATE'); // no SQL in the message
    expect((await store.get(rec(1).id))?.displayName).toBe('User 1');
    expect((await store.update(rec(1).id, { displayName: 'Fine', updatedAt: 6 })).ok).toBe(true);
    expect((await store.delete(rec(1).id)).ok).toBe(true);
  });

  it('a clean close leaves one file', async () => {
    const dir = tmp();
    const store = openAt(join(dir, 'users.db'));
    await store.create(rec(1));
    store.close();
    expect(readdirSync(dir)).toEqual(['users.db']);
  });

  it('close is idempotent and a closed store says CLOSED', async () => {
    const store = createSqliteUserStore();
    store.close();
    store.close();
    await expect(store.get('x')).rejects.toMatchObject({ code: 'CLOSED' });
  });
});

describe('a file that is not a user database is refused and left exactly as it was', () => {
  it('a file that is not SQLite', () => {
    const path = join(tmp(), 'notes.txt');
    writeFileSync(path, 'my notes '.repeat(300));
    const before = readFileSync(path);
    expect(codeOf(() => createSqliteUserStore({ path }))).toBe('NOT_A_DATABASE');
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('another application\'s SQLite database', () => {
    const path = join(tmp(), 'other.db');
    const db = openDb({ path });
    db.exec('CREATE TABLE recipes (name TEXT)');
    db.close();
    const before = readFileSync(path);
    expect(codeOf(() => createSqliteUserStore({ path }))).toBe('NOT_A_USERS_DATABASE');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(dirname(path))).toEqual(['other.db']);
  });

  it('the graph database: the two files can never be mixed up, in either direction', async () => {
    const path = join(tmp(), 'graphs.db');
    await createSqliteAdapter({ path }).close();
    const before = readFileSync(path);
    expect(codeOf(() => createSqliteUserStore({ path }))).toBe('NOT_A_USERS_DATABASE');
    expect(readFileSync(path).equals(before)).toBe(true);

    const usersPath = join(tmp(), 'users.db');
    createSqliteUserStore({ path: usersPath }).close();
    expect(codeOf(() => createSqliteAdapter({ path: usersPath }))).toBe('NOT_A_GRAPH_DATABASE');
  });

  it('a user database written by a newer version', () => {
    const path = join(tmp(), 'users.db');
    createSqliteUserStore({ path }).close();
    const db = openDb({ path });
    db.exec('PRAGMA user_version = 99');
    db.close();
    const before = readFileSync(path);
    expect(codeOf(() => createSqliteUserStore({ path }))).toBe('NEWER_SCHEMA');
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('a user database that has lost its table', () => {
    const path = join(tmp(), 'users.db');
    createSqliteUserStore({ path }).close();
    const db = openDb({ path });
    db.exec('DROP TABLE users');
    db.close();
    expect(codeOf(() => createSqliteUserStore({ path }))).toBe('NOT_A_USERS_DATABASE');
  });

  it('a missing folder names the path and creates nothing', () => {
    const dir = tmp();
    const path = join(dir, 'no', 'such', 'users.db');
    expect(() => createSqliteUserStore({ path })).toThrow(path);
    expect(readdirSync(dir)).toEqual([]);
  });
});

function run(args: string[]): Promise<{ stdout: string; code: number | null; signal: NodeJS.Signals | null }> {
  const child = spawn(process.execPath, ['--import', loader, join(here, 'kill-child.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => (code === 0 || signal !== null ? resolve({ stdout, code, signal }) : reject(new Error(`child failed (${code}): ${stderr}`))));
  });
}

describe('crashes and other processes', () => {
  it('a process killed with SIGKILL inside a write transaction leaves the file intact, without the partial write', async () => {
    const path = join(tmp(), 'users.db');
    const child = spawn(process.execPath, ['--import', loader, join(here, 'kill-child.mjs'), path, 'hang'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    await new Promise<void>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString();
        if (out.includes('ready')) resolve();
      });
      child.on('exit', () => reject(new Error(`the child ended before it was ready: ${stderr}`)));
    });
    const ended = new Promise<string | null>((resolve) => child.on('exit', (_code, signal) => resolve(signal)));
    child.kill('SIGKILL');
    expect(await ended).toBe('SIGKILL');

    const store = openAt(path);
    expect(await store.count()).toBe(1);
    expect((await store.getByUsername('committed'))?.id).toBe('ucommitted0000000');
    expect(await store.getByUsername('partial-0')).toBeUndefined();
    expect((await store.create(rec(1))).ok).toBe(true); // and it is usable
  });

  it('the killed run really did write before it was killed (otherwise the test proves nothing)', async () => {
    const path = join(tmp(), 'users.db');
    await run([path, 'finish']);
    expect(await openAt(path).count()).toBe(501);
  });

  it('two processes creating users at once lose none, and of the one name they both try exactly one wins', async () => {
    const path = join(tmp(), 'users.db');
    openAt(path).close(); // the file exists and is prepared
    const [a, b] = await Promise.all([run([path, 'race', 'a']), run([path, 'race', 'b'])]);
    const resultsA = JSON.parse(a.stdout) as boolean[];
    const resultsB = JSON.parse(b.stdout) as boolean[];
    expect(resultsA.slice(1).every(Boolean)).toBe(true);
    expect(resultsB.slice(1).every(Boolean)).toBe(true);
    expect([resultsA[0], resultsB[0]].filter(Boolean)).toHaveLength(1);
    expect(await openAt(path).count()).toBe(1 + 25 + 25);
  }, 60_000);

  it('a writer that cannot get the lock fails with a clear message, and nothing is changed', async () => {
    const path = join(tmp(), 'users.db');
    const waiter = openAt(path, 50);
    const holder = openDb({ path });
    holder.begin();
    const result = await waiter.create(rec(1));
    holder.rollback();
    holder.close();
    expect(result).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(JSON.stringify(result)).toMatch(/locked by another connection/);
    expect(await waiter.count()).toBe(0);
  });
});
