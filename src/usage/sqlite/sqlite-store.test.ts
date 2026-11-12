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
import type { UsageStore } from '../store.js';
import { runUsageStoreConformance } from '../testing/index.js';
import type { UsageRange, UsageRecord } from '../types.js';
import { createSqliteUsageStore, type SqliteUsageStore } from './sqlite-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const loader = join(here, '..', '..', 'sqlite', 'ts-loader.mjs');
const dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-usage-'));
  dirs.push(dir);
  return dir;
};
const openAt = (path: string, busyTimeoutMs?: number): SqliteUsageStore => {
  const store = createSqliteUsageStore(busyTimeoutMs === undefined ? { path } : { path, busyTimeoutMs });
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const U1 = 'u0000000000000001';
const ALL: UsageRange = { from: 0, to: Date.UTC(2100, 0, 1) };
const rec = (extra: Partial<UsageRecord> = {}): UsageRecord => ({ at: 1000, userId: U1, capability: 'categorise', scope: { kind: 'personal' }, model: 'm', attempt: 1, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, result: 'ok', latencyMs: 5, ...extra });
const attempts = async (store: UsageStore): Promise<number> => (await store.aggregate(ALL)).reduce((n, a) => n + a.attempts, 0);
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (cause) {
    return cause instanceof DbError ? cause.code : `other: ${String(cause)}`;
  }
  return undefined;
};

// The whole usage store contract: on a private in-memory database per test, and again on a real file per test.
runUsageStoreConformance(() => createSqliteUsageStore(), { describe, it }, { dispose: (store) => (store as SqliteUsageStore).close() });
{
  const homes = new Map<UsageStore, string>();
  describe('on a file', () => {
    runUsageStoreConformance(
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'caci-usage-conf-'));
        const store = createSqliteUsageStore({ path: join(dir, 'users.db') });
        homes.set(store, dir);
        return store;
      },
      { describe, it },
      {
        dispose: (store) => {
          (store as SqliteUsageStore).close();
          rmSync(homes.get(store) as string, { recursive: true, force: true });
        },
      },
    );
  });
}

describe('the schema', () => {
  it('is version 10 with the table, its indexes and the trigger', () => {
    const dir = tmp();
    openAt(join(dir, 'users.db'));
    const db = openDb({ path: join(dir, 'users.db') });
    stores.push(db);
    expect(USERS_SCHEMA_VERSION).toBe(10);
    expect(db.pragma('user_version')).toBe(10);
    expect(db.pragma('application_id')).toBe(USERS_APPLICATION_ID);
    const names = (type: string): string[] => db.all<{ name: string }>('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name', type).map((r) => r.name);
    expect(names('table')).toContain('usage');
    expect(names('index')).toEqual(expect.arrayContaining(['usage_by_time', 'usage_by_user']));
    expect(names('trigger')).toContain('usage_clears_user');
  });

  it('has no column that could hold text', () => {
    const dir = tmp();
    openAt(join(dir, 'users.db'));
    const db = openDb({ path: join(dir, 'users.db') });
    stores.push(db);
    const columns = db.all<{ name: string }>("SELECT name FROM pragma_table_info('usage') ORDER BY cid").map((c) => c.name);
    expect(columns).toEqual(['id', 'at', 'user_id', 'capability', 'scope_kind', 'scope_id', 'model', 'attempt', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'result', 'latency_ms']);
  });

  it('upgrades a version 9 file without touching the users, circles, sessions or ledger in it', async () => {
    const dir = tmp();
    const path = join(dir, 'users.db');
    const old = openDb({ path });
    prepareSchema(old, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS.slice(0, 9), foreignCode: 'NOT_A_USERS_DATABASE' });
    old.run("INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES ('u0000000000000001', 'ann', 'Ann', 'h', 'admin', 1, 1)");
    old.run("INSERT INTO circles (id, name, created_at, updated_at) VALUES ('c1', 'Club', 1, 1)");
    old.run("INSERT INTO ledger (id, at, scope_kind, scope_id, actor, action, kind, subject, proposal_id) VALUES ('l1', 1, 'personal', 'u1', 'u1', 'added', 'item', '\"s\"', 'p')");
    expect(old.pragma('user_version')).toBe(9);
    old.close();
    const store = openAt(path);
    expect(await attempts(store)).toBe(0);
    const db = openDb({ path });
    stores.push(db);
    expect(db.pragma('user_version')).toBe(10);
    for (const table of ['users', 'circles', 'ledger']) expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n, table).toBe(1);
  });

  it('is shared with the user, session, circle and ledger stores: all five open one file', async () => {
    const path = join(tmp(), 'users.db');
    const users = createSqliteUserStore({ path });
    const sessions = createSqliteSessionStore({ path });
    const circles = createSqliteCircleStore({ path });
    const ledger = createSqliteLedgerStore({ path });
    const usage = openAt(path);
    stores.push(users, sessions, circles, ledger);
    expect((await usage.append([rec()])).ok).toBe(true);
    expect(await users.count()).toBe(0);
    expect(await attempts(usage)).toBe(1);
  });

  it('refuses the graph database and a newer schema, leaving the file untouched', async () => {
    const dir = tmp();
    const graphs = createSqliteAdapter({ path: join(dir, 'graphs.db') });
    await graphs.close();
    expect(codeOf(() => createSqliteUsageStore({ path: join(dir, 'graphs.db') }))).toBe('NOT_A_USERS_DATABASE');
    const newer = openDb({ path: join(dir, 'newer.db') });
    prepareSchema(newer, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS, foreignCode: 'NOT_A_USERS_DATABASE' });
    newer.exec(`PRAGMA user_version = ${USERS_SCHEMA_VERSION + 1}`);
    newer.close();
    expect(codeOf(() => createSqliteUsageStore({ path: join(dir, 'newer.db') }))).toBeDefined();
  });
});

describe('what the database itself refuses', () => {
  it('a bad capability, scope, result, attempt, count, latency or user id, and a personal scope with an id', () => {
    const dir = tmp();
    openAt(join(dir, 'users.db'));
    const db = openDb({ path: join(dir, 'users.db') });
    stores.push(db);
    const insert = (over: Record<string, string | number | null>): void => {
      const v = { at: 1, user_id: U1, capability: 'status', scope_kind: 'personal', scope_id: '', model: 'm', attempt: 1, input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, result: 'ok', latency_ms: 1, ...over };
      db.run('INSERT INTO usage (at, user_id, capability, scope_kind, scope_id, model, attempt, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, result, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', v.at, v.user_id, v.capability, v.scope_kind, v.scope_id, v.model, v.attempt, v.input_tokens, v.output_tokens, v.cache_read_tokens, v.cache_creation_tokens, v.result, v.latency_ms);
    };
    expect(() => insert({})).not.toThrow();
    expect(() => insert({ user_id: null })).not.toThrow();
    expect(() => insert({ scope_kind: 'circle', scope_id: 'c0000000000000001' })).not.toThrow();
    for (const bad of [{ capability: 'agent' }, { scope_kind: 'group' }, { scope_kind: 'circle', scope_id: '' }, { scope_id: 'c0000000000000001' }, { result: 'maybe' }, { attempt: 3 }, { attempt: 0 }, { input_tokens: -1 }, { input_tokens: 1_000_000_001 }, { output_tokens: -1 }, { cache_read_tokens: 11 }, { cache_read_tokens: 6, cache_creation_tokens: 5 }, { cache_creation_tokens: -1 }, { latency_ms: 86_400_001 }, { latency_ms: -1 }, { at: -1 }, { model: '' }, { user_id: 'someone' }, { user_id: 'u1' }, { user_id: 'x0000000000000001' }]) {
      expect(() => insert(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('records lose their person when the account goes', () => {
  it('deleting a user row clears that person on their records and keeps the rest, whoever deletes it', async () => {
    const path = join(tmp(), 'users.db');
    const usage = openAt(path);
    const users = createSqliteUserStore({ path });
    stores.push(users);
    for (const [n, name] of [[1, 'ann'], [2, 'bob']] as const) {
      const made = await users.create({ id: `u${String(n).padStart(16, '0')}`, username: name, displayName: name, role: 'user', passwordHash: 'h', createdAt: 1 });
      expect(made.ok).toBe(true);
    }
    await usage.append([rec(), rec({ at: 2000, attempt: 2 }), rec({ userId: 'u0000000000000002' })]);
    expect((await users.delete('u0000000000000002')).ok).toBe(true);
    expect((await usage.aggregate(ALL)).map((r) => [r.userId, r.attempts])).toEqual([[U1, 2], [null, 1]]);
    expect((await users.delete(U1)).ok).toBe(true);
    const rows = await usage.aggregate(ALL);
    expect(rows.map((r) => r.userId)).toEqual([null]);
    expect(rows[0]?.attempts).toBe(3);
    expect(rows[0]?.inputTokens).toBe(30);
  });

  it('a direct delete of the row does the same, and an unrelated person is untouched', async () => {
    const path = join(tmp(), 'users.db');
    const usage = openAt(path);
    const db = openDb({ path });
    stores.push(db);
    db.run("INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES ('u0000000000000001', 'ann', 'Ann', 'h', 'admin', 1, 1)");
    await usage.append([rec(), rec({ userId: 'u0000000000000002' })]);
    db.run("DELETE FROM users WHERE id = 'u0000000000000001'");
    expect((await usage.aggregate(ALL)).map((r) => r.userId)).toEqual(['u0000000000000002', null]);
  });
});

describe('durability and sharing', () => {
  it('keeps everything across close and reopen; a clean close leaves one file; the file is owner-only', async () => {
    const dir = tmp();
    const path = join(dir, 'users.db');
    const first = openAt(path);
    await first.append([rec({ model: '😀-model', scope: { kind: 'circle', circleId: 'c0000000000000001' } }), rec({ at: 2000 })]);
    first.close();
    expect(readdirSync(dir)).toEqual(['users.db']);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = openAt(path);
    expect(await attempts(second)).toBe(2);
    expect((await second.aggregate(ALL)).map((r) => r.model).sort()).toEqual(['m', '😀-model']);
  });

  it('refuses a model name with a lone surrogate instead of storing a different one', async () => {
    const store = openAt(join(tmp(), 'users.db'));
    const result = await store.append([rec({ model: `a${String.fromCharCode(0xd800)}b` })]);
    expect(result.ok).toBe(false);
    expect(await attempts(store)).toBe(0);
  });

  it('two stores on one file see each other', async () => {
    const path = join(tmp(), 'users.db');
    const a = openAt(path);
    const b = openAt(path);
    await a.append([rec()]);
    expect(await attempts(b)).toBe(1);
    expect(await b.purgeBefore(1_000_000)).toBe(1);
    expect(await attempts(a)).toBe(0);
  });

  it('a lock held past the timeout is a clear error, nothing is changed, and it works again afterwards', async () => {
    const path = join(tmp(), 'users.db');
    const store = openAt(path, 50);
    const holder = openDb({ path });
    stores.push(holder);
    holder.begin();
    const result = await store.append([rec()]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STORAGE_ERROR');
      expect(result.error.message).not.toMatch(/INSERT|SELECT/i);
    }
    holder.rollback();
    expect((await store.append([rec()])).ok).toBe(true);
    expect(await attempts(store)).toBe(1);
  });

  it('a batch killed part-way (kill -9 inside the transaction) leaves none of it, and the file works again', async () => {
    const dir = tmp();
    const path = join(dir, 'users.db');
    const store = openAt(path);
    await store.append([rec()]);
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
    expect(await attempts(again)).toBe(1);
    expect((await again.append([rec({ at: 3000 })])).ok).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('two processes appending at once lose none', async () => {
    const path = join(tmp(), 'users.db');
    const parent = openAt(path);
    const run = (name: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', loader, join(here, 'append-child.mjs'), path, name, '40'], { stdio: ['ignore', 'ignore', 'inherit'] });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child ${name} exited ${code}`))));
      });
    await Promise.all([run('a'), run('b')]);
    expect(await attempts(parent)).toBe(80);
  }, 60000);
});
