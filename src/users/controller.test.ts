import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createGraph, describeGraph, listGraphs, query, write, type StorageAdapter } from '../graph_store/index.js';
import { createUserController, type UserController } from './controller.js';
import { createMemorySessionStore } from './memory-session-store.js';
import { createMemoryUserStore } from './memory-store.js';
import { createPasswordHasher, type Derive } from './password.js';
import type { SessionStore } from './session-store.js';
import type { UserStore } from './store.js';
import { createLoginThrottle, createRegistrationThrottle } from './throttle.js';
import { userGraphId } from './ids.js';

const PW = 'correct horse 7 staple';
const CTX = { clientKey: 'client-1' };
const T0 = 1_700_000_000_000;

interface World {
  users: UserStore;
  sessions: SessionStore;
  graphs: StorageAdapter;
  controller: UserController;
  now: { value: number };
  derived: string[];
}

function world(extra: { users?: UserStore; graphs?: StorageAdapter; config?: { allowRegistration?: boolean }; hasherParams?: { N: number; r: number; p: number }; reuse?: Pick<World, 'users' | 'sessions' | 'graphs'> } = {}): World {
  const users = extra.reuse?.users ?? extra.users ?? createMemoryUserStore();
  const sessions = extra.reuse?.sessions ?? createMemorySessionStore();
  const graphs = extra.reuse?.graphs ?? extra.graphs ?? createMemoryAdapter();
  const now = { value: T0 };
  const derived: string[] = [];
  const derive: Derive = async (password, salt, params, bytes) => {
    derived.push(`${params.N}`);
    return Buffer.alloc(bytes, (password.length + params.N) % 251);
  };
  let n = 0;
  const controller = createUserController({
    users,
    sessions,
    graphAdapter: graphs,
    hasher: createPasswordHasher({ params: extra.hasherParams ?? { N: 16, r: 1, p: 1 }, derive, randomBytes: (len) => new Uint8Array(len).fill(++n % 250) }),
    loginThrottle: createLoginThrottle(),
    registrationThrottle: createRegistrationThrottle(),
    clock: () => now.value,
    ...(extra.config === undefined ? {} : { config: extra.config }),
    newUserId: (() => {
      let id = 0;
      return () => `u${String(++id).padStart(16, '0')}`;
    })(),
  });
  return { users, sessions, graphs, controller, now, derived };
}
const reg = (controller: UserController, name: string, extra: object = {}, ctx = CTX) => controller.register({ username: name, displayName: `Display ${name}`, password: PW, ...extra }, ctx);
const must = async <T>(promise: Promise<{ ok: boolean; value?: T; error?: unknown }>): Promise<T> => {
  const r = await promise;
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
const graphIds = async (graphs: StorageAdapter): Promise<string[]> => {
  const r = await listGraphs(graphs);
  return r.ok ? [...r.value.items] : [];
};

describe('register', () => {
  it('creates the account and its graph together, and returns the user without any secret', async () => {
    const w = world();
    const user = await must(reg(w.controller, 'Ann', { email: 'ann@example.com' }));
    expect(user).toMatchObject({ id: 'u0000000000000001', username: 'ann', displayName: 'Display Ann', email: 'ann@example.com', role: 'admin', createdAt: T0 });
    expect(await describeGraph(w.graphs, userGraphId(user.id))).toMatchObject({ ok: true, value: { itemCount: 0, categoryCount: 0, edgeCount: 0 } });
    expect(JSON.stringify(user)).not.toMatch(/scrypt|passwordHash|correct horse/);
    expect((await w.users.credentialOf(user.id))?.passwordHash).toMatch(/^scrypt\$/);
    expect(w.controller.graphIdOf(user)).toBe(`user-${user.id}`);
  });

  it('makes the first account ever the admin and later ones ordinary users', async () => {
    const w = world();
    expect((await must(reg(w.controller, 'first'))).role).toBe('admin');
    expect((await must(reg(w.controller, 'second'))).role).toBe('user');
    expect((await must(reg(w.controller, 'third'))).role).toBe('user');
  });

  it('of eight simultaneous first registrations, exactly one admin', async () => {
    const w = world();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => reg(w.controller, `racer${i}`, {}, { clientKey: `c${i}` })));
    const made = results.flatMap((r) => (r.ok ? [r.value] : []));
    expect(made).toHaveLength(8);
    expect(made.filter((u) => u.role === 'admin')).toHaveLength(1);
    expect(await graphIds(w.graphs)).toHaveLength(8);
  });

  it.each([
    ['username', { username: 'x' }],
    ['username', { username: 'has space' }],
    ['displayName', { displayName: '' }],
    ['email', { email: 'not an email' }],
    ['password', { password: 'short' }],
    ['password', { password: 'qwertyuiop12' }],
  ])('refuses a bad %s with INVALID_INPUT naming the field, and creates nothing', async (field, bad) => {
    const w = world();
    const r = await w.controller.register({ username: 'ann', displayName: 'Ann', password: PW, ...bad }, CTX);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field } });
    expect(await w.users.count()).toBe(0);
    expect(await graphIds(w.graphs)).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(String((bad as { password?: string }).password ?? 'zzzz-not-present'));
  });

  it('refuses a password equal to the username', async () => {
    const w = world();
    const r = await w.controller.register({ username: 'annsmith-account', displayName: 'Ann', password: 'annsmith-account' }, CTX);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'password' } });
  });

  it('refuses a username that is taken, whatever its case, and leaves no extra graph', async () => {
    const w = world();
    await must(reg(w.controller, 'ann'));
    const again = await reg(w.controller, 'ANN');
    expect(again).toMatchObject({ ok: false, error: { code: 'CONFLICT', field: 'username' } });
    expect(await w.users.count()).toBe(1);
    expect(await graphIds(w.graphs)).toHaveLength(1);
  });

  it('is closed when registration is switched off, and nothing is created or counted', async () => {
    const w = world({ config: { allowRegistration: false } });
    expect(await reg(w.controller, 'ann')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await w.users.count()).toBe(0);
    expect(w.derived).toEqual([]); // not even hashed
  });

  it('accounts made while registration was open can still log in when it is closed', async () => {
    const open = world();
    await must(reg(open.controller, 'ann'));
    const closed = world({ reuse: open, config: { allowRegistration: false } });
    expect(await closed.controller.login({ username: 'ann', password: PW }, CTX)).toMatchObject({ ok: true });
  });

  it('is throttled per client: the 11th attempt in an hour is THROTTLED, another client is not', async () => {
    const w = world();
    for (let i = 0; i < 10; i++) await reg(w.controller, `user${i}`);
    const eleventh = await reg(w.controller, 'user10');
    expect(eleventh).toMatchObject({ ok: false, error: { code: 'THROTTLED' } });
    expect((eleventh as { error: { retryAfterMs: number } }).error.retryAfterMs).toBeGreaterThan(0);
    expect(await reg(w.controller, 'user10', {}, { clientKey: 'someone-else' })).toMatchObject({ ok: true });
    w.now.value += 60 * 60_000;
    expect(await reg(w.controller, 'user11')).toMatchObject({ ok: true });
  });

  it('counts a refused attempt too (a bad name still costs the client)', async () => {
    const w = world();
    for (let i = 0; i < 10; i++) await reg(w.controller, 'x'); // all invalid
    expect(await reg(w.controller, 'valid-name')).toMatchObject({ ok: false, error: { code: 'THROTTLED' } });
  });

  it('takes the account back out if the graph cannot be made: either both exist or neither', async () => {
    const inner = createMemoryAdapter();
    const failing: StorageAdapter = { ...inner, graphs: { ...inner.graphs, create: async () => { throw new Error('disk full'); } } };
    const w = world({ graphs: failing });
    const r = await reg(w.controller, 'ann');
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(JSON.stringify(r)).not.toContain('disk full');
    expect(await w.users.count()).toBe(0);
    expect(await w.users.getByUsername('ann')).toBeUndefined();
    // and the name is free again
    const healthy = world({ reuse: { users: w.users, sessions: w.sessions, graphs: inner } });
    expect(await reg(healthy.controller, 'ann')).toMatchObject({ ok: true });
  });

  it('leaves no graph if the account cannot be made', async () => {
    const inner = createMemoryUserStore();
    const failing: UserStore = { ...inner, create: async () => { throw new Error('locked'); } };
    const w = world({ users: failing });
    expect(await reg(w.controller, 'ann')).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(await graphIds(w.graphs)).toEqual([]);
  });

  it('still reports the failure when taking the account back out fails too', async () => {
    const inner = createMemoryAdapter();
    const failingGraphs: StorageAdapter = { ...inner, graphs: { ...inner.graphs, create: async () => { throw new Error('x'); } } };
    const users = createMemoryUserStore();
    const stuck: UserStore = { ...users, delete: async () => { throw new Error('y'); } };
    const w = world({ users: stuck, graphs: failingGraphs });
    expect(await reg(w.controller, 'ann')).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
  });

  it('draws another id when one is taken, and gives up with an error rather than looping', async () => {
    const users = createMemoryUserStore();
    await users.create({ id: 'u0000000000000001', username: 'earlier', displayName: 'E', role: 'user', passwordHash: 'h', createdAt: 1 });
    const w = world({ users });
    expect(await reg(w.controller, 'ann')).toMatchObject({ ok: true, value: { id: 'u0000000000000002' } }); // the generator's first id was taken
    const stubborn = createUserController({ users, sessions: createMemorySessionStore(), graphAdapter: createMemoryAdapter(), newUserId: () => 'u0000000000000001' });
    expect(await stubborn.register({ username: 'bob', displayName: 'Bob', password: PW }, CTX)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });
});

describe('login', () => {
  it('gives a session for the right password, with the user and their graph, and the token works', async () => {
    const w = world();
    const user = await must(reg(w.controller, 'ann'));
    const loggedIn = await must(w.controller.login({ username: 'ann', password: PW }, CTX));
    expect(loggedIn.user).toEqual(user);
    expect(loggedIn.graphId).toBe(userGraphId(user.id));
    expect(loggedIn.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await must(w.controller.resolve(loggedIn.token))).toEqual({ user, graphId: userGraphId(user.id) });
    expect(JSON.stringify(loggedIn)).not.toContain('scrypt');
  });

  it('accepts the username in any case', async () => {
    const w = world();
    await must(reg(w.controller, 'ann'));
    expect(await w.controller.login({ username: 'ANN', password: PW }, CTX)).toMatchObject({ ok: true });
  });

  it('gives each login its own session', async () => {
    const w = world();
    await must(reg(w.controller, 'ann'));
    const a = await must(w.controller.login({ username: 'ann', password: PW }, CTX));
    const b = await must(w.controller.login({ username: 'ann', password: PW }, CTX));
    expect(a.token).not.toBe(b.token);
    expect(await w.controller.resolve(a.token)).toMatchObject({ ok: true });
    expect(await w.controller.resolve(b.token)).toMatchObject({ ok: true });
  });

  it('a wrong password and an unknown username are the same error, with the same work done', async () => {
    const w = world();
    await must(reg(w.controller, 'ann'));
    w.derived.length = 0;
    const wrong = await w.controller.login({ username: 'ann', password: 'wrong password 123' }, { clientKey: 'a' });
    const wrongWork = w.derived.splice(0);
    const unknown = await w.controller.login({ username: 'nobody-here', password: 'wrong password 123' }, { clientKey: 'b' });
    const unknownWork = w.derived.splice(0);
    expect(wrong).toEqual(unknown);
    expect(wrong).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'invalid username or password' } });
    expect(wrongWork).toHaveLength(1);
    expect(unknownWork).toEqual(wrongWork);
  });

  it('refuses what is not text, naming the field', async () => {
    const w = world();
    expect(await w.controller.login({ username: 5, password: PW }, CTX)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'username' } });
    expect(await w.controller.login({ username: 'ann', password: null }, CTX)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'password' } });
  });

  it('holds back after five failures, for a real account and an invented one alike, and never records the held-back attempts', async () => {
    const w = world();
    await must(reg(w.controller, 'ann'));
    for (const name of ['ann', 'ghost']) {
      for (let i = 0; i < 5; i++) expect(await w.controller.login({ username: name, password: 'bad password 123' }, { clientKey: `c-${name}` })).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    }
    const real = await w.controller.login({ username: 'ann', password: PW }, { clientKey: 'elsewhere' });
    const invented = await w.controller.login({ username: 'ghost', password: PW }, { clientKey: 'elsewhere' });
    expect(real).toMatchObject({ ok: false, error: { code: 'THROTTLED', retryAfterMs: 1000 } });
    expect(invented).toEqual(real); // the right password is held back too, and an invented name looks the same
    for (let i = 0; i < 50; i++) await w.controller.login({ username: 'ann', password: 'bad' }, { clientKey: 'elsewhere' }); // hammering
    w.now.value += 1000;
    expect(await w.controller.login({ username: 'ann', password: PW }, { clientKey: 'elsewhere' })).toMatchObject({ ok: true }); // still just 1 s
  });

  it('a success clears the count for that username', async () => {
    const w = world();
    await must(reg(w.controller, 'ann'));
    for (let i = 0; i < 4; i++) await w.controller.login({ username: 'ann', password: 'bad password 123' }, CTX);
    await must(w.controller.login({ username: 'ann', password: PW }, CTX));
    for (let i = 0; i < 4; i++) expect(await w.controller.login({ username: 'ann', password: 'bad password 123' }, CTX)).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('upgrades an old hash to the current cost at login, without changing when the account was updated', async () => {
    const old = world({ hasherParams: { N: 16, r: 1, p: 1 } });
    const user = await must(reg(old.controller, 'ann'));
    expect((await old.users.credentialOf(user.id))?.passwordHash).toMatch(/^scrypt\$16\$/);
    const newer = world({ reuse: old, hasherParams: { N: 32, r: 1, p: 1 } });
    newer.now.value = T0 + 5000;
    await must(newer.controller.login({ username: 'ann', password: PW }, CTX));
    const after = await old.users.credentialOf(user.id);
    expect(after?.passwordHash).toMatch(/^scrypt\$32\$/);
    expect(after?.user.updatedAt).toBe(user.updatedAt);
    expect(await newer.controller.login({ username: 'ann', password: PW }, CTX)).toMatchObject({ ok: true }); // and it still works
  });

  it('recreates a user graph that is missing (a registration that stopped half way is repaired at login)', async () => {
    const w = world();
    const user = await must(reg(w.controller, 'ann'));
    await w.graphs.graphs.drop(userGraphId(user.id));
    await must(w.controller.login({ username: 'ann', password: PW }, CTX));
    expect(await describeGraph(w.graphs, userGraphId(user.id))).toMatchObject({ ok: true });
  });

  it('turns a store failure into STORAGE_ERROR without leaking the cause', async () => {
    const inner = createMemoryUserStore();
    const broken: UserStore = { ...inner, credentialByUsername: async () => { throw new Error('database is on fire: secret detail'); } };
    const w = world({ users: broken });
    const r = await w.controller.login({ username: 'ann', password: PW }, CTX);
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(JSON.stringify(r)).not.toContain('fire');
  });

  it('never puts the password or a hash in any result', async () => {
    const w = world();
    const outputs = [await reg(w.controller, 'ann'), await w.controller.login({ username: 'ann', password: PW }, CTX), await w.controller.login({ username: 'ann', password: 'bad password 123' }, CTX), await w.controller.login({ username: 'ghost', password: 'bad password 123' }, CTX)];
    for (const out of outputs) {
      const text = JSON.stringify(out);
      expect(text).not.toContain(PW);
      expect(text).not.toContain('bad password 123');
      expect(text).not.toMatch(/scrypt|passwordHash/);
    }
  });
});

describe('logout and resolve', () => {
  it('logout ends that session only, and twice is fine', async () => {
    const w = world();
    await must(reg(w.controller, 'ann'));
    const a = await must(w.controller.login({ username: 'ann', password: PW }, CTX));
    const b = await must(w.controller.login({ username: 'ann', password: PW }, CTX));
    expect(await w.controller.logout(a.token)).toEqual({ ok: true, value: true });
    expect(await w.controller.logout(a.token)).toEqual({ ok: true, value: true });
    expect(await w.controller.resolve(a.token)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(await w.controller.resolve(b.token)).toMatchObject({ ok: true });
  });

  it('logout of nonsense is not an error', async () => {
    const w = world();
    for (const bad of [undefined, null, 5, {}, '', 'x'.repeat(43)]) expect(await w.controller.logout(bad)).toEqual({ ok: true, value: true });
  });

  it('resolve says UNAUTHENTICATED, the same way, for anything that is not a live token', async () => {
    const w = world();
    const outputs = await Promise.all([undefined, null, 5, '', 'garbage', 'A'.repeat(43), {}].map((t) => w.controller.resolve(t)));
    for (const out of outputs) expect(out).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
  });

  it('a session ends with its idle time, as the session store says', async () => {
    const w = world();
    await must(reg(w.controller, 'ann'));
    const { token } = await must(w.controller.login({ username: 'ann', password: PW }, CTX));
    w.now.value += 29 * 60_000;
    expect(await w.controller.resolve(token)).toMatchObject({ ok: true });
    w.now.value += 31 * 60_000;
    expect(await w.controller.resolve(token)).toMatchObject({ ok: false });
  });

  it('a deleted user\'s token stops working at once, and the session is ended', async () => {
    const w = world();
    const user = await must(reg(w.controller, 'ann'));
    const { token } = await must(w.controller.login({ username: 'ann', password: PW }, CTX));
    await w.users.delete(user.id);
    expect(await w.controller.resolve(token)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(await w.sessions.resolve(token, w.now.value)).toBeUndefined();
  });
});

describe('one graph per user', () => {
  it('two users have different graphs, and what one writes the other cannot see', async () => {
    const w = world();
    await must(reg(w.controller, 'ann'));
    await must(reg(w.controller, 'bob'));
    const ann = await must(w.controller.login({ username: 'ann', password: PW }, CTX));
    const bob = await must(w.controller.login({ username: 'bob', password: PW }, CTX));
    expect(ann.graphId).not.toBe(bob.graphId);
    const wrote = await write(w.graphs, { version: 1, kind: 'mutation', graphId: ann.graphId, ops: [{ op: 'upsertNode', partition: 'item', id: 'secret-note', data: { title: 'private' } }] });
    expect(wrote.ok).toBe(true);
    const bobsView = await query(w.graphs, { version: 1, graphId: bob.graphId, from: { all: true }, return: { shape: 'nodes' } });
    expect(bobsView).toMatchObject({ ok: true });
    expect(JSON.stringify(bobsView)).not.toContain('secret-note');
    const annsView = await query(w.graphs, { version: 1, graphId: ann.graphId, from: { all: true }, return: { shape: 'nodes' } });
    expect(JSON.stringify(annsView)).toContain('secret-note');
  });

  it('the graph comes from the session only: graphIdOf gives the same id the session gave', async () => {
    const w = world();
    const user = await must(reg(w.controller, 'ann'));
    const { token } = await must(w.controller.login({ username: 'ann', password: PW }, CTX));
    const who = await must(w.controller.resolve(token));
    expect(w.controller.graphIdOf(who.user)).toBe(who.graphId);
    expect(who.graphId).toBe(userGraphId(user.id));
  });

  it('createGraph is the graph store\'s own: an account cannot get a second graph by registering again', async () => {
    const w = world();
    await must(reg(w.controller, 'ann'));
    await reg(w.controller, 'ann');
    expect(await graphIds(w.graphs)).toHaveLength(1);
    expect(await createGraph(w.graphs, 'user-someone-else')).toMatchObject({ ok: true }); // sanity: the adapter is shared and usable
  });
});

describe('making a controller', () => {
  it('needs the three stores', () => {
    expect(() => createUserController({ users: undefined as never, sessions: createMemorySessionStore(), graphAdapter: createMemoryAdapter() })).toThrow(TypeError);
    expect(() => createUserController({ users: createMemoryUserStore(), sessions: undefined as never, graphAdapter: createMemoryAdapter() })).toThrow(TypeError);
    expect(() => createUserController({ users: createMemoryUserStore(), sessions: createMemorySessionStore(), graphAdapter: undefined as never })).toThrow(TypeError);
  });

  it('works with only the stores: the rest has defaults', async () => {
    const controller = createUserController({ users: createMemoryUserStore(), sessions: createMemorySessionStore(), graphAdapter: createMemoryAdapter() });
    expect(await controller.register({ username: 'ann', displayName: 'Ann', password: PW }, CTX)).toMatchObject({ ok: true, value: { role: 'admin' } });
    expect(await controller.login({ username: 'ann', password: PW }, CTX)).toMatchObject({ ok: true });
  }, 20_000);
});
