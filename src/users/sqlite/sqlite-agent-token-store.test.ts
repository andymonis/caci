import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../sqlite/db.js';
import { prepareSchema } from '../../sqlite/prepare.js';
import { hashAgentToken, type AgentTokenInput } from '../agent-tokens.js';
import { runAgentTokenStoreConformance } from '../testing/index.js';
import { USERS_APPLICATION_ID, USERS_MIGRATIONS, USERS_SCHEMA_VERSION } from './schema.js';
import { createSqliteAgentTokenStore, type SqliteAgentTokenStore } from './sqlite-agent-token-store.js';
import { createSqliteUserStore } from './sqlite-store.js';

const dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-agent-tokens-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tokensAt = (path: string, options = {}): SqliteAgentTokenStore => {
  const store = createSqliteAgentTokenStore({ path, ...options });
  stores.push(store);
  return store;
};
const T0 = 1_000_000_000_000;
const DAY = 86_400_000;
const ANN = 'u0000000000000001';
const input = (extra: Partial<AgentTokenInput> = {}): AgentTokenInput => ({ userId: ANN, name: 'Agent', scopes: ['personal'], checks: false, expiresAt: T0 + 90 * DAY, ...extra });
const created = async (store: SqliteAgentTokenStore, extra: Partial<AgentTokenInput> = {}) => {
  const r = await store.create(input(extra), T0);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

// The whole agent token store contract: in memory, and on a real file per test.
runAgentTokenStoreConformance(() => createSqliteAgentTokenStore(), { describe, it }, { dispose: (s) => (s as SqliteAgentTokenStore).close() });
{
  const homes = new Map<object, string>();
  describe('on a file', () => {
    runAgentTokenStoreConformance(
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'caci-agent-tokens-conf-'));
        const store = createSqliteAgentTokenStore({ path: join(dir, 'users.db') });
        homes.set(store, dir);
        return store;
      },
      { describe, it },
      {
        dispose: (s) => {
          (s as SqliteAgentTokenStore).close();
          rmSync(homes.get(s) as string, { recursive: true, force: true });
        },
      },
    );
  });
}

describe('agent tokens in the database file', () => {
  it('never write the token itself anywhere in the file: only its SHA-256', async () => {
    const path = join(tmp(), 'users.db');
    const store = tokensAt(path);
    const { token } = await created(store);
    await store.resolve(token, T0 + 70_000); // a renewal writes too
    store.close();
    const bytes = Buffer.concat(readdirSync(join(path, '..')).map((name) => readFileSync(join(path, '..', name))));
    expect(bytes.includes(Buffer.from(token))).toBe(false);
    expect(bytes.includes(Buffer.from(token.slice(5)))).toBe(false);
    expect(bytes.includes(Buffer.from(token.slice(5), 'base64url'))).toBe(false);
    expect(bytes.includes(Buffer.from(hashAgentToken(token)))).toBe(true);
  });

  it('a stolen copy of the database cannot be used: the stored hash is not a token', async () => {
    const path = join(tmp(), 'users.db');
    const store = tokensAt(path);
    await created(store);
    const db = openDb({ path });
    const rows = db.all<{ token_hash: string }>('SELECT token_hash FROM agent_tokens');
    db.close();
    expect(rows).toHaveLength(1);
    const hash = rows[0]?.token_hash as string;
    for (const attempt of [hash, `cpat_${Buffer.from(hash, 'hex').toString('base64url')}`, Buffer.from(hash, 'hex').toString('base64url')]) expect(await store.resolve(attempt, T0 + 1)).toBeUndefined();
  });

  it('survive a restart, with the renewed last-used time', async () => {
    const path = join(tmp(), 'users.db');
    const first = tokensAt(path);
    const { token, info } = await created(first);
    await first.resolve(token, T0 + 5000);
    first.close();
    const second = tokensAt(path);
    expect(await second.resolve(token, T0 + 6000)).toMatchObject({ userId: ANN, tokenId: info.id });
    expect((await second.list(ANN, T0 + 6000))[0]?.lastUsedAt).toBe(T0 + 5000);
  });

  it('are shared by two stores on one file', async () => {
    const path = join(tmp(), 'users.db');
    const a = tokensAt(path);
    const b = tokensAt(path);
    const { token, info } = await created(a);
    expect(await b.resolve(token, T0 + 1)).toBeDefined();
    expect(await b.revoke(ANN, info.id)).toBe(true);
    expect(await a.resolve(token, T0 + 1)).toBeUndefined();
  });

  it('keep a name with any characters, and the scopes in order', async () => {
    const store = tokensAt(join(tmp(), 'users.db'));
    const { token } = await created(store, { name: `Ann's "agent" <b>é😀</b> 日本`, scopes: ['circle:cabcdefghij012345', 'personal'] });
    expect((await store.list(ANN, T0 + 1))[0]?.name).toBe(`Ann's "agent" <b>é😀</b> 日本`);
    expect([...((await store.resolve(token, T0 + 1))?.scopes ?? [])]).toEqual(['circle:cabcdefghij012345', 'personal']);
  });

  it('end when their user is deleted from the user store (the database does it, not the caller), and only that user’s', async () => {
    const path = join(tmp(), 'users.db');
    const users = createSqliteUserStore({ path });
    stores.push(users);
    const tokens = tokensAt(path);
    const record = (n: number) => ({ id: `u${String(n).padStart(16, '0')}`, username: `user${n}`, displayName: 'x', role: 'user' as const, passwordHash: 'h', createdAt: 1 });
    await users.create(record(1));
    await users.create(record(2));
    const a = await created(tokens, { userId: record(1).id });
    const b = await created(tokens, { userId: record(2).id });
    await users.delete(record(1).id);
    expect(await tokens.resolve(a.token, T0 + 1)).toBeUndefined();
    expect(await tokens.resolve(b.token, T0 + 1)).toBeDefined();
    expect(typeof (await created(tokens, { userId: 'someone-with-no-row' })).token).toBe('string'); // a token for a user with no row is allowed: the store does not know about users
  });

  it('is version 8 with the table, its indexes and the trigger', () => {
    const path = join(tmp(), 'users.db');
    tokensAt(path).close();
    const db = openDb({ path });
    expect(USERS_SCHEMA_VERSION).toBe(10);
    expect(db.pragma('user_version')).toBe(10);
    expect(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE tbl_name = 'agent_tokens' ORDER BY name").map((r) => r.name)).toEqual(expect.arrayContaining(['agent_tokens', 'agent_tokens_by_expiry', 'agent_tokens_by_user']));
    expect(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'agent_tokens_end_with_user'")?.name).toBe('agent_tokens_end_with_user');
    db.close();
  });

  it('are added to a version 7 database without touching its users', async () => {
    const path = join(tmp(), 'users.db');
    const db = openDb({ path });
    prepareSchema(db, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS.slice(0, 7), foreignCode: 'NOT_A_USERS_DATABASE' });
    db.run("INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES ('u0000000000000001', 'ann', 'Ann', 'admin', 'h', 1, 1)");
    expect(db.pragma('user_version')).toBe(7);
    db.close();
    const store = tokensAt(path); // opening upgrades it
    const { token } = await created(store);
    expect(await store.resolve(token, T0 + 1)).toBeDefined();
    const after = openDb({ path });
    expect(after.pragma('user_version')).toBe(10);
    expect(after.get<{ username: string }>("SELECT username FROM users WHERE id = 'u0000000000000001'")?.username).toBe('ann');
    after.close();
  });

  it('the database itself refuses a bad scopes value, a past expiry, an empty name and a repeated id', () => {
    const path = join(tmp(), 'users.db');
    tokensAt(path).close();
    const db = openDb({ path });
    const insert = (id: string, hash: string, name: string, scopes: string, created: number, expires: number, checks = 0): void => {
      db.run('INSERT INTO agent_tokens (token_hash, id, user_id, name, scopes, checks, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', hash, id, 'u1', name, scopes, checks, created, expires);
    };
    insert('t1', 'h1', 'ok', '["personal"]', 1, 2);
    expect(() => insert('t2', 'h2', 'ok', 'not json', 1, 2)).toThrow();
    expect(() => insert('t3', 'h3', 'ok', '{"a":1}', 1, 2)).toThrow();
    expect(() => insert('t4', 'h4', '', '[]', 1, 2)).toThrow();
    expect(() => insert('t5', 'h5', 'ok', '[]', 5, 5)).toThrow();
    expect(() => insert('t6', 'h6', 'ok', '[]', 1, 2, 2)).toThrow();
    expect(() => insert('t1', 'h7', 'ok', '[]', 1, 2)).toThrow();
    expect(() => insert('t8', 'h1', 'ok', '[]', 1, 2)).toThrow();
    db.close();
  });

  it('count the limit in one transaction: the 11th is refused, and a failed create rolls back and the store keeps working', async () => {
    const draws = [1, 1, 1, 2];
    let n = 0;
    const store = tokensAt(join(tmp(), 'users.db'), { randomBytes: (len: number) => new Uint8Array(len).fill(draws[n++] ?? 4) });
    await created(store, { name: 'first' });
    await expect(store.create(input({ name: 'same token again' }), T0)).rejects.toThrow(); // a repeated token: the insert fails
    expect((await store.list(ANN, T0 + 1)).map((i) => i.name)).toEqual(['first']);
    expect((await store.create(input({ name: 'fine' }), T0)).ok).toBe(true); // the transaction was ended
  });

  it('refuses a bad name with a lone surrogate (it could not be stored exactly)', async () => {
    const store = tokensAt(join(tmp(), 'users.db'));
    const r = await store.create(input({ name: `bad${String.fromCharCode(0xd800)}` }), T0);
    expect(r.ok).toBe(false);
  });

  it('use the random source they are given', async () => {
    const store = createSqliteAgentTokenStore({ randomBytes: (n) => new Uint8Array(n).fill(9) });
    stores.push(store);
    const r = await store.create(input(), T0);
    expect(r.ok && r.value.token).toBe(`cpat_${Buffer.alloc(32, 9).toString('base64url')}`);
  });
});
