import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter } from '../../graph_store/adapters/sqlite/index.js';
import { DbError, openDb } from '../../sqlite/db.js';
import { prepareSchema } from '../../sqlite/prepare.js';
import { createSqliteCircleStore } from '../../circles/sqlite/index.js';
import { createSqliteLedgerStore } from '../../ledger/sqlite/index.js';
import { createSqliteSessionStore, createSqliteUserStore, USERS_APPLICATION_ID, USERS_SCHEMA_VERSION } from '../../users/sqlite/index.js';
import { USERS_MIGRATIONS } from '../../users/sqlite/schema.js';
import { createMemoryResolutionStore } from '../memory-store.js';
import type { ResolutionStore } from '../store.js';
import { runResolutionStoreConformance } from '../testing/index.js';
import { MAX_RESOLUTIONS_PER_USER, type Resolution } from '../types.js';
import { createSqliteResolutionStore, type SqliteResolutionStore } from './sqlite-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const loader = join(here, '..', '..', 'sqlite', 'ts-loader.mjs');
const dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-resolutions-'));
  dirs.push(dir);
  return dir;
};
const openAt = (path: string, busyTimeoutMs?: number): SqliteResolutionStore => {
  const store = createSqliteResolutionStore(busyTimeoutMs === undefined ? { path } : { path, busyTimeoutMs });
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const U1 = 'u0000000000000001';
const U2 = 'u0000000000000002';
const C1 = 'c0000000000000001';
const C2 = 'c0000000000000002';
const circle = (circleId: string) => ({ kind: 'circle' as const, circleId });
const res = (extra: Partial<Resolution> = {}): Resolution => ({ userId: U1, scope: circle(C1), factId: 'f1', verb: 'pay', at: 1000, ...extra });
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (cause) {
    return cause instanceof DbError ? cause.code : `other: ${String(cause)}`;
  }
  return undefined;
};

// The whole resolution store contract: on a private in-memory database per test, and again on a real file per test.
runResolutionStoreConformance(() => createSqliteResolutionStore(), { describe, it }, { dispose: (store) => (store as SqliteResolutionStore).close() });
{
  const homes = new Map<ResolutionStore, string>();
  describe('on a file', () => {
    runResolutionStoreConformance(
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'caci-resolutions-conf-'));
        const store = createSqliteResolutionStore({ path: join(dir, 'users.db') });
        homes.set(store, dir);
        return store;
      },
      { describe, it },
      {
        dispose: (store) => {
          (store as SqliteResolutionStore).close();
          rmSync(homes.get(store) as string, { recursive: true, force: true });
        },
      },
    );
  });
}

describe('the schema', () => {
  it('is version 11 with the table, its index and the two triggers', () => {
    const dir = tmp();
    openAt(join(dir, 'users.db'));
    const db = openDb({ path: join(dir, 'users.db') });
    stores.push(db);
    expect(USERS_SCHEMA_VERSION).toBe(11);
    expect(db.pragma('user_version')).toBe(11);
    expect(db.pragma('application_id')).toBe(USERS_APPLICATION_ID);
    const names = (type: string): string[] => db.all<{ name: string }>('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name', type).map((r) => r.name);
    expect(names('table')).toContain('fact_resolutions');
    expect(names('index')).toContain('fact_resolutions_by_fact');
    expect(names('trigger')).toEqual(expect.arrayContaining(['fact_resolutions_clear_user', 'fact_resolutions_clear_circle']));
  });

  it('has no column that could hold text from a fact', () => {
    const dir = tmp();
    openAt(join(dir, 'users.db'));
    const db = openDb({ path: join(dir, 'users.db') });
    stores.push(db);
    const columns = db.all<{ name: string }>("SELECT name FROM pragma_table_info('fact_resolutions') ORDER BY cid").map((c) => c.name);
    expect(columns).toEqual(['user_id', 'scope_kind', 'scope_id', 'fact_id', 'verb', 'at']);
  });

  it('upgrades a version 10 file without touching the users, circles, sessions, ledger or usage in it', async () => {
    const dir = tmp();
    const path = join(dir, 'users.db');
    const old = openDb({ path });
    prepareSchema(old, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS.slice(0, 10), foreignCode: 'NOT_A_USERS_DATABASE' });
    old.run("INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES ('u0000000000000001', 'ann', 'Ann', 'h', 'admin', 1, 1)");
    old.run("INSERT INTO circles (id, name, created_at, updated_at) VALUES ('c1', 'Club', 1, 1)");
    old.run("INSERT INTO ledger (id, at, scope_kind, scope_id, actor, action, kind, subject, proposal_id) VALUES ('l1', 1, 'personal', 'u1', 'u1', 'added', 'item', '\"s\"', 'p')");
    old.run("INSERT INTO usage (at, user_id, capability, scope_kind, scope_id, model, attempt, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, result, latency_ms) VALUES (1, NULL, 'status', 'personal', '', 'm', 1, 1, 1, 0, 0, 'ok', 1)");
    expect(old.pragma('user_version')).toBe(10);
    old.close();
    const store = openAt(path);
    expect(await store.count(U1)).toBe(0);
    const db = openDb({ path });
    stores.push(db);
    expect(db.pragma('user_version')).toBe(11);
    for (const table of ['users', 'circles', 'ledger', 'usage']) expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n, table).toBe(1);
  });

  it('is shared with the user, session, circle and ledger stores: all five open one file', async () => {
    const path = join(tmp(), 'users.db');
    const users = createSqliteUserStore({ path });
    const sessions = createSqliteSessionStore({ path });
    const circles = createSqliteCircleStore({ path });
    const ledger = createSqliteLedgerStore({ path });
    const resolutions = openAt(path);
    stores.push(users, sessions, circles, ledger);
    expect((await resolutions.set(res())).ok).toBe(true);
    expect(await users.count()).toBe(0);
    expect(await resolutions.count(U1)).toBe(1);
  });

  it('refuses the graph database and a newer schema, leaving the file untouched', async () => {
    const dir = tmp();
    const graphs = createSqliteAdapter({ path: join(dir, 'graphs.db') });
    await graphs.close();
    expect(codeOf(() => createSqliteResolutionStore({ path: join(dir, 'graphs.db') }))).toBe('NOT_A_USERS_DATABASE');
    const newer = openDb({ path: join(dir, 'newer.db') });
    prepareSchema(newer, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS, foreignCode: 'NOT_A_USERS_DATABASE' });
    newer.exec(`PRAGMA user_version = ${USERS_SCHEMA_VERSION + 1}`);
    newer.close();
    expect(codeOf(() => createSqliteResolutionStore({ path: join(dir, 'newer.db') }))).toBeDefined();
  });
});

describe('what the database itself refuses', () => {
  it('a bad user id, scope, fact id, verb or time', () => {
    const dir = tmp();
    openAt(join(dir, 'users.db'));
    const db = openDb({ path: join(dir, 'users.db') });
    stores.push(db);
    const insert = (over: Record<string, string | number>): void => {
      const v = { user_id: U1, scope_kind: 'circle', scope_id: C1, fact_id: 'f', verb: 'pay', at: 1, ...over };
      db.run('INSERT INTO fact_resolutions (user_id, scope_kind, scope_id, fact_id, verb, at) VALUES (?, ?, ?, ?, ?, ?)', v.user_id, v.scope_kind, v.scope_id, v.fact_id, v.verb, v.at);
    };
    expect(() => insert({})).not.toThrow();
    expect(() => insert({ scope_kind: 'personal', scope_id: '' })).not.toThrow();
    expect(() => insert({ fact_id: 'a'.repeat(256), verb: 'a-b-9' })).not.toThrow();
    for (const bad of [{ user_id: 'someone' }, { user_id: 'x0000000000000001' }, { scope_kind: 'group' }, { scope_id: '' }, { scope_id: 'c1' }, { scope_kind: 'personal' }, { scope_kind: 'personal', scope_id: C1 }, { fact_id: '' }, { fact_id: 'a'.repeat(257) }, { verb: '' }, { verb: 'Pay' }, { verb: 'a b' }, { verb: 'a'.repeat(21) }, { verb: 'x/y' }, { at: -1 }, { fact_id: 'f' }]) {
      expect(() => insert(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('records go when the person or the circle goes', () => {
  it('deleting a user row removes that person\'s records and nobody else\'s, whoever deletes it', async () => {
    const path = join(tmp(), 'users.db');
    const store = openAt(path);
    const users = createSqliteUserStore({ path });
    stores.push(users);
    for (const [id, name] of [[U1, 'ann'], [U2, 'bob']] as const) expect((await users.create({ id, username: name, displayName: name, role: 'user', passwordHash: 'h', createdAt: 1 })).ok).toBe(true);
    await store.set(res());
    await store.set(res({ factId: 'f2', scope: { kind: 'personal' } }));
    await store.set(res({ userId: U2 }));
    expect((await users.delete(U2)).ok).toBe(true);
    expect(await store.count(U2)).toBe(0);
    expect(await store.count(U1)).toBe(2);
    expect((await users.delete(U1)).ok).toBe(true);
    expect(await store.count(U1)).toBe(0);
  });

  it('deleting a circle row removes every person\'s records in that circle, and only that circle\'s', async () => {
    const path = join(tmp(), 'users.db');
    const store = openAt(path);
    const db = openDb({ path });
    stores.push(db);
    db.run("INSERT INTO circles (id, name, created_at, updated_at) VALUES (?, 'A', 1, 1)", C1);
    db.run("INSERT INTO circles (id, name, created_at, updated_at) VALUES (?, 'B', 1, 1)", C2);
    await store.set(res());
    await store.set(res({ userId: U2 }));
    await store.set(res({ scope: circle(C2) }));
    await store.set(res({ scope: { kind: 'personal' }, factId: C1 }));
    db.run('DELETE FROM circles WHERE id = ?', C1);
    expect(await store.get(U1, circle(C1), 'f1')).toBeUndefined();
    expect(await store.get(U2, circle(C1), 'f1')).toBeUndefined();
    expect(await store.get(U1, circle(C2), 'f1')).toBeDefined();
    expect(await store.get(U1, { kind: 'personal' }, C1)).toBeDefined();
  });

  it('a circle deleted through the circle store takes its records too', async () => {
    const path = join(tmp(), 'users.db');
    const store = openAt(path);
    const circles = createSqliteCircleStore({ path });
    stores.push(circles);
    const db = openDb({ path });
    stores.push(db);
    db.run("INSERT INTO circles (id, name, created_at, updated_at) VALUES (?, 'A', 1, 1)", C1);
    await store.set(res());
    db.run('DELETE FROM circles WHERE id = ?', C1);
    expect(await store.count(U1)).toBe(0);
  });
});

describe('storage details', () => {
  it('the cap is held on a file too, and replacing a record at the cap keeps the count', async () => {
    const store = openAt(join(tmp(), 'users.db'));
    for (let i = 0; i < MAX_RESOLUTIONS_PER_USER; i++) expect((await store.set(res({ factId: `f${i}` }))).ok).toBe(true);
    const over = await store.set(res({ factId: 'more' }));
    expect(!over.ok && over.error.code).toBe('LIMIT_REACHED');
    expect((await store.set(res({ factId: 'f0', verb: 'clear' }))).ok).toBe(true);
    expect(await store.count(U1)).toBe(MAX_RESOLUTIONS_PER_USER);
  }, 60000);

  it('keeps everything across close and reopen; a clean close leaves one file; the file is owner-only', async () => {
    const dir = tmp();
    const path = join(dir, 'users.db');
    const first = openAt(path);
    await first.set(res({ factId: '😀 id' }));
    await first.set(res({ factId: 'f2' }));
    first.close();
    expect(readdirSync(dir)).toEqual(['users.db']);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = openAt(path);
    expect(await second.count(U1)).toBe(2);
    expect((await second.get(U1, circle(C1), '😀 id'))?.verb).toBe('pay');
  });

  it('refuses a fact id with a lone surrogate instead of storing a different one', async () => {
    const store = openAt(join(tmp(), 'users.db'));
    const result = await store.set(res({ factId: `a${String.fromCharCode(0xd800)}b` }));
    expect(result.ok).toBe(false);
    expect(await store.count(U1)).toBe(0);
  });

  it('two stores on one file see each other', async () => {
    const path = join(tmp(), 'users.db');
    const a = openAt(path);
    const b = openAt(path);
    await a.set(res());
    expect(await b.count(U1)).toBe(1);
    expect(await b.remove(U1, circle(C1), 'f1')).toBe(true);
    expect(await a.count(U1)).toBe(0);
  });

  it('a lock held past the timeout is a clear error, nothing is changed, and it works again afterwards', async () => {
    const path = join(tmp(), 'users.db');
    const store = openAt(path, 50);
    const holder = openDb({ path });
    stores.push(holder);
    holder.begin();
    const result = await store.set(res());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STORAGE_ERROR');
      expect(result.error.message).not.toMatch(/INSERT|SELECT/i);
    }
    holder.rollback();
    expect((await store.set(res())).ok).toBe(true);
    expect(await store.count(U1)).toBe(1);
  });

  it('a write killed part-way (kill -9 inside the transaction) leaves none of it, and the file works again', async () => {
    const dir = tmp();
    const path = join(dir, 'users.db');
    const store = openAt(path);
    await store.set(res());
    store.close();
    const child = spawn(process.execPath, ['--import', loader, join(here, 'kill-child.mjs'), path], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.includes('ready')) resolve();
      });
      child.on('exit', () => reject(new Error('the child ended early')));
    });
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
    const again = openAt(path);
    expect(await again.count(U1)).toBe(1);
    expect(await again.count(U2)).toBe(0);
    expect((await again.set(res({ factId: 'after' }))).ok).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('two processes setting at once lose none', async () => {
    const path = join(tmp(), 'users.db');
    const parent = openAt(path);
    const run = (name: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', loader, join(here, 'set-child.mjs'), path, name, '40'], { stdio: ['ignore', 'ignore', 'inherit'] });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child ${name} exited ${code}`))));
      });
    await Promise.all([run('a'), run('b')]);
    expect(await parent.count(U1)).toBe(80);
  }, 60000);
});

describe('the memory store and the SQLite store agree', () => {
  // A small deterministic generator, so a failure can be replayed from its seed.
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  it.each([1, 2, 3, 4, 5, 6])('over a random world (seed %i)', async (seed) => {
    const next = rng(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const sql = createSqliteResolutionStore();
    stores.push(sql);
    const mem = createMemoryResolutionStore();
    const users = [U1, U2, 'u0000000000000003'];
    const scopes = [{ kind: 'personal' as const }, circle(C1), circle(C2)];
    const ids = ['a', 'b', 'c', 'B', '😀', 'é', 'x y', '￿'];
    for (let step = 0; step < 300; step++) {
      const op = Math.floor(next() * 8);
      const userId = pick(users);
      const scope = pick(scopes);
      const factId = pick(ids);
      let a: unknown;
      let b: unknown;
      if (op <= 2) {
        const r = res({ userId, scope, factId, verb: pick(['pay', 'clear']), at: step });
        a = await mem.set(r);
        b = await sql.set(r);
      } else if (op === 3) {
        a = await mem.remove(userId, scope, factId);
        b = await sql.remove(userId, scope, factId);
      } else if (op === 4) {
        a = await mem.removeFact(scope, factId);
        b = await sql.removeFact(scope, factId);
      } else if (op === 5) {
        const circleId = scope.kind === 'circle' ? scope.circleId : C1;
        a = await mem.removeForCircle(circleId);
        b = await sql.removeForCircle(circleId);
      } else if (op === 6) {
        if (next() < 0.2) {
          a = await mem.removeForUser(userId);
          b = await sql.removeForUser(userId);
        } else {
          a = await mem.listFor(userId, scope, ids);
          b = await sql.listFor(userId, scope, ids);
        }
      } else {
        a = await mem.list(userId, { limit: 3 });
        b = await sql.list(userId, { limit: 3 });
      }
      expect(b, `step ${step} op ${op}`).toEqual(a);
    }
    for (const userId of users) expect(await sql.list(userId, { limit: 100 })).toEqual(await mem.list(userId, { limit: 100 }));
    expect(await sql.facts({ limit: 100 })).toEqual(await mem.facts({ limit: 100 }));
  });
});
