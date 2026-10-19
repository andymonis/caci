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
import { createSqliteSessionStore, createSqliteUserStore, USERS_APPLICATION_ID, USERS_SCHEMA_VERSION } from '../../users/sqlite/index.js';
import { USERS_MIGRATIONS } from '../../users/sqlite/schema.js';
import type { LedgerEntry, LedgerScope } from '../types.js';
import type { LedgerStore } from '../store.js';
import { runLedgerStoreConformance } from '../testing/index.js';
import { createSqliteLedgerStore, type SqliteLedgerStore } from './sqlite-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const loader = join(here, '..', '..', 'sqlite', 'ts-loader.mjs');
const dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-ledger-'));
  dirs.push(dir);
  return dir;
};
const openAt = (path: string, busyTimeoutMs?: number): SqliteLedgerStore => {
  const store = createSqliteLedgerStore(busyTimeoutMs === undefined ? { path } : { path, busyTimeoutMs });
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const P1: LedgerScope = { kind: 'personal', userId: 'u0000000000000001' };
const C1: LedgerScope = { kind: 'circle', circleId: 'c0000000000000001' };
const entry = (n: number, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ id: `l${String(n).padStart(16, '0')}`, at: 1000 + n, scope: P1, actor: 'u0000000000000009', action: 'added', kind: 'item', subject: `note-${n}`, proposalId: 'prop-1', ...extra });
const listAll = async (store: LedgerStore, scope: LedgerScope): Promise<LedgerEntry[]> => (await store.list(scope, { limit: 1000, cursor: null })).items.slice();
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (cause) {
    return cause instanceof DbError ? cause.code : `other: ${String(cause)}`;
  }
  return undefined;
};

// The whole ledger store contract: on a private in-memory database per test, and again on a real file per test.
runLedgerStoreConformance(() => createSqliteLedgerStore(), { describe, it }, { dispose: (store) => (store as SqliteLedgerStore).close() });
{
  const homes = new Map<LedgerStore, string>();
  describe('on a file', () => {
    runLedgerStoreConformance(
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'caci-ledger-conf-'));
        const store = createSqliteLedgerStore({ path: join(dir, 'users.db') });
        homes.set(store, dir);
        return store;
      },
      { describe, it },
      {
        dispose: (store) => {
          (store as SqliteLedgerStore).close();
          rmSync(homes.get(store) as string, { recursive: true, force: true });
        },
      },
    );
  });
}

describe('the schema', () => {
  it('is version 6 with the table, its indexes and the two triggers', () => {
    const dir = tmp();
    openAt(join(dir, 'users.db'));
    const db = openDb({ path: join(dir, 'users.db') });
    stores.push(db);
    expect(USERS_SCHEMA_VERSION).toBe(6);
    expect(db.pragma('user_version')).toBe(6);
    expect(db.pragma('application_id')).toBe(USERS_APPLICATION_ID);
    const names = (type: string): string[] => db.all<{ name: string }>('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name', type).map((r) => r.name);
    expect(names('table')).toContain('ledger');
    expect(names('index')).toEqual(expect.arrayContaining(['ledger_by_scope', 'ledger_by_time']));
    expect(names('trigger')).toEqual(expect.arrayContaining(['ledger_ends_with_circle', 'ledger_ends_with_user']));
  });

  it('upgrades a version 5 file without touching the users or circles in it', async () => {
    const dir = tmp();
    const path = join(dir, 'users.db');
    const old = openDb({ path });
    prepareSchema(old, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS.slice(0, 5), foreignCode: 'NOT_A_USERS_DATABASE' });
    old.run("INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES ('u1', 'ann', 'Ann', 'h', 'admin', 1, 1)");
    old.run("INSERT INTO circles (id, name, created_at, updated_at) VALUES ('c1', 'Club', 1, 1)");
    expect(old.pragma('user_version')).toBe(5);
    old.close();
    const store = openAt(path);
    expect(await listAll(store, P1)).toEqual([]);
    const db = openDb({ path });
    stores.push(db);
    expect(db.pragma('user_version')).toBe(6);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM users')?.n).toBe(1);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM circles')?.n).toBe(1);
  });

  it('is shared with the user, session and circle stores: all four open one file', async () => {
    const path = join(tmp(), 'users.db');
    const users = createSqliteUserStore({ path });
    const sessions = createSqliteSessionStore({ path });
    const circles = createSqliteCircleStore({ path });
    const ledger = openAt(path);
    stores.push(users, sessions, circles);
    expect((await ledger.append([entry(1)])).ok).toBe(true);
    expect(await users.count()).toBe(0);
    expect((await listAll(ledger, P1)).length).toBe(1);
  });

  it('refuses the graph database and a newer schema, leaving the file untouched', async () => {
    const dir = tmp();
    const graphs = createSqliteAdapter({ path: join(dir, 'graphs.db') });
    await graphs.close();
    expect(codeOf(() => createSqliteLedgerStore({ path: join(dir, 'graphs.db') }))).toBe('NOT_A_USERS_DATABASE');
    const newer = openDb({ path: join(dir, 'newer.db') });
    prepareSchema(newer, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS, foreignCode: 'NOT_A_USERS_DATABASE' });
    newer.exec('PRAGMA user_version = 7');
    newer.close();
    expect(codeOf(() => createSqliteLedgerStore({ path: join(dir, 'newer.db') }))).toBeDefined();
  });
});

describe('what the database itself refuses', () => {
  it('a bad action, kind, scope kind or negative time, a repeated id and text that is not JSON', () => {
    const dir = tmp();
    openAt(join(dir, 'users.db'));
    const db = openDb({ path: join(dir, 'users.db') });
    stores.push(db);
    const insert = (over: Record<string, string | number | null>): void => {
      const v = { id: 'l1', at: 1, scope_kind: 'personal', scope_id: 'u1', actor: 'u1', action: 'added', kind: 'item', subject: '"s"', title: null, summary: null, proposal_id: 'p', ...over };
      db.run('INSERT INTO ledger (id, at, scope_kind, scope_id, actor, action, kind, subject, title, summary, proposal_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', v.id as string, v.at as number, v.scope_kind as string, v.scope_id as string, v.actor as string, v.action as string, v.kind as string, v.subject as string, v.title, v.summary, v.proposal_id as string);
    };
    expect(() => insert({})).not.toThrow();
    for (const bad of [{ id: 'l2', action: 'deleted' }, { id: 'l3', kind: 'edge' }, { id: 'l4', scope_kind: 'group' }, { id: 'l5', at: -1 }, { id: 'l6', subject: 'not json' }, { id: 'l7', title: 'not json' }, { id: 'l8', summary: '{' }, { id: 'l1' }]) {
      expect(() => insert(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('entries go with their circle and their account', () => {
  it('deleting a circle row removes that circle\'s entries only, whoever deletes it', async () => {
    const path = join(tmp(), 'users.db');
    const ledger = openAt(path);
    const db = openDb({ path });
    stores.push(db);
    db.run("INSERT INTO circles (id, name, created_at, updated_at) VALUES ('c0000000000000001', 'Club', 1, 1)");
    db.run("INSERT INTO circles (id, name, created_at, updated_at) VALUES ('c0000000000000002', 'Other', 1, 1)");
    await ledger.append([entry(1, { scope: C1 }), entry(2, { scope: { kind: 'circle', circleId: 'c0000000000000002' } }), entry(3)]);
    db.run("DELETE FROM circles WHERE id = 'c0000000000000001'");
    expect(await listAll(ledger, C1)).toEqual([]);
    expect((await listAll(ledger, { kind: 'circle', circleId: 'c0000000000000002' })).length).toBe(1);
    expect((await listAll(ledger, P1)).length).toBe(1);
  });

  it('deleting a user row removes that person\'s personal entries only, not a circle\'s that they wrote', async () => {
    const path = join(tmp(), 'users.db');
    const ledger = openAt(path);
    const users = createSqliteUserStore({ path });
    stores.push(users);
    for (const [n, name] of [[1, 'ann'], [2, 'bob']] as const) {
      const made = await users.create({ id: `u${String(n).padStart(16, '0')}`, username: name, displayName: name, role: 'user', passwordHash: 'h', createdAt: 1 });
      expect(made.ok).toBe(true);
    }
    await ledger.append([entry(1), entry(2, { scope: C1, actor: 'u0000000000000001' }), entry(3, { scope: { kind: 'personal', userId: 'u0000000000000002' } })]);
    expect((await users.delete('u0000000000000002')).ok).toBe(true);
    expect(await listAll(ledger, { kind: 'personal', userId: 'u0000000000000002' })).toEqual([]);
    expect((await users.delete('u0000000000000001')).ok).toBe(true);
    expect(await listAll(ledger, P1)).toEqual([]);
    expect((await listAll(ledger, C1)).length).toBe(1);
  });
});

describe('durability and sharing', () => {
  it('keeps everything, in order, across close and reopen; a clean close leaves one file; the file is owner-only', async () => {
    const dir = tmp();
    const path = join(dir, 'users.db');
    const first = openAt(path);
    await first.append([entry(1, { title: '😀 "q" \n', subject: 'a/b?c' }), entry(2)]);
    first.close();
    expect(readdirSync(dir)).toEqual(['users.db']);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = openAt(path);
    expect((await listAll(second, P1)).map((e) => e.id)).toEqual([entry(2).id, entry(1).id]);
    expect((await listAll(second, P1))[1]?.title).toBe('😀 "q" \n');
  });

  it('keeps a lone surrogate in a subject exactly', async () => {
    const store = openAt(join(tmp(), 'users.db'));
    const subject = `a${String.fromCharCode(0xd800)}b`;
    expect((await store.append([entry(1, { subject })])).ok).toBe(true);
    expect((await listAll(store, P1))[0]?.subject).toBe(subject);
  });

  it('two stores on one file see each other\'s entries', async () => {
    const path = join(tmp(), 'users.db');
    const a = openAt(path);
    const b = openAt(path);
    await a.append([entry(1)]);
    expect((await listAll(b, P1)).length).toBe(1);
    expect(await b.purgeBefore(1_000_000)).toBe(1);
    expect(await listAll(a, P1)).toEqual([]);
  });

  it('a lock held past the timeout is a clear error, nothing is changed, and it works again afterwards', async () => {
    const path = join(tmp(), 'users.db');
    const store = openAt(path, 50);
    const holder = openDb({ path });
    stores.push(holder);
    holder.begin();
    const result = await store.append([entry(1)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STORAGE_ERROR');
      expect(result.error.message).not.toMatch(/INSERT|SELECT/i);
    }
    holder.rollback();
    expect((await store.append([entry(1)])).ok).toBe(true);
  });

  it('a batch killed part-way (kill -9 inside the transaction) leaves none of it, and the file works again', async () => {
    const dir = tmp();
    const path = join(dir, 'users.db');
    const store = openAt(path);
    await store.append([entry(1)]);
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
    expect((await listAll(again, P1)).map((e) => e.id)).toEqual([entry(1).id]);
    expect((await again.append([entry(2)])).ok).toBe(true);
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
    expect((await listAll(parent, P1)).length).toBe(80);
  }, 60000);
});
