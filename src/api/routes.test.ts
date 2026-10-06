import { request as httpRequest } from 'node:http';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { describeGraph, listGraphs } from '../graph_store/index.js';
import { createLoginThrottle, createMemorySessionStore, createMemoryUserStore, createPasswordHasher, createRegistrationThrottle, createUserController, userGraphId, type UserController } from '../users/index.js';
import { createAccountRoutes } from './routes.js';
import { createApiServer, type ApiServer } from './server.js';

const PW = 'correct horse 7 staple';
const NEW_PW = 'a different long passphrase 9';
const COOKIE = 'caci_session';

// everything the server ever sent or logged during this file, scanned at the end for secrets
const seenText: string[] = [];
const secrets = new Set<string>();

interface App {
  api: ApiServer;
  port: number;
  controller: UserController;
  graphs: ReturnType<typeof createMemoryAdapter>;
  logs: string[];
}
let app: App | undefined;
afterEach(async () => {
  await app?.api.close();
  app = undefined;
});

async function start(extra: { allowRegistration?: boolean; registrationMax?: number; secureCookies?: boolean; cookieName?: string; trustedProxies?: number; clientKeys?: string[] } = {}): Promise<App> {
  const graphs = createMemoryAdapter();
  const logs: string[] = [];
  const controller = createUserController({
    users: createMemoryUserStore(),
    sessions: createMemorySessionStore(),
    graphAdapter: graphs,
    hasher: createPasswordHasher({ params: { N: 16, r: 1, p: 1 } }),
    loginThrottle: spy(createLoginThrottle(), extra.clientKeys),
    registrationThrottle: createRegistrationThrottle({ max: extra.registrationMax ?? 1000 }),
    config: { allowRegistration: extra.allowRegistration ?? true },
  });
  const routes = createAccountRoutes({ controller, ...(extra.secureCookies === undefined ? {} : { secureCookies: extra.secureCookies }), ...(extra.cookieName === undefined ? {} : { cookieName: extra.cookieName }) });
  const api = createApiServer({ routes, log: (e) => logs.push(JSON.stringify(e)), ...(extra.trustedProxies === undefined ? {} : { trustedProxies: extra.trustedProxies }) });
  const port = await api.listen(0);
  app = { api, port, controller, graphs, logs };
  return app;
}

/** The login throttle, recording every client key it is asked about. */
function spy(throttle: ReturnType<typeof createLoginThrottle>, keys: string[] | undefined): ReturnType<typeof createLoginThrottle> {
  if (keys === undefined) return throttle;
  return {
    check: (u, c, n) => (keys.push(c), throttle.check(u, c, n)),
    recordFailure: (u, c, n) => (keys.push(c), throttle.recordFailure(u, c, n)),
    recordSuccess: (u, c, n) => (keys.push(c), throttle.recordSuccess(u, c, n)),
    purge: (n) => throttle.purge(n),
    get size() {
      return throttle.size;
    },
  };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  cookie: string | undefined;
}
/** One request. `cookie` is the session token to send, if any. */
function call(port: number, method: string, path: string, { body, token, headers = {}, cookieName = COOKIE }: { body?: unknown; token?: string | undefined; headers?: Record<string, string>; cookieName?: string } = {}): Promise<Reply> {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const sent: Record<string, string> = { ...headers };
  if (payload !== undefined) {
    sent['content-type'] ??= 'application/json';
    sent['content-length'] = String(Buffer.byteLength(payload));
  }
  if (token !== undefined) sent.cookie = `${cookieName}=${token}`;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: sent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        seenText.push(text);
        const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${cookieName}=`));
        const value = setCookie?.split(';')[0]?.slice(cookieName.length + 1);
        if (value) secrets.add(value);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: text === '' ? undefined : JSON.parse(text), cookie: setCookie });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const tokenOf = (r: Reply): string => r.cookie?.split(';')[0]?.slice(COOKIE.length + 1) ?? '';

async function register(port: number, name: string, extra: object = {}): Promise<Reply> {
  secrets.add(PW);
  return call(port, 'POST', '/api/register', { body: { username: name, displayName: `Display ${name}`, password: PW, ...extra } });
}
async function login(port: number, name: string, password = PW): Promise<{ token: string; reply: Reply }> {
  const reply = await call(port, 'POST', '/api/login', { body: { username: name, password } });
  return { token: tokenOf(reply), reply };
}
/** admin, ann, bob, each signed in. */
async function team(port: number) {
  await register(port, 'admin1');
  await register(port, 'ann');
  await register(port, 'bob');
  const admin = await login(port, 'admin1');
  const ann = await login(port, 'ann');
  const bob = await login(port, 'bob');
  return { admin: admin.token, ann: ann.token, bob: bob.token, adminId: admin.reply.json.user.id as string, annId: ann.reply.json.user.id as string, bobId: bob.reply.json.user.id as string };
}

describe('register', () => {
  it('creates the account and its graph: 201 with the user, no password, no hash, no cookie', async () => {
    const { port, graphs } = await start();
    const r = await register(port, 'Ann', { email: 'ann@example.com' });
    expect(r.status).toBe(201);
    expect(r.json.user).toMatchObject({ username: 'ann', displayName: 'Display Ann', email: 'ann@example.com', role: 'admin' });
    expect(r.cookie).toBeUndefined();
    expect(r.text).not.toMatch(/password|scrypt|hash/i);
    expect(await describeGraph(graphs, userGraphId(r.json.user.id))).toMatchObject({ ok: true });
  });

  it('refuses bad input with 422 naming the field, and an unknown field by name', async () => {
    const { port } = await start();
    for (const [bad, field] of [[{ username: 'x' }, 'username'], [{ displayName: '' }, 'displayName'], [{ email: 'nope' }, 'email'], [{ password: 'short' }, 'password'], [{ role: 'admin' }, 'role'], [{ isAdmin: true }, 'isAdmin']] as const) {
      const r = await register(port, 'someone', bad);
      expect(r.status, JSON.stringify(bad)).toBe(422);
      expect(r.json.error).toMatchObject({ code: 'INVALID_INPUT', field });
    }
  });

  it('a body that is not an object, or missing, is 422 or 400 and never a crash', async () => {
    const { port } = await start();
    expect((await call(port, 'POST', '/api/register')).status).toBe(422);
    expect((await call(port, 'POST', '/api/register', { body: '[]' })).status).toBe(400);
    expect((await call(port, 'POST', '/api/register', { body: '{"username":' })).status).toBe(400);
    expect((await call(port, 'POST', '/api/register', { body: { username: 5, displayName: 5, password: 5 } })).status).toBe(422);
  });

  it('a taken username is 409', async () => {
    const { port } = await start();
    await register(port, 'ann');
    const again = await register(port, 'ANN');
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ code: 'CONFLICT', field: 'username' });
  });

  it('is 403 when registration is closed', async () => {
    const { port } = await start({ allowRegistration: false });
    const r = await register(port, 'ann');
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('FORBIDDEN');
  });

  it('is 429 with Retry-After once a client has registered too often', async () => {
    const { port } = await start({ registrationMax: 2 });
    await register(port, 'one');
    await register(port, 'two');
    const third = await register(port, 'three');
    expect(third.status).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect(third.json.error.code).toBe('THROTTLED');
  });
});

describe('login and logout', () => {
  it('sets the session cookie (HttpOnly, SameSite=Strict, Path=/, Max-Age) and puts the user and graph in the body, never the token', async () => {
    const { port } = await start();
    const created = await register(port, 'ann');
    const { token, reply } = await login(port, 'ann');
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ user: created.json.user, graphId: userGraphId(created.json.user.id) });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(reply.text).not.toContain(token);
    expect(reply.cookie).toBe(`${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
  });

  it('adds Secure when configured, and uses the cookie name it is given', async () => {
    const { port } = await start({ secureCookies: true, cookieName: 'my_session' });
    await register(port, 'ann');
    const r = await call(port, 'POST', '/api/login', { body: { username: 'ann', password: PW } });
    expect(r.headers['set-cookie']).toEqual([expect.stringMatching(/^my_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800; Secure$/)]);
  });

  it('a wrong password and an unknown username are both 401 with the same body, and no cookie', async () => {
    const { port } = await start();
    await register(port, 'ann');
    const wrong = await login(port, 'ann', 'wrong password 123');
    const unknown = await login(port, 'nobody');
    expect(wrong.reply.status).toBe(401);
    expect(unknown.reply.status).toBe(401);
    expect(wrong.reply.json).toEqual(unknown.reply.json);
    expect(wrong.reply.cookie).toBeUndefined();
    expect(unknown.reply.cookie).toBeUndefined();
  });

  it('is 429 with Retry-After after five wrong passwords, and the right password is held back too', async () => {
    const { port } = await start();
    await register(port, 'ann');
    for (let i = 0; i < 5; i++) await login(port, 'ann', 'wrong password 123');
    const held = await login(port, 'ann');
    expect(held.reply.status).toBe(429);
    expect(held.reply.headers['retry-after']).toBe('1');
    expect(held.token).toBe('');
  });

  it('refuses unknown fields and wrong types', async () => {
    const { port } = await start();
    expect((await call(port, 'POST', '/api/login', { body: { username: 'a', password: 'b', remember: true } })).status).toBe(422);
    expect((await call(port, 'POST', '/api/login', { body: { username: 5, password: 'b' } })).status).toBe(422);
  });

  it('logout ends that session, clears the cookie, and works with no session too', async () => {
    const { port } = await start();
    await register(port, 'ann');
    const a = await login(port, 'ann');
    const b = await login(port, 'ann');
    const out = await call(port, 'POST', '/api/logout', { token: a.token });
    expect(out.status).toBe(204);
    expect(out.text).toBe('');
    expect(out.cookie).toMatch(/^caci_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970/);
    expect((await call(port, 'GET', '/api/me', { token: a.token })).status).toBe(401);
    expect((await call(port, 'GET', '/api/me', { token: b.token })).status).toBe(200);
    expect((await call(port, 'POST', '/api/logout')).status).toBe(204);
  });

  it('an Authorization header is ignored: only the cookie counts', async () => {
    const { port } = await start();
    await register(port, 'ann');
    const { token } = await login(port, 'ann');
    expect((await call(port, 'GET', '/api/me', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await call(port, 'GET', '/api/me', { headers: { authorization: `${token}` } })).status).toBe(401);
    expect((await call(port, 'GET', `/api/me?token=${token}`)).status).toBe(401);
    expect((await call(port, 'POST', '/api/logout', { body: { token }, headers: { authorization: token } })).status).toBe(204);
    expect((await call(port, 'GET', '/api/me', { token })).status).toBe(200); // that logout did not carry the cookie, so it ended nothing
  });
});

describe('me', () => {
  it('GET returns the user and graph; no session or a bad one is 401 and a bad cookie is cleared', async () => {
    const { port } = await start();
    const created = await register(port, 'ann');
    const { token } = await login(port, 'ann');
    expect((await call(port, 'GET', '/api/me', { token })).json).toEqual({ user: created.json.user, graphId: userGraphId(created.json.user.id) });
    const none = await call(port, 'GET', '/api/me');
    expect(none.status).toBe(401);
    expect(none.cookie).toBeUndefined(); // nothing was sent, nothing to clear
    const stale = await call(port, 'GET', '/api/me', { token: 'A'.repeat(43) });
    expect(stale.status).toBe(401);
    expect(stale.cookie).toMatch(/Max-Age=0/); // the browser is told to forget it
    expect(stale.json).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
  });

  it('PATCH changes display name and email, and refuses anything else by name', async () => {
    const { port } = await start();
    await register(port, 'ann');
    const { token } = await login(port, 'ann');
    const r = await call(port, 'PATCH', '/api/me', { token, body: { displayName: 'Ann Smith', email: 'ann@example.com' } });
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ displayName: 'Ann Smith', email: 'ann@example.com' });
    expect((await call(port, 'PATCH', '/api/me', { token, body: { email: null } })).json.user.email).toBeUndefined();
    for (const key of ['role', 'username', 'id']) expect((await call(port, 'PATCH', '/api/me', { token, body: { [key]: 'x' } })).json.error, key).toMatchObject({ code: 'INVALID_INPUT', field: key });
    expect((await call(port, 'PATCH', '/api/me', { token, body: { displayName: '' } })).status).toBe(422);
    expect((await call(port, 'PATCH', '/api/me', { body: { displayName: 'x' } })).status).toBe(401);
  });

  it('POST /me/password changes it, ends other sessions, keeps this one', async () => {
    const { port } = await start();
    await register(port, 'ann');
    const a = await login(port, 'ann');
    const b = await login(port, 'ann');
    secrets.add(NEW_PW);
    const r = await call(port, 'POST', '/api/me/password', { token: a.token, body: { currentPassword: PW, newPassword: NEW_PW } });
    expect(r.status).toBe(200);
    expect((await call(port, 'GET', '/api/me', { token: a.token })).status).toBe(200);
    expect((await call(port, 'GET', '/api/me', { token: b.token })).status).toBe(401);
    expect((await login(port, 'ann', NEW_PW)).reply.status).toBe(200);
    expect((await login(port, 'ann', PW)).reply.status).toBe(401);
  });

  it('POST /me/password with a wrong current password is 422 naming it, and a weak new one names newPassword', async () => {
    const { port } = await start();
    await register(port, 'ann');
    const { token } = await login(port, 'ann');
    expect((await call(port, 'POST', '/api/me/password', { token, body: { currentPassword: 'wrong password 123', newPassword: NEW_PW } })).json.error).toMatchObject({ code: 'INVALID_INPUT', field: 'currentPassword' });
    expect((await call(port, 'POST', '/api/me/password', { token, body: { currentPassword: PW, newPassword: 'short' } })).json.error).toMatchObject({ code: 'INVALID_INPUT', field: 'newPassword' });
  });

  it('DELETE /me needs the password, then removes the account, graph and cookie', async () => {
    const { port, graphs } = await start();
    await register(port, 'first');
    const created = await register(port, 'ann');
    const { token } = await login(port, 'ann');
    expect((await call(port, 'DELETE', '/api/me', { token, body: { password: 'wrong password 123' } })).status).toBe(422);
    expect((await call(port, 'DELETE', '/api/me', { token })).status).toBe(422); // no body: the password field is missing
    const gone = await call(port, 'DELETE', '/api/me', { token, body: { password: PW } });
    expect(gone.status).toBe(204);
    expect(gone.cookie).toMatch(/Max-Age=0/);
    expect((await call(port, 'GET', '/api/me', { token })).status).toBe(401);
    expect(await describeGraph(graphs, userGraphId(created.json.user.id))).toMatchObject({ ok: false });
    expect((await login(port, 'ann')).reply.status).toBe(401);
  });

  it('the only admin cannot delete their own account: 409', async () => {
    const { port } = await start();
    await register(port, 'solo');
    const { token } = await login(port, 'solo');
    const r = await call(port, 'DELETE', '/api/me', { token, body: { password: PW } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('LAST_ADMIN');
  });
});

describe('who is asking is the real client, for every route that counts attempts', () => {
  it('login, change password and delete account all count by the address a trusted proxy reported', async () => {
    const keys: string[] = [];
    const { port } = await start({ trustedProxies: 1, clientKeys: keys });
    const via = { 'x-forwarded-for': '203.0.113.9' };
    await register(port, 'ann');
    const { token } = await login(port, 'ann');
    keys.length = 0;
    await call(port, 'POST', '/api/login', { body: { username: 'ann', password: 'wrong password 123' }, headers: via });
    expect(new Set(keys)).toEqual(new Set(['203.0.113.9']));
    keys.length = 0;
    await call(port, 'POST', '/api/me/password', { token, headers: via, body: { currentPassword: 'wrong password 123', newPassword: NEW_PW } });
    expect(new Set(keys)).toEqual(new Set(['203.0.113.9']));
    keys.length = 0;
    await call(port, 'DELETE', '/api/me', { token, headers: via, body: { password: 'wrong password 123' } });
    expect(new Set(keys)).toEqual(new Set(['203.0.113.9']));
  });
});

describe('admin routes', () => {
  it('list: by username, paged by limit and cursor from the query string', async () => {
    const { port } = await start();
    const t = await team(port);
    const first = await call(port, 'GET', '/api/users?limit=2', { token: t.admin });
    expect(first.status).toBe(200);
    expect(first.json.items.map((u: { username: string }) => u.username)).toEqual(['admin1', 'ann']);
    const rest = await call(port, 'GET', `/api/users?limit=2&cursor=${encodeURIComponent(first.json.nextCursor)}`, { token: t.admin });
    expect(rest.json.items.map((u: { username: string }) => u.username)).toEqual(['bob']);
    expect(rest.json.nextCursor).toBeNull();
  });

  it('list: a bad limit or cursor is 422, an ordinary user is 403', async () => {
    const { port } = await start();
    const t = await team(port);
    for (const q of ['limit=0', 'limit=abc', 'limit=', 'limit=1.5', 'limit=999', 'cursor=garbage']) expect((await call(port, 'GET', `/api/users?${q}`, { token: t.admin })).status, q).toBe(422);
    expect((await call(port, 'GET', '/api/users', { token: t.ann })).status).toBe(403);
  });

  it('get, update, reset password and delete another user as admin', async () => {
    const { port } = await start();
    const t = await team(port);
    expect((await call(port, 'GET', `/api/users/${t.bobId}`, { token: t.admin })).json.user.username).toBe('bob');
    const updated = await call(port, 'PATCH', `/api/users/${t.bobId}`, { token: t.admin, body: { displayName: 'Bob B', role: 'admin' } });
    expect(updated.json.user).toMatchObject({ displayName: 'Bob B', role: 'admin' });
    secrets.add(NEW_PW);
    const reset = await call(port, 'POST', `/api/users/${t.bobId}/password`, { token: t.admin, body: { newPassword: NEW_PW } });
    expect(reset.status).toBe(200);
    expect((await call(port, 'GET', '/api/me', { token: t.bob })).status).toBe(401); // bob's sessions ended
    expect((await login(port, 'bob', NEW_PW)).reply.status).toBe(200);
    const deleted = await call(port, 'DELETE', `/api/users/${t.annId}`, { token: t.admin });
    expect(deleted.status).toBe(204);
    expect((await call(port, 'GET', `/api/users/${t.annId}`, { token: t.admin })).status).toBe(404);
  });

  it('a user can read and edit themselves through /users/:id, and nothing of anyone else, the same 403 whether or not they exist', async () => {
    const { port } = await start();
    const t = await team(port);
    expect((await call(port, 'GET', `/api/users/${t.annId}`, { token: t.ann })).status).toBe(200);
    expect((await call(port, 'PATCH', `/api/users/${t.annId}`, { token: t.ann, body: { displayName: 'Mine' } })).status).toBe(200);
    const real = await call(port, 'GET', `/api/users/${t.bobId}`, { token: t.ann });
    const missing = await call(port, 'GET', '/api/users/u9999999999999999', { token: t.ann });
    expect(real.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(missing.json).toEqual(real.json);
    expect((await call(port, 'PATCH', `/api/users/${t.annId}`, { token: t.ann, body: { role: 'admin' } })).status).toBe(403);
    expect((await call(port, 'DELETE', `/api/users/${t.bobId}`, { token: t.ann })).status).toBe(403);
    expect((await call(port, 'POST', `/api/users/${t.bobId}/password`, { token: t.ann, body: { newPassword: NEW_PW } })).status).toBe(403);
  });

  it('an admin gets 404 for someone who does not exist, 422 for a bad role, 409 for demoting the last admin', async () => {
    const { port } = await start();
    const t = await team(port);
    expect((await call(port, 'GET', '/api/users/u9999999999999999', { token: t.admin })).status).toBe(404);
    expect((await call(port, 'PATCH', `/api/users/${t.annId}`, { token: t.admin, body: { role: 'root' } })).status).toBe(422);
    const demote = await call(port, 'PATCH', `/api/users/${t.adminId}`, { token: t.admin, body: { role: 'user' } });
    expect(demote.status).toBe(409);
    expect(demote.json.error.code).toBe('LAST_ADMIN');
    expect((await call(port, 'DELETE', `/api/users/${t.adminId}`, { token: t.admin })).status).toBe(422); // your own account goes through DELETE /api/me
  });

  it('unknown body fields are refused on every body route', async () => {
    const { port } = await start();
    const t = await team(port);
    for (const [method, path] of [['PATCH', `/api/users/${t.annId}`], ['POST', `/api/users/${t.annId}/password`], ['PATCH', '/api/me'], ['POST', '/api/me/password'], ['DELETE', '/api/me']] as const) {
      const r = await call(port, method, path, { token: t.admin, body: { surprise: 1 } });
      expect(r.status, `${method} ${path}`).toBe(422);
      expect(r.json.error.field).toBe('surprise');
    }
  });
});

describe('every route, with and without a session, as each kind of caller', () => {
  it('has exactly the status the table says', async () => {
    const { port } = await start();
    const t = await team(port);
    const NOBODY = 'nobody';
    type Who = 'nobody' | 'user' | 'admin';
    const token = (who: Who): string | undefined => (who === 'admin' ? t.admin : who === 'user' ? t.bob : undefined);
    // [method, path, body, expected status for nobody / user (bob) / admin]
    const table: ReadonlyArray<readonly [string, string, unknown, number, number, number]> = [
      ['GET', '/api/me', undefined, 401, 200, 200],
      ['PATCH', '/api/me', { displayName: 'New' }, 401, 200, 200],
      ['POST', '/api/me/password', { currentPassword: 'wrong password 123', newPassword: NEW_PW }, 401, 422, 422],
      ['GET', '/api/users', undefined, 401, 403, 200],
      ['GET', `/api/users/${t.annId}`, undefined, 401, 403, 200],
      ['PATCH', `/api/users/${t.annId}`, { displayName: 'By admin' }, 401, 403, 200],
      ['POST', `/api/users/${t.annId}/password`, { newPassword: 'qwertyuiop12' }, 401, 403, 422],
      ['DELETE', '/api/users/u9999999999999999', undefined, 401, 403, 404],
    ];
    for (const [method, path, body, forNobody, forUser, forAdmin] of table) {
      for (const [who, expected] of [['nobody', forNobody], ['user', forUser], ['admin', forAdmin]] as const) {
        const r = await call(port, method, path, { token: token(who), ...(body === undefined ? {} : { body }) });
        expect(r.status, `${method} ${path} as ${who === 'nobody' ? NOBODY : who}`).toBe(expected);
      }
    }
  });

  it('knows nothing else: other paths and wrong methods are 404 and 405 with Allow', async () => {
    const { port } = await start();
    expect((await call(port, 'GET', '/api/nothing')).status).toBe(404);
    expect((await call(port, 'GET', '/api/login')).headers.allow).toBe('POST');
    expect((await call(port, 'PUT', '/api/me', { body: {} })).headers.allow).toBe('GET, PATCH, DELETE');
    expect((await call(port, 'GET', '/api/users/u1/password')).headers.allow).toBe('POST');
    expect((await call(port, 'DELETE', '/api/users')).headers.allow).toBe('GET');
  });
});

describe('the whole thing against cross-site and hostile callers', () => {
  it('a cross-origin write is refused before it can act: no account, no session', async () => {
    const { port, graphs } = await start();
    const r = await register(port, 'victim').then(() => call(port, 'POST', '/api/register', { body: { username: 'evil', displayName: 'Evil', password: PW }, headers: { origin: 'http://evil.example' } }));
    expect(r.status).toBe(403);
    const login403 = await call(port, 'POST', '/api/login', { body: { username: 'victim', password: PW }, headers: { origin: 'http://evil.example' } });
    expect(login403.status).toBe(403);
    expect(login403.cookie).toBeUndefined();
    const graphList = await listGraphs(graphs);
    expect(graphList.ok && graphList.value.items).toHaveLength(1);
  });

  it('a form post (not JSON) is 415, even from this site', async () => {
    const { port } = await start();
    const r = await call(port, 'POST', '/api/login', { body: 'username=a&password=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(r.status).toBe(415);
  });

  it('a session cookie with a hostile value is just not a session', async () => {
    const { port } = await start();
    for (const value of ['x', "'; DROP TABLE users; --", '../../etc/passwd', '%00', '__proto__', 'A'.repeat(5000)]) {
      const r = await call(port, 'GET', '/api/me', { headers: { cookie: `${COOKIE}=${value}` } });
      expect(r.status, value.slice(0, 20)).toBe(401);
    }
  });

  it('two different people each only ever see their own account through /me', async () => {
    const { port } = await start();
    const t = await team(port);
    expect((await call(port, 'GET', '/api/me', { token: t.ann })).json.user.id).toBe(t.annId);
    expect((await call(port, 'GET', '/api/me', { token: t.bob })).json.user.id).toBe(t.bobId);
    expect((await call(port, 'GET', `/api/me?id=${t.bobId}`, { token: t.ann })).json.user.id).toBe(t.annId); // a query parameter cannot change who you are
  });
});

describe('server failures', () => {
  it('a controller that throws is a fixed 500 with nothing from inside', async () => {
    const real = (await start()).controller;
    await app?.api.close();
    const exploding = { ...real, getMe: async () => { throw new Error('secret failure detail /var/db/users.db'); } } as UserController;
    const api = createApiServer({ routes: createAccountRoutes({ controller: exploding }) });
    const port = await api.listen(0);
    app = { api, port, controller: exploding, graphs: createMemoryAdapter(), logs: [] };
    const r = await call(port, 'GET', '/api/me', { token: 'A'.repeat(43) });
    expect(r.status).toBe(500);
    expect(r.text).not.toMatch(/secret|\/var\//);
  });

  it('a STORAGE_ERROR from the controller is a 500 with its fixed message', async () => {
    await start();
    const real = app?.controller as UserController;
    await app?.api.close();
    const failing = { ...real, login: async () => ({ ok: false as const, error: { code: 'STORAGE_ERROR' as const, message: 'the user service could not complete the request' } }) } as UserController;
    const api = createApiServer({ routes: createAccountRoutes({ controller: failing }) });
    const p2 = await api.listen(0);
    app = { api, port: p2, controller: failing, graphs: createMemoryAdapter(), logs: [] };
    const r = await call(p2, 'POST', '/api/login', { body: { username: 'a', password: 'b' } });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: { code: 'STORAGE_ERROR', message: 'the user service could not complete the request' } });
  });
});

describe('request logging', () => {
  it('records method, path and status only: no body, no cookie, no query', async () => {
    const { port, logs } = await start();
    await register(port, 'ann');
    const { token } = await login(port, 'ann');
    await call(port, 'GET', `/api/users?cursor=SECRET-CURSOR`, { token });
    await new Promise((r) => setTimeout(r, 20));
    seenText.push(...logs);
    expect(logs.length).toBeGreaterThanOrEqual(3);
    for (const line of logs) {
      expect(Object.keys(JSON.parse(line)).sort()).toEqual(['method', 'ms', 'path', 'status']);
      expect(line).not.toContain(token);
      expect(line).not.toContain('SECRET-CURSOR');
      expect(line).not.toContain(PW);
    }
  });
});

afterAll(() => {
  // nothing the server said or logged, in any test above, contains a password, a token or a hash
  const everything = seenText.join('\n');
  expect(seenText.length).toBeGreaterThan(100);
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    expect(everything.includes(secret), `a response or log line contained a secret (${secret.slice(0, 4)}…)`).toBe(false);
  }
  expect(everything).not.toMatch(/scrypt\$/);
  expect(everything).not.toMatch(/passwordHash|password_hash/i);
});
