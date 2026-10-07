import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { circlesError, createMemoryCircleStore, CIRCLES_ERROR_CODES, type CircleStore } from '../circles/index.js';
import { CIRCLE_STATUS_OF, circleErrorResponse } from './circle-routes.js';
import { addMember, call, COOKIE, PW, seen, secrets, signIn, startCircleApp, T0, type CircleApp } from './circle-routes.test-util.js';

let app: CircleApp | undefined;
afterEach(async () => {
  await app?.api.close();
  app = undefined;
});
afterAll(() => {
  const all = seen.join('\n');
  expect(seen.length).toBeGreaterThan(80);
  for (const secret of secrets) expect(all.includes(secret), 'a password or a session token appeared in a response').toBe(false);
  for (const leak of ['scrypt$', 'passwordHash', 'example.com', 'graphId', 'user-u']) expect(all, leak).not.toContain(leak);
});

async function started(extra: Parameters<typeof startCircleApp>[0] = {}) {
  app = await startCircleApp(extra);
  const ann = await signIn(app, 'ann');
  const bob = await signIn(app, 'bob');
  const cat = await signIn(app, 'cat');
  return { a: app, ann, bob, cat };
}
const FORBIDDEN = { code: 'FORBIDDEN', message: 'your role in this circle does not allow that' };
const NO_CIRCLE = { code: 'NOT_FOUND', message: 'no such circle' };

describe('creating and seeing circles', () => {
  it('201 with the circle, and the creator is its owner', async () => {
    const { a, ann } = await started();
    const r = await call(a.port, 'POST', '/api/circles', { token: ann, body: { name: 'Book club', description: 'Tuesdays' } });
    expect(r.status).toBe(201);
    expect(Object.keys(r.json)).toEqual(['circle']);
    expect(r.json.circle).toEqual({ id: expect.stringMatching(/^c[a-z0-9]{16}$/), name: 'Book club', description: 'Tuesdays', createdAt: T0, updatedAt: T0, role: 'owner', memberCount: 1 });
    const got = await call(a.port, 'GET', `/api/circles/${r.json.circle.id}`, { token: ann });
    expect(got.status).toBe(200);
    expect(got.json).toEqual(r.json);
  });

  it('lists only my circles, a page at a time with limit and cursor', async () => {
    const { a, ann, bob } = await started({ limits: { maxCirclesPerUser: 100 } });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await call(a.port, 'POST', '/api/circles', { token: ann, body: { name: `c${i}` } })).json.circle.id);
    await call(a.port, 'POST', '/api/circles', { token: bob, body: { name: 'bobs' } });
    const first = await call(a.port, 'GET', '/api/circles?limit=2', { token: ann });
    expect(first.status).toBe(200);
    expect(first.json.items).toHaveLength(2);
    const second = await call(a.port, 'GET', `/api/circles?limit=10&cursor=${encodeURIComponent(first.json.nextCursor)}`, { token: ann });
    expect([...first.json.items, ...second.json.items].map((c: { id: string }) => c.id)).toEqual([...ids].sort());
    expect(second.json.nextCursor).toBeNull();
    expect((await call(a.port, 'GET', '/api/circles', { token: bob })).json.items.map((c: { name: string }) => c.name)).toEqual(['bobs']);
  });

  it('a bad limit or cursor is 422 naming it, and an unknown query parameter is refused by name', async () => {
    const { a, ann } = await started();
    for (const q of ['limit=0', 'limit=abc', 'limit=', 'limit=101', 'limit=1.5']) {
      const r = await call(a.port, 'GET', `/api/circles?${q}`, { token: ann });
      expect(r.status, q).toBe(422);
      expect(r.json.error).toMatchObject({ code: 'INVALID_INPUT', field: 'limit' });
    }
    expect((await call(a.port, 'GET', '/api/circles?cursor=nonsense', { token: ann })).json.error.field).toBe('cursor');
    for (const key of ['limt', 'userId', 'owner']) {
      const r = await call(a.port, 'GET', `/api/circles?${key}=1`, { token: ann });
      expect(r.status).toBe(422);
      expect(r.json.error.field).toBe(key);
    }
    expect((await call(a.port, 'GET', '/api/circles/cnone?x=1', { token: ann })).json.error.field).toBe('x');
  });

  it('422 for bad input naming the field, and any other field is refused by name', async () => {
    const { a, ann } = await started();
    for (const [body, field] of [[{ name: '' }, 'name'], [{ name: 'x'.repeat(81) }, 'name'], [{ name: 'x', description: 5 }, 'description'], [{}, 'name'], [{ name: 'x', id: 'c1' }, 'id'], [{ name: 'x', owner: 'u1' }, 'owner'], [{ name: 'x', role: 'owner' }, 'role']] as const) {
      const r = await call(a.port, 'POST', '/api/circles', { token: ann, body });
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.json.error).toMatchObject({ code: 'INVALID_INPUT', field });
    }
    expect((await call(a.port, 'POST', '/api/circles', { token: ann })).status).toBe(422); // no body at all
  });

  it('429 LIMIT_REACHED at the most circles a person may be in, without a Retry-After', async () => {
    const { a, ann, bob } = await started({ limits: { maxCirclesPerUser: 2 } });
    for (let i = 0; i < 2; i++) expect((await call(a.port, 'POST', '/api/circles', { token: ann, body: { name: `c${i}` } })).status).toBe(201);
    const r = await call(a.port, 'POST', '/api/circles', { token: ann, body: { name: 'third' } });
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe('LIMIT_REACHED');
    expect(r.headers['retry-after']).toBeUndefined();
    expect((await call(a.port, 'POST', '/api/circles', { token: bob, body: { name: 'fine' } })).status).toBe(201);
  });
});

describe('a stranger', () => {
  it('gets exactly the answer for a circle that does not exist, from every route', async () => {
    const { a, ann, bob } = await started();
    const id = (await call(a.port, 'POST', '/api/circles', { token: ann, body: { name: 'Private' } })).json.circle.id;
    const routes: Array<[string, string, unknown?]> = [
      ['GET', `/api/circles/${id}`],
      ['PATCH', `/api/circles/${id}`, { name: 'x' }],
      ['DELETE', `/api/circles/${id}`],
      ['GET', `/api/circles/${id}/members`],
      ['PATCH', `/api/circles/${id}/members/${a.ids.ann}`, { role: 'member' }],
      ['DELETE', `/api/circles/${id}/members/${a.ids.ann}`],
      ['POST', `/api/circles/${id}/leave`],
    ];
    for (const [method, path, body] of routes) {
      const real = await call(a.port, method, path, { token: bob, ...(body === undefined ? {} : { body }) });
      const madeUp = await call(a.port, method, path.replace(id, 'cnonexistent000000'), { token: bob, ...(body === undefined ? {} : { body }) });
      expect(real.status, `${method} ${path}`).toBe(404);
      expect(real.json, `${method} ${path}`).toEqual({ error: NO_CIRCLE });
      expect(madeUp.json).toEqual(real.json);
    }
    expect((await call(a.port, 'GET', `/api/circles/${id}`, { token: ann })).status).toBe(200); // nothing happened to it
  });

  it('odd ids in the path never reach a handler: they are not routes', async () => {
    const { a, ann } = await started();
    for (const path of ['/api/circles/..', '/api/circles/%2e%2e', '/api/circles/a%2fb', `/api/circles/${'c'.repeat(200)}`, '/api/circles//members', '/api/circles/x/members/']) {
      const r = await call(a.port, 'GET', path, { token: ann });
      expect(r.status, path).toBe(404);
      expect(r.json.error.code).toBe('NOT_FOUND');
    }
  });
});

describe('editing and deleting', () => {
  it('owners and managers rename and describe; members and observers are 403', async () => {
    const { a, ann, bob, cat } = await started();
    const id = (await call(a.port, 'POST', '/api/circles', { token: ann, body: { name: 'Old' } })).json.circle.id;
    await addMember(a, id, 'bob', 'manager');
    await addMember(a, id, 'cat', 'member');
    a.now.value = T0 + 1000;
    const byOwner = await call(a.port, 'PATCH', `/api/circles/${id}`, { token: ann, body: { name: 'New', description: 'text' } });
    expect(byOwner.status).toBe(200);
    expect(byOwner.json.circle).toMatchObject({ name: 'New', description: 'text', updatedAt: T0 + 1000, role: 'owner', memberCount: 3 });
    expect((await call(a.port, 'PATCH', `/api/circles/${id}`, { token: bob, body: { description: null } })).json.circle.description).toBeUndefined();
    const refused = await call(a.port, 'PATCH', `/api/circles/${id}`, { token: cat, body: { name: 'Hijack' } });
    expect(refused.status).toBe(403);
    expect(refused.json).toEqual({ error: FORBIDDEN });
    expect((await call(a.port, 'GET', `/api/circles/${id}`, { token: ann })).json.circle.name).toBe('New');
  });

  it('422 for an empty or unknown change, naming it', async () => {
    const { a, ann } = await started();
    const id = (await call(a.port, 'POST', '/api/circles', { token: ann, body: { name: 'x' } })).json.circle.id;
    expect((await call(a.port, 'PATCH', `/api/circles/${id}`, { token: ann, body: {} })).json.error.field).toBe('body');
    expect((await call(a.port, 'PATCH', `/api/circles/${id}`, { token: ann, body: { id: 'c2' } })).json.error.field).toBe('id');
    expect((await call(a.port, 'PATCH', `/api/circles/${id}`, { token: ann, body: { name: '' } })).json.error.field).toBe('name');
  });

  it('only an owner deletes: 204, and then it is gone for everyone', async () => {
    const { a, ann, bob, cat } = await started();
    const id = (await call(a.port, 'POST', '/api/circles', { token: ann, body: { name: 'Gone' } })).json.circle.id;
    await addMember(a, id, 'bob', 'manager');
    await addMember(a, id, 'cat', 'member');
    for (const token of [bob, cat]) expect((await call(a.port, 'DELETE', `/api/circles/${id}`, { token })).status).toBe(403);
    const gone = await call(a.port, 'DELETE', `/api/circles/${id}`, { token: ann });
    expect(gone.status).toBe(204);
    expect(gone.text).toBe('');
    for (const token of [ann, bob, cat]) expect((await call(a.port, 'GET', `/api/circles/${id}`, { token })).status).toBe(404);
    expect((await call(a.port, 'GET', '/api/circles', { token: bob })).json.items).toEqual([]);
    expect((await call(a.port, 'DELETE', `/api/circles/${id}`, { token: ann })).status).toBe(404);
  });

  it('a DELETE or GET that carries a body refuses fields by name', async () => {
    const { a, ann } = await started();
    const id = (await call(a.port, 'POST', '/api/circles', { token: ann, body: { name: 'x' } })).json.circle.id;
    const r = await call(a.port, 'DELETE', `/api/circles/${id}`, { token: ann, body: { force: true } });
    expect(r.status).toBe(422);
    expect(r.json.error.field).toBe('force');
    expect((await call(a.port, 'GET', `/api/circles/${id}`, { token: ann })).status).toBe(200);
  });
});

describe('members', () => {
  async function team() {
    const s = await started();
    const id = (await call(s.a.port, 'POST', '/api/circles', { token: s.ann, body: { name: 'Team' } })).json.circle.id as string;
    await addMember(s.a, id, 'bob', 'manager');
    await addMember(s.a, id, 'cat', 'member');
    return { ...s, id };
  }

  it('every member sees the roster with names and roles and nothing private, a page at a time', async () => {
    const { a, ann, cat, id } = await team();
    const r = await call(a.port, 'GET', `/api/circles/${id}/members`, { token: cat });
    expect(r.status).toBe(200);
    const byName = [...r.json.items].sort((x: { username: string }, y: { username: string }) => (x.username < y.username ? -1 : 1)); // the roster is in user id order, which is random
    expect(byName).toEqual([
      { userId: a.ids.ann, username: 'ann', displayName: 'Display ann', role: 'owner', joinedAt: T0 },
      { userId: a.ids.bob, username: 'bob', displayName: 'Display bob', role: 'manager', joinedAt: T0 },
      { userId: a.ids.cat, username: 'cat', displayName: 'Display cat', role: 'member', joinedAt: T0 },
    ]);
    expect(r.json.items.map((m: { userId: string }) => m.userId)).toEqual([...r.json.items.map((m: { userId: string }) => m.userId)].sort());
    const paged = await call(a.port, 'GET', `/api/circles/${id}/members?limit=2`, { token: ann });
    expect(paged.json.items).toHaveLength(2);
    expect(paged.json.nextCursor).not.toBeNull();
    expect((await call(a.port, 'GET', `/api/circles/${id}/members?limit=0`, { token: ann })).json.error.field).toBe('limit');
    expect(r.text).not.toMatch(/email|hash|password|token/i);
  });

  it('an owner changes roles; the answer is the person as the roster shows them', async () => {
    const { a, ann, id } = await team();
    const r = await call(a.port, 'PATCH', `/api/circles/${id}/members/${a.ids.cat}`, { token: ann, body: { role: 'observer' } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ member: { userId: a.ids.cat, username: 'cat', displayName: 'Display cat', role: 'observer', joinedAt: T0 } });
  });

  it('403 where the table says no: a manager over an owner or a manager, a member at all, and anyone over themselves', async () => {
    const { a, ann, bob, cat, id } = await team();
    const change = (token: string, who: string, role: string) => call(a.port, 'PATCH', `/api/circles/${id}/members/${a.ids[who]}`, { token, body: { role } });
    expect((await change(bob, 'ann', 'member')).status).toBe(403);
    expect((await change(bob, 'cat', 'manager')).status).toBe(403);
    expect((await change(cat, 'bob', 'member')).status).toBe(403);
    const self = await change(ann, 'ann', 'member');
    expect(self.status).toBe(403);
    expect(self.json.error.message).toBe('nobody changes their own role: ask another owner');
    expect((await change(bob, 'cat', 'observer')).status).toBe(200);
    const roles = Object.fromEntries((await call(a.port, 'GET', `/api/circles/${id}/members`, { token: ann })).json.items.map((m: { username: string; role: string }) => [m.username, m.role]));
    expect(roles).toEqual({ ann: 'owner', bob: 'manager', cat: 'observer' });
  });

  it('422 for a bad or unknown role field, 404 for someone who is not in the circle, with the same words for a made-up id', async () => {
    const { a, ann, id } = await team();
    const patch = (who: string, body: unknown) => call(a.port, 'PATCH', `/api/circles/${id}/members/${who}`, { token: ann, body });
    expect((await patch(a.ids.cat as string, {})).json.error).toMatchObject({ code: 'INVALID_INPUT', field: 'role' });
    expect((await patch(a.ids.cat as string, { role: 'admin' })).json.error.field).toBe('role');
    expect((await patch(a.ids.cat as string, { role: 'member', userId: 'x' })).json.error.field).toBe('userId');
    const missing = await patch('u0000000000000099', { role: 'member' });
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: { code: 'NOT_FOUND', message: 'no such member' } });
  });

  it('removing: an owner removes anyone else (204), a manager only members and observers, nobody removes themselves', async () => {
    const { a, ann, bob, cat, id } = await team();
    const del = (token: string, who: string) => call(a.port, 'DELETE', `/api/circles/${id}/members/${a.ids[who]}`, { token });
    expect((await del(bob, 'ann')).status).toBe(403);
    expect((await del(cat, 'bob')).status).toBe(403);
    expect((await del(bob, 'bob')).status).toBe(403);
    const removed = await del(bob, 'cat');
    expect(removed.status).toBe(204);
    expect(removed.text).toBe('');
    expect((await call(a.port, 'GET', `/api/circles/${id}`, { token: cat })).status).toBe(404);
    expect((await del(ann, 'bob')).status).toBe(204);
    expect((await del(ann, 'bob')).json).toEqual({ error: { code: 'NOT_FOUND', message: 'no such member' } });
  });

  it('leaving: 204 for anyone, 409 LAST_OWNER for the only owner with words that say what to do', async () => {
    const { a, ann, cat, id } = await team();
    const refused = await call(a.port, 'POST', `/api/circles/${id}/leave`, { token: ann });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toEqual({ code: 'LAST_OWNER', message: 'you are the only owner: make someone else an owner, or delete the circle' });
    const left = await call(a.port, 'POST', `/api/circles/${id}/leave`, { token: cat });
    expect(left.status).toBe(204);
    expect((await call(a.port, 'POST', `/api/circles/${id}/leave`, { token: cat })).status).toBe(404);
    expect((await call(a.port, 'POST', `/api/circles/${id}/leave`, { token: ann, body: { x: 1 } })).json.error.field).toBe('x');
  });

  it('a demoted manager loses the power on the very next request', async () => {
    const { a, ann, bob, id } = await team();
    expect((await call(a.port, 'PATCH', `/api/circles/${id}`, { token: bob, body: { name: 'by manager' } })).status).toBe(200);
    await call(a.port, 'PATCH', `/api/circles/${id}/members/${a.ids.bob}`, { token: ann, body: { role: 'member' } });
    expect((await call(a.port, 'PATCH', `/api/circles/${id}`, { token: bob, body: { name: 'again' } })).status).toBe(403);
  });
});

describe('sessions, methods and the rules shared with the other routes', () => {
  it('every route is 401 without a session, and 401 with a stale cookie that is cleared', async () => {
    const { a } = await started();
    const routes: Array<[string, string]> = [['GET', '/api/circles'], ['POST', '/api/circles'], ['GET', '/api/circles/cx'], ['PATCH', '/api/circles/cx'], ['DELETE', '/api/circles/cx'], ['GET', '/api/circles/cx/members'], ['PATCH', '/api/circles/cx/members/ux'], ['DELETE', '/api/circles/cx/members/ux'], ['POST', '/api/circles/cx/leave']];
    for (const [method, path] of routes) {
      const none = await call(a.port, method, path, method === 'POST' || method === 'PATCH' ? { body: {} } : {});
      expect(none.status, `${method} ${path}`).toBe(401);
      expect(none.json).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
      const stale = await call(a.port, method, path, { token: 'A'.repeat(43), ...(method === 'POST' || method === 'PATCH' ? { body: {} } : {}) });
      expect(stale.status, `${method} ${path} stale`).toBe(401);
      expect(stale.cookie, `${method} ${path}`).toMatch(/Max-Age=0/);
    }
  });

  it('with secure cookies the cleared cookie is Secure too', async () => {
    const { a } = await started({ secure: true });
    const r = await call(a.port, 'GET', '/api/circles', { token: 'A'.repeat(43) });
    expect(r.cookie).toMatch(/Max-Age=0.*; Secure|Secure.*Max-Age=0/);
  });

  it('a token in the Authorization header, a query or a body is not a session', async () => {
    const { a, ann } = await started();
    expect((await call(a.port, 'GET', '/api/circles', { headers: { authorization: `Bearer ${ann}` } })).status).toBe(401);
    expect((await call(a.port, 'GET', `/api/circles?token=${ann}`)).status).toBe(401);
  });

  it('wrong methods are 405 with Allow, and the cross-origin and JSON rules of the other routes apply', async () => {
    const { a, ann } = await started();
    const wrong = await call(a.port, 'PUT', '/api/circles/cx', { token: ann, body: {} });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe('GET, PATCH, DELETE');
    expect((await call(a.port, 'PATCH', '/api/circles/cx/leave', { token: ann, body: {} })).status).toBe(405);
    const cross = await call(a.port, 'POST', '/api/circles', { token: ann, body: { name: 'x' }, headers: { origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    expect((await call(a.port, 'POST', '/api/circles', { token: ann, body: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415);
    expect((await call(a.port, 'GET', '/api/circles', { token: ann })).headers['cache-control']).toBe('no-store');
  });
});

describe('the status table', () => {
  it('covers every error the controller can give, each with the status of the spec', () => {
    expect(Object.keys(CIRCLE_STATUS_OF).sort()).toEqual([...CIRCLES_ERROR_CODES].sort());
    expect(CIRCLE_STATUS_OF).toEqual({ UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, LAST_OWNER: 409, INVALID_INPUT: 422, LIMIT_REACHED: 429, THROTTLED: 429, STORAGE_ERROR: 500 });
    expect(circleErrorResponse(circlesError('THROTTLED', 'x', { retryAfterMs: 1500 })).retryAfterSeconds).toBe(2);
    expect(circleErrorResponse(circlesError('INVALID_INPUT', 'x', { field: 'name' })).body).toEqual({ error: { code: 'INVALID_INPUT', message: 'x', field: 'name' } });
    expect(circleErrorResponse(circlesError('NOT_FOUND', 'x')).body).toEqual({ error: { code: 'NOT_FOUND', message: 'x' } });
  });

  it('a storage failure is a fixed 500 with nothing from inside', async () => {
    const base = createMemoryCircleStore();
    const broken: CircleStore = new Proxy(base, { get: (target, key) => (key === 'listCirclesOf' ? async () => { throw new Error('secret /var/db/users.db'); } : (target as never)[key]) });
    const { a, ann } = await started({ store: broken });
    const r = await call(a.port, 'GET', '/api/circles', { token: ann });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: { code: 'STORAGE_ERROR', message: 'the circle service could not complete the request' } });
    expect(r.text).not.toContain('secret');
  });
});

describe('what is shared', () => {
  it('two people with circles of the same name see only their own', async () => {
    const { a, ann, bob } = await started();
    const one = (await call(a.port, 'POST', '/api/circles', { token: ann, body: { name: 'Same name' } })).json.circle.id;
    const two = (await call(a.port, 'POST', '/api/circles', { token: bob, body: { name: 'Same name' } })).json.circle.id;
    expect(one).not.toBe(two);
    expect((await call(a.port, 'GET', '/api/circles', { token: ann })).json.items.map((c: { id: string }) => c.id)).toEqual([one]);
    expect((await call(a.port, 'GET', '/api/circles', { token: bob })).json.items.map((c: { id: string }) => c.id)).toEqual([two]);
    expect((await call(a.port, 'GET', `/api/circles/${one}`, { token: bob })).status).toBe(404);
  });

  it('uses the same cookie name as the account routes', () => {
    expect(COOKIE).toBe('caci_session');
    expect(PW.length).toBeGreaterThan(12);
  });
});
