import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { addMember, call, PW, secrets, signIn, startCircleApp, T0, type CircleApp, type Reply } from './circle-routes.test-util.js';
import { createJoinRoutes } from './join-routes.js';

let app: CircleApp | undefined;
const bodies: string[] = [];
const created: string[] = [];
afterEach(async () => {
  await app?.api.close();
  app = undefined;
});
afterAll(() => {
  const all = bodies.join('\n');
  expect(bodies.length).toBeGreaterThan(60);
  for (const secret of secrets) expect(all.includes(secret), 'a password or a session token appeared in a response').toBe(false);
  for (const leak of ['scrypt$', 'passwordHash', 'example.com', 'graphId', 'user-u', 'tokenHash']) expect(all, leak).not.toContain(leak);
  expect(created.length).toBeGreaterThan(5);
});

const DAY = 86_400_000;
const NO_LINK = { code: 'NOT_FOUND', message: 'no such join link' };
const NO_REQUEST = { code: 'NOT_FOUND', message: 'no such join request' };
const NO_CIRCLE = { code: 'NOT_FOUND', message: 'no such circle' };
const FORBIDDEN = { code: 'FORBIDDEN', message: 'your role in this circle does not allow that' };

async function started(extra: Parameters<typeof startCircleApp>[0] = {}) {
  app = await startCircleApp({ ...extra, more: ({ circles }) => createJoinRoutes({ circles }) });
  const a = app;
  const tokens: Record<string, string> = {};
  for (const name of ['ann', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus']) tokens[name] = await signIn(a, name);
  const made = await call(a.port, 'POST', '/api/circles', { token: tokens.ann, body: { name: 'Team' } });
  const id = made.json.circle.id as string;
  await addMember(a, id, 'bob', 'manager');
  await addMember(a, id, 'cat', 'member');
  await addMember(a, id, 'dan', 'observer');
  return { a, id, ann: tokens.ann as string, bob: tokens.bob as string, cat: tokens.cat as string, dan: tokens.dan as string, eve: tokens.eve as string, fay: tokens.fay as string, gus: tokens.gus as string };
}
/** Every call here is kept for the scan at the end, whatever its path. */
const send = async (a: CircleApp, method: string, path: string, init: Parameters<typeof call>[3] = {}): Promise<Reply> => {
  const r = await call(a.port, method, path, init);
  bodies.push(r.text);
  return r;
};
const makeLink = async (a: CircleApp, id: string, token: string, body: Record<string, unknown> = {}) => {
  const r = await send(a, 'POST', `/api/circles/${id}/join-links`, { token, body: { label: 'Club chat', ...body } });
  if (r.status === 201) created.push(r.json.token as string);
  return r;
};
/** Sessions idle out after 30 minutes of the service's clock, so someone who waits a day signs in again. */
const relogin = async (a: CircleApp, name: string): Promise<string> => {
  const login = await call(a.port, 'POST', '/api/login', { body: { username: name, password: PW } });
  return login.cookie?.split(';')[0]?.slice('caci_session='.length) as string;
};
const comparable = (r: Reply) => ({ status: r.status, json: r.json, headers: { ...r.headers, date: undefined } });

describe('making, listing and revoking links', () => {
  it('201 with the token once and the link; the list never shows the token; revoking is a 204', async () => {
    const { a, id, ann, bob } = await started();
    const made = await makeLink(a, id, ann, { role: 'member', uses: 3, approval: false });
    expect(made.status).toBe(201);
    expect(made.headers['cache-control']).toBe('no-store');
    expect(made.headers['set-cookie']).toBeUndefined();
    expect(made.json.token).toMatch(/^cjoin_[A-Za-z0-9_-]{43}$/);
    expect(made.json.link).toMatchObject({ role: 'member', label: 'Club chat', maxUses: 3, uses: 0, approval: false, createdAt: T0, expiresAt: T0 + 7 * DAY });
    const listed = await send(a, 'GET', `/api/circles/${id}/join-links`, { token: bob });
    expect(listed.status).toBe(200);
    expect(listed.json.items).toHaveLength(1);
    expect(listed.json.items[0].id).toBe(made.json.link.id);
    expect(listed.text).not.toContain(made.json.token);
    expect(listed.text).not.toContain(made.json.token.slice(6));
    const gone = await send(a, 'DELETE', `/api/circles/${id}/join-links/${made.json.link.id}`, { token: bob });
    expect(gone.status).toBe(204);
    expect(gone.text).toBe('');
    expect((await send(a, 'GET', `/api/circles/${id}/join-links`, { token: ann })).json.items).toEqual([]);
    const again = await send(a, 'DELETE', `/api/circles/${id}/join-links/${made.json.link.id}`, { token: ann });
    expect([again.status, again.json.error]).toEqual([404, NO_LINK]);
  });

  it('members and observers are 403; a stranger and a made-up circle get the one no-such-circle', async () => {
    const { a, id, ann, cat, dan, eve } = await started();
    const made = await makeLink(a, id, ann);
    for (const token of [cat, dan]) {
      for (const r of [await makeLink(a, id, token), await send(a, 'GET', `/api/circles/${id}/join-links`, { token }), await send(a, 'DELETE', `/api/circles/${id}/join-links/${made.json.link.id}`, { token })]) {
        expect([r.status, r.json.error]).toEqual([403, FORBIDDEN]);
      }
    }
    const fake = 'c0000000000000000';
    for (const circle of [id, fake]) {
      for (const r of [await makeLink(a, circle, eve), await send(a, 'GET', `/api/circles/${circle}/join-links`, { token: eve }), await send(a, 'DELETE', `/api/circles/${circle}/join-links/j0000000000000000`, { token: eve })]) {
        expect([r.status, r.json.error]).toEqual([404, NO_CIRCLE]);
      }
    }
  });

  it('refuses a bad role, days, uses, label or approval with 422 naming the field, and an unknown field by name', async () => {
    const { a, id, ann } = await started();
    const field = async (body: unknown): Promise<[number, string | undefined]> => {
      const r = await send(a, 'POST', `/api/circles/${id}/join-links`, { token: ann, body });
      return [r.status, r.json.error?.field];
    };
    expect(await field({ label: 'x', role: 'owner' })).toEqual([422, 'role']);
    expect(await field({ label: 'x', role: 'manager' })).toEqual([422, 'role']);
    expect(await field({ label: 'x', days: 31 })).toEqual([422, 'days']);
    expect(await field({ label: 'x', uses: 0 })).toEqual([422, 'uses']);
    expect(await field({ label: '' })).toEqual([422, 'label']);
    expect(await field({ label: 'x', approval: 'no' })).toEqual([422, 'approval']);
    expect(await field({ label: 'x', circleId: id })).toEqual([422, 'circleId']);
    expect(await field({ label: 'x', token: 'cjoin_x' })).toEqual([422, 'token']);
    expect((await send(a, 'POST', `/api/circles/${id}/join-links`, { token: ann })).json.error.field).toBe('body');
    expect((await send(a, 'GET', `/api/circles/${id}/join-links`, { token: ann })).json.items).toEqual([]);
  });

  it('is paged, refuses unknown query parameters and a body on a GET or a DELETE by name', async () => {
    const { a, id, ann } = await started();
    for (let n = 0; n < 3; n++) await makeLink(a, id, ann, { label: `L${n}` });
    const first = await send(a, 'GET', `/api/circles/${id}/join-links?limit=2`, { token: ann });
    expect(first.json.items).toHaveLength(2);
    const second = await send(a, 'GET', `/api/circles/${id}/join-links?limit=2&cursor=${encodeURIComponent(first.json.nextCursor)}`, { token: ann });
    expect(second.json.items).toHaveLength(1);
    expect(second.json.nextCursor).toBeNull();
    expect((await send(a, 'GET', `/api/circles/${id}/join-links?limit=0`, { token: ann })).json.error.field).toBe('limit');
    expect((await send(a, 'GET', `/api/circles/${id}/join-links?limt=2`, { token: ann })).json.error.field).toBe('limt');
    expect((await send(a, 'GET', `/api/circles/${id}/join-links?token=cjoin_x`, { token: ann })).json.error.field).toBe('token');
    expect((await send(a, 'DELETE', `/api/circles/${id}/join-links/j0000000000000000`, { token: ann, body: { x: 1 } })).json.error.field).toBe('x');
  });
});

describe('previewing and joining', () => {
  it('preview: 200 with the circle\'s name, the role and the creator, and nothing else; no token in the path or the query', async () => {
    const { a, id, ann, eve } = await started();
    const made = await makeLink(a, id, ann, { role: 'member' });
    const r = await send(a, 'POST', '/api/join/preview', { token: eve, body: { token: made.json.token } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ preview: { circle: { name: 'Team' }, role: 'member', createdBy: { displayName: 'Display ann' } } });
    expect(r.text).not.toContain(id);
    const viaQuery = await send(a, 'POST', `/api/join/preview?token=${made.json.token}`, { token: eve, body: { token: made.json.token } });
    expect([viaQuery.status, viaQuery.json.error.field]).toEqual([422, 'token']);
    const viaPath = await send(a, 'POST', `/api/join/preview/${made.json.token}`, { token: eve });
    expect(viaPath.status).toBe(404);
    expect((await send(a, 'GET', '/api/join/preview', { token: eve })).status).toBe(405);
  });

  it('join with approval: 200 requested, then waiting; with no approval: joined, then member; the answers name only what is needed', async () => {
    const { a, id, ann, bob, eve, fay, gus } = await started();
    const asks = await makeLink(a, id, ann, { role: 'observer', uses: 5 });
    const direct = await makeLink(a, id, ann, { role: 'member', uses: 5, approval: false });
    const first = await send(a, 'POST', '/api/join', { token: eve, body: { token: asks.json.token } });
    expect([first.status, first.json]).toEqual([200, { result: { state: 'requested', circle: { name: 'Team' }, role: 'observer', expiresAt: T0 + 7 * DAY } }]);
    const again = await send(a, 'POST', '/api/join', { token: eve, body: { token: asks.json.token } });
    expect(again.json.result.state).toBe('waiting');
    const joined = await send(a, 'POST', '/api/join', { token: fay, body: { token: direct.json.token } });
    expect(joined.status).toBe(200);
    expect(joined.json.result).toMatchObject({ state: 'joined', circle: { id, name: 'Team', role: 'member', memberCount: 5 } });
    const member = await send(a, 'POST', '/api/join', { token: bob, body: { token: direct.json.token } });
    expect(member.json.result).toMatchObject({ state: 'member', circle: { role: 'manager' } });
    expect(first.text).not.toContain(id);
    expect((await send(a, 'GET', `/api/circles/${id}`, { token: gus })).status).toBe(404);
  });

  it('every kind of miss is the same 404, byte for byte, for preview and for join', async () => {
    const { a, id, ann } = await started();
    const expiring = await makeLink(a, id, ann, { days: 1, approval: false });
    const revoked = await makeLink(a, id, ann, { approval: false });
    const usedUp = await makeLink(a, id, ann, { approval: false });
    await send(a, 'POST', '/api/join', { token: (await signIn(a, 'zed')), body: { token: usedUp.json.token } });
    await send(a, 'DELETE', `/api/circles/${id}/join-links/${revoked.json.link.id}`, { token: ann });
    a.now.value = T0 + 2 * DAY;
    const eve2 = await relogin(a, 'eve');
    const tokens = ['cjoin_' + 'A'.repeat(43), 'abc', '', expiring.json.token, revoked.json.token, usedUp.json.token];
    const replies: Reply[] = [];
    for (const token of tokens) {
      replies.push(await send(a, 'POST', '/api/join/preview', { token: eve2, body: { token } }));
      replies.push(await send(a, 'POST', '/api/join', { token: eve2, body: { token } }));
    }
    for (const r of replies) {
      expect([r.status, r.json.error]).toEqual([404, NO_LINK]);
      expect(comparable(r)).toEqual(comparable(replies[0] as Reply));
    }
  });

  it('refuses a token that is not text and any other field, naming it', async () => {
    const { a, eve } = await started();
    expect((await send(a, 'POST', '/api/join', { token: eve, body: { token: 5 } })).json.error.field).toBe('token');
    expect((await send(a, 'POST', '/api/join', { token: eve, body: { token: 'x', circleId: 'c' } })).json.error.field).toBe('circleId');
    expect((await send(a, 'POST', '/api/join', { token: eve })).json.error.field).toBe('body');
    expect((await send(a, 'POST', '/api/join/preview', { token: eve, body: [] })).status).toBe(400); // not a JSON object at all: the server kit refuses it
  });

  it('holds a client back after too many misses (429 with Retry-After), even for a good link', async () => {
    const { a, id, ann, eve, fay } = await started({ limits: { joinMissesPerHour: 3 } });
    const good = await makeLink(a, id, ann, { approval: false, uses: 5 });
    for (let n = 0; n < 3; n++) expect((await send(a, 'POST', '/api/join', { token: eve, body: { token: `cjoin_${String(n).padStart(43, 'B')}` } })).status).toBe(404);
    const held = await send(a, 'POST', '/api/join', { token: fay, body: { token: good.json.token } });
    expect(held.status).toBe(429);
    expect(held.json.error.code).toBe('THROTTLED');
    expect(Number(held.headers['retry-after'])).toBeGreaterThan(0);
    a.now.value = T0 + 3_600_001;
    expect((await send(a, 'POST', '/api/join', { token: await relogin(a, 'fay'), body: { token: good.json.token } })).status).toBe(200);
  });
});

describe('the throttle counts by client', () => {
  it('two clients behind a trusted proxy are held back separately, by the address the proxy saw', async () => {
    const { a, id, ann, eve, fay } = await started({ limits: { joinMissesPerHour: 2 }, trustedProxies: 1 });
    const good = await makeLink(a, id, ann, { approval: false, uses: 5 });
    const from = (address: string) => ({ 'x-forwarded-for': address });
    const miss = (who: string, address: string, n: number) => send(a, 'POST', '/api/join/preview', { token: who, body: { token: `cjoin_${String(n).padStart(43, 'C')}` }, headers: from(address) });
    expect((await miss(eve, '10.0.0.1', 1)).status).toBe(404);
    expect((await miss(eve, '10.0.0.1', 2)).status).toBe(404);
    expect((await send(a, 'POST', '/api/join/preview', { token: fay, body: { token: good.json.token }, headers: from('10.0.0.1') })).status).toBe(429);
    expect((await send(a, 'POST', '/api/join/preview', { token: fay, body: { token: good.json.token }, headers: from('10.0.0.2') })).status).toBe(200);
    expect((await send(a, 'POST', '/api/join', { token: fay, body: { token: good.json.token }, headers: from('10.0.0.1') })).status).toBe(429);
    expect((await send(a, 'POST', '/api/join', { token: fay, body: { token: good.json.token }, headers: from('10.0.0.2') })).status).toBe(200);
  });

  it('a token in the query string of a join is refused by name, and not used', async () => {
    const { a, id, ann, eve } = await started();
    const good = await makeLink(a, id, ann, { approval: false });
    const r = await send(a, 'POST', `/api/join?token=${good.json.token}`, { token: eve, body: { token: good.json.token } });
    expect([r.status, r.json.error.field]).toEqual([422, 'token']);
    expect((await send(a, 'GET', `/api/circles/${id}`, { token: eve })).status).toBe(404);
  });
});

describe('waiting requests', () => {
  async function withRequest() {
    const s = await started();
    const made = await makeLink(s.a, s.id, s.ann, { role: 'member', uses: 5 });
    await send(s.a, 'POST', '/api/join', { token: s.eve, body: { token: made.json.token } });
    const listed = await send(s.a, 'GET', `/api/circles/${s.id}/join-requests`, { token: s.ann });
    return { ...s, request: listed.json.items[0].id as string, listed };
  }

  it('owners and managers list them by display name only; a person lists their own', async () => {
    const { a, id, bob, eve, listed } = await withRequest();
    expect(listed.status).toBe(200);
    expect(listed.json.items).toEqual([{ id: expect.stringMatching(/^r[a-z0-9]{16}$/), person: { displayName: 'Display eve' }, role: 'member', createdAt: T0, expiresAt: T0 + 7 * DAY }]);
    expect((await send(a, 'GET', `/api/circles/${id}/join-requests`, { token: bob })).json.items).toHaveLength(1);
    const mine = await send(a, 'GET', '/api/join-requests', { token: eve });
    expect(mine.status).toBe(200);
    expect(mine.json.items).toEqual([{ id: expect.any(String), circle: { name: 'Team' }, role: 'member', createdAt: T0, expiresAt: T0 + 7 * DAY }]);
    expect(mine.text).not.toContain(id);
    expect((await send(a, 'GET', '/api/join-requests', { token: bob })).json.items).toEqual([]);
  });

  it('members, observers are 403 and a stranger gets the one no-such-circle, for list, approve and decline', async () => {
    const { a, id, cat, dan, gus, request } = await withRequest();
    for (const token of [cat, dan]) {
      for (const r of [await send(a, 'GET', `/api/circles/${id}/join-requests`, { token }), await send(a, 'POST', `/api/circles/${id}/join-requests/${request}/approve`, { token }), await send(a, 'POST', `/api/circles/${id}/join-requests/${request}/decline`, { token })]) {
        expect([r.status, r.json.error]).toEqual([403, FORBIDDEN]);
      }
    }
    for (const r of [await send(a, 'GET', `/api/circles/${id}/join-requests`, { token: gus }), await send(a, 'POST', `/api/circles/${id}/join-requests/${request}/approve`, { token: gus }), await send(a, 'POST', `/api/circles/${id}/join-requests/${request}/decline`, { token: gus })]) {
      expect([r.status, r.json.error]).toEqual([404, NO_CIRCLE]);
    }
  });

  it('approving adds the member and returns them; the request is then gone (404 the second time); declining is 204', async () => {
    const { a, id, ann, bob, eve, request } = await withRequest();
    const approved = await send(a, 'POST', `/api/circles/${id}/join-requests/${request}/approve`, { token: bob });
    expect(approved.status).toBe(200);
    expect(approved.json.member).toMatchObject({ username: 'eve', displayName: 'Display eve', role: 'member' });
    expect((await send(a, 'GET', `/api/circles/${id}`, { token: eve })).json.circle.role).toBe('member');
    const second = await send(a, 'POST', `/api/circles/${id}/join-requests/${request}/approve`, { token: ann });
    expect([second.status, second.json.error]).toEqual([404, NO_REQUEST]);
    const link = await makeLink(a, id, ann, { uses: 2 });
    await send(a, 'POST', '/api/join', { token: await signIn(a, 'hal'), body: { token: link.json.token } });
    const next = (await send(a, 'GET', `/api/circles/${id}/join-requests`, { token: ann })).json.items[0].id as string;
    const declined = await send(a, 'POST', `/api/circles/${id}/join-requests/${next}/decline`, { token: ann });
    expect([declined.status, declined.text]).toEqual([204, '']);
    expect((await send(a, 'POST', `/api/circles/${id}/join-requests/${next}/decline`, { token: ann })).json.error).toEqual(NO_REQUEST);
  });

  it('a full circle is 429 and the request stays waiting; made-up and odd ids are the one 404', async () => {
    const { a, id, ann, request } = await started({ limits: { maxMembersPerCircle: 4 } }).then(async (s) => {
      const made = await makeLink(s.a, s.id, s.ann, { uses: 3 });
      await send(s.a, 'POST', '/api/join', { token: s.eve, body: { token: made.json.token } });
      return { ...s, request: (await send(s.a, 'GET', `/api/circles/${s.id}/join-requests`, { token: s.ann })).json.items[0].id as string };
    });
    const full = await send(a, 'POST', `/api/circles/${id}/join-requests/${request}/approve`, { token: ann });
    expect([full.status, full.json.error.code]).toEqual([429, 'LIMIT_REACHED']);
    expect((await send(a, 'GET', `/api/circles/${id}/join-requests`, { token: ann })).json.items).toHaveLength(1);
    for (const odd of ['r0000000000000000', '..', '%2e%2e', 'a%2fb', 'x'.repeat(200)]) {
      const r = await send(a, 'POST', `/api/circles/${id}/join-requests/${odd}/approve`, { token: ann });
      expect(r.status, odd).toBe(404);
    }
    expect((await send(a, 'POST', `/api/circles/${id}/join-requests/r0000000000000000/approve`, { token: ann })).json.error).toEqual(NO_REQUEST);
  });

  it('the request lists are paged and check their limits and cursors by name', async () => {
    const { a, id, ann, eve } = await withRequest();
    const more = await makeLink(a, id, ann, { uses: 5 });
    for (const name of ['gus', 'fay']) await send(a, 'POST', '/api/join', { token: await relogin(a, name), body: { token: more.json.token } });
    const page = await send(a, 'GET', `/api/circles/${id}/join-requests?limit=2`, { token: ann });
    expect(page.json.items).toHaveLength(2);
    expect(page.json.nextCursor).not.toBeNull();
    const rest = await send(a, 'GET', `/api/circles/${id}/join-requests?limit=2&cursor=${encodeURIComponent(page.json.nextCursor)}`, { token: ann });
    expect(rest.json.items).toHaveLength(1);
    expect((await send(a, 'GET', `/api/circles/${id}/join-requests?limit=0`, { token: ann })).json.error.field).toBe('limit');
    expect((await send(a, 'GET', `/api/circles/${id}/join-requests?cursor=garbage`, { token: ann })).json.error.field).toBe('cursor');
    expect((await send(a, 'GET', '/api/join-requests?limit=0', { token: eve })).json.error.field).toBe('limit');
    expect((await send(a, 'GET', '/api/join-requests?cursor=garbage', { token: eve })).json.error.field).toBe('cursor');
    const mine = await send(a, 'GET', '/api/join-requests?limit=1', { token: eve });
    expect(mine.json.items).toHaveLength(1);
    expect(mine.json.nextCursor).toBeNull();
  });

  it('approve and decline take no body and no query, refused by name', async () => {
    const { a, id, ann, request } = await withRequest();
    expect((await send(a, 'POST', `/api/circles/${id}/join-requests/${request}/approve`, { token: ann, body: { role: 'owner' } })).json.error.field).toBe('role');
    expect((await send(a, 'POST', `/api/circles/${id}/join-requests/${request}/decline?x=1`, { token: ann })).json.error.field).toBe('x');
    expect((await send(a, 'POST', `/api/circles/${id}/join-requests/${request}/decline`, { token: ann, body: { x: 1 } })).json.error.field).toBe('x');
    expect((await send(a, 'GET', '/api/join-requests?x=1', { token: ann })).json.error.field).toBe('x');
    expect((await send(a, 'GET', `/api/circles/${id}/join-requests`, { token: ann })).json.items).toHaveLength(1);
  });
});

describe('every route', () => {
  it('needs the session cookie: none is a 401 that sets nothing, a stale one is a 401 that clears it, and an Authorization header or a token query does nothing', async () => {
    const { a, id } = await started();
    const probes: Array<[string, string, unknown?]> = [
      ['POST', `/api/circles/${id}/join-links`, { label: 'x' }],
      ['GET', `/api/circles/${id}/join-links`],
      ['DELETE', `/api/circles/${id}/join-links/j0000000000000000`],
      ['POST', '/api/join/preview', { token: 'x' }],
      ['POST', '/api/join', { token: 'x' }],
      ['GET', `/api/circles/${id}/join-requests`],
      ['POST', `/api/circles/${id}/join-requests/r0000000000000000/approve`],
      ['POST', `/api/circles/${id}/join-requests/r0000000000000000/decline`],
      ['GET', '/api/join-requests'],
    ];
    for (const [method, path, body] of probes) {
      const none = await send(a, method, path, { ...(body === undefined ? {} : { body }) });
      expect([none.status, none.cookie], `${method} ${path}`).toEqual([401, undefined]);
      const stale = await send(a, method, path, { token: 'A'.repeat(43), ...(body === undefined ? {} : { body }) });
      expect(stale.status, `${method} ${path}`).toBe(401);
      expect(stale.cookie).toMatch(/Max-Age=0/);
      const header = await send(a, method, path, { headers: { authorization: 'Bearer cpat_' + 'A'.repeat(43) }, ...(body === undefined ? {} : { body }) });
      expect(header.status, `${method} ${path}`).toBe(401);
    }
  });

  it('answers other methods with 405 and Allow, and odd paths with a plain 404; cross-origin writes are 403 and a form post is 415', async () => {
    const { a, id, ann } = await started();
    for (const [method, path] of [['PUT', '/api/join'], ['GET', '/api/join'], ['PATCH', `/api/circles/${id}/join-links`], ['GET', `/api/circles/${id}/join-requests/r1/approve`], ['POST', '/api/join-requests']] as const) {
      const r = await call(a.port, method, path, { token: ann });
      expect(r.status, `${method} ${path}`).toBe(405);
      expect(r.headers.allow).toBeTruthy();
    }
    for (const path of [`/api/circles/${id}/join-links/`, `/api/circles/../join-links`, '/api/join/', '/api//join']) expect((await call(a.port, 'GET', path, { token: ann })).status, path).toBe(404);
    const cross = await call(a.port, 'POST', '/api/join', { token: ann, body: { token: 'x' }, headers: { origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    const form = await call(a.port, 'POST', '/api/join', { token: ann, body: 'token=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(form.status).toBe(415);
  });

  it('never repeats a token outside the one response that made it', async () => {
    const { a, id, ann, bob, eve } = await started();
    const one = await makeLink(a, id, ann, { approval: false });
    const two = await makeLink(a, id, bob);
    for (const token of [one.json.token, two.json.token]) {
      await send(a, 'POST', '/api/join/preview', { token: eve, body: { token } });
      await send(a, 'POST', '/api/join', { token: eve, body: { token } });
    }
    await send(a, 'GET', `/api/circles/${id}/join-links`, { token: ann });
    await send(a, 'GET', `/api/circles/${id}/join-requests`, { token: ann });
    await send(a, 'GET', '/api/join-requests', { token: eve });
    const everything = bodies.slice(bodies.lastIndexOf(two.text) + 1).join('\n');
    for (const token of [one.json.token as string, two.json.token as string]) expect(everything.includes(token.slice(6))).toBe(false);
  });
});
