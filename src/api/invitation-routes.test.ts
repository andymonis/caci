import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { call, seen, secrets, signIn, startCircleApp, T0, type CircleApp, type Reply } from './circle-routes.test-util.js';
import { addMember } from './circle-routes.test-util.js';

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

const FORBIDDEN = { code: 'FORBIDDEN', message: 'your role in this circle does not allow that' };
const NO_INVITATION = { code: 'NOT_FOUND', message: 'no such invitation' };
const NO_CIRCLE = { code: 'NOT_FOUND', message: 'no such circle' };
const DAY = 86_400_000;

async function started(extra: Parameters<typeof startCircleApp>[0] = {}) {
  app = await startCircleApp(extra);
  const a = app;
  const tokens: Record<string, string> = {};
  for (const name of ['ann', 'bob', 'cat', 'dan', 'eve']) tokens[name] = await signIn(a, name);
  const made = await call(a.port, 'POST', '/api/circles', { token: tokens.ann, body: { name: 'Team' } });
  const id = made.json.circle.id as string;
  await addMember(a, id, 'bob', 'manager');
  await addMember(a, id, 'cat', 'member');
  return { a, id, ann: tokens.ann as string, bob: tokens.bob as string, cat: tokens.cat as string, dan: tokens.dan as string, eve: tokens.eve as string };
}
const invite = (a: CircleApp, token: string, id: string, username: string, role = 'member') => call(a.port, 'POST', `/api/circles/${id}/invitations`, { token, body: { username, role } });
const mine = async (a: CircleApp, token: string) => (await call(a.port, 'GET', '/api/invitations', { token })).json.items as Array<{ id: string; circle: { id: string; name: string }; role: string; invitedBy: object; createdAt: number; expiresAt: number }>;
const comparable = (r: Reply) => ({ status: r.status, json: r.json, headers: { ...r.headers, date: undefined, 'content-length': r.headers['content-length'] } });

describe('inviting', () => {
  it('202 { invited: true }, and the person finds it addressed to them', async () => {
    const { a, id, ann, dan } = await started();
    const r = await invite(a, ann, id, 'Dan', 'observer');
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ invited: true });
    expect(r.text).toBe('{"invited":true}');
    const seenByDan = await mine(a, dan);
    expect(seenByDan).toEqual([{ id: expect.stringMatching(/^i[a-z0-9]{16}$/), circle: { id, name: 'Team' }, role: 'observer', invitedBy: { displayName: 'Display ann' }, createdAt: T0, expiresAt: T0 + 7 * DAY }]);
  });

  it('the response is the same, byte for byte, whether the account exists, is unknown, is already in, is the inviter, or it is a repeat', async () => {
    const { a, id, ann } = await started();
    const targets = ['dan', 'no-such-person', 'cat', 'ann', 'dan', 'DAN'];
    const replies: Reply[] = [];
    for (const name of targets) replies.push(await invite(a, ann, id, name));
    const first = comparable(replies[0] as Reply);
    for (const [index, r] of replies.entries()) {
      expect(comparable(r), targets[index]).toEqual(first);
      expect(r.text).toBe('{"invited":true}');
    }
    const listed = (await call(a.port, 'GET', `/api/circles/${id}/invitations`, { token: ann })).json.items as Array<{ username: string }>;
    expect(listed.map((i) => i.username).sort()).toEqual(['ann', 'cat', 'dan', 'no-such-person']);
  });

  it('owners invite anyone; managers only members and observers; members and observers nobody, and before the input is looked at', async () => {
    const { a, id, ann, bob, cat } = await started();
    for (const role of ['owner', 'manager', 'member', 'observer']) expect((await invite(a, ann, id, `x-${role}`, role)).status).toBe(202);
    expect((await invite(a, bob, id, 'newbie', 'member')).status).toBe(202);
    for (const role of ['owner', 'manager']) {
      const r = await invite(a, bob, id, 'boss', role);
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ error: FORBIDDEN });
    }
    const member = await call(a.port, 'POST', `/api/circles/${id}/invitations`, { token: cat, body: { garbage: true } });
    expect(member.status).toBe(403);
    expect(member.json).toEqual({ error: FORBIDDEN });
  });

  it('a stranger gets the answer for a circle that does not exist', async () => {
    const { a, id, eve } = await started();
    const real = await invite(a, eve, id, 'someone');
    expect(real.status).toBe(404);
    expect(real.json).toEqual({ error: NO_CIRCLE });
    expect((await invite(a, eve, 'cnonexistent000000', 'someone')).json).toEqual(real.json);
    expect((await call(a.port, 'POST', `/api/circles/${id}/invitations`, { token: eve, body: { garbage: 1 } })).json).toEqual(real.json);
  });

  it('422 naming the field for bad input, and any other field is refused by name', async () => {
    const { a, id, ann } = await started();
    const post = (body: unknown) => call(a.port, 'POST', `/api/circles/${id}/invitations`, { token: ann, body });
    expect((await post({ role: 'member' })).json.error).toMatchObject({ code: 'INVALID_INPUT', field: 'username' });
    expect((await post({ username: 'x', role: 'member' })).json.error.field).toBe('username');
    expect((await post({ username: 'okname' })).json.error.field).toBe('role');
    expect((await post({ username: 'okname', role: 'admin' })).json.error.field).toBe('role');
    for (const key of ['email', 'circleId', 'invitedBy', 'expiresAt']) {
      const r = await post({ username: 'okname', role: 'member', [key]: 'x' });
      expect(r.status).toBe(422);
      expect(r.json.error.field).toBe(key);
    }
    expect((await call(a.port, 'POST', `/api/circles/${id}/invitations`, { token: ann })).status).toBe(422);
  });

  it('429 LIMIT_REACHED at the circle\'s cap of open invitations, and 429 THROTTLED with a whole-second Retry-After at the hourly allowance', async () => {
    const full = await started({ limits: { maxOpenInvitationsPerCircle: 2 } });
    expect((await invite(full.a, full.ann, full.id, 'aaa')).status).toBe(202);
    expect((await invite(full.a, full.ann, full.id, 'bbb')).status).toBe(202);
    const capped = await invite(full.a, full.ann, full.id, 'ccc');
    expect(capped.status).toBe(429);
    expect(capped.json.error.code).toBe('LIMIT_REACHED');
    expect(capped.headers['retry-after']).toBeUndefined();
    expect((await invite(full.a, full.ann, full.id, 'AAA', 'observer')).status).toBe(202); // a repeat is not another place
    await app?.api.close();

    const busy = await started({ limits: { invitationsPerHour: 1 } });
    expect((await invite(busy.a, busy.ann, busy.id, 'aaa')).status).toBe(202);
    const throttled = await invite(busy.a, busy.ann, busy.id, 'bbb');
    expect(throttled.status).toBe(429);
    expect(throttled.json.error.code).toBe('THROTTLED');
    expect(throttled.headers['retry-after']).toBe('3600');
    expect((await invite(busy.a, busy.bob, busy.id, 'bbb')).status).toBe(202); // someone else is not affected
  });
});

describe('the circle\'s open invitations', () => {
  it('owners and managers see them with who sent them; members are 403; a stranger is not told the circle exists', async () => {
    const { a, id, ann, bob, cat, eve } = await started();
    await invite(a, ann, id, 'aaa');
    await invite(a, bob, id, 'bbb', 'observer');
    const r = await call(a.port, 'GET', `/api/circles/${id}/invitations`, { token: bob });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(['items', 'nextCursor']);
    const byName = Object.fromEntries(r.json.items.map((i: { username: string }) => [i.username, i]));
    expect(byName.aaa).toMatchObject({ role: 'member', invitedBy: { userId: a.ids.ann, displayName: 'Display ann' }, createdAt: T0, expiresAt: T0 + 7 * DAY });
    expect(byName.bbb).toMatchObject({ role: 'observer', invitedBy: { userId: a.ids.bob } });
    const forbidden = await call(a.port, 'GET', `/api/circles/${id}/invitations`, { token: cat });
    expect(forbidden.status).toBe(403);
    expect(forbidden.json).toEqual({ error: FORBIDDEN });
    expect((await call(a.port, 'GET', `/api/circles/${id}/invitations`, { token: eve })).json).toEqual({ error: NO_CIRCLE });
  });

  it('pages with limit and cursor, refuses bad ones and unknown parameters by name, and hides expired ones', async () => {
    const { a, id, ann } = await started();
    for (const name of ['aaa', 'bbb', 'ccc', 'ddd', 'eee']) await invite(a, ann, id, name);
    const first = await call(a.port, 'GET', `/api/circles/${id}/invitations?limit=2`, { token: ann });
    expect(first.json.items).toHaveLength(2);
    const second = await call(a.port, 'GET', `/api/circles/${id}/invitations?limit=10&cursor=${encodeURIComponent(first.json.nextCursor)}`, { token: ann });
    expect(second.json.items).toHaveLength(3);
    expect((await call(a.port, 'GET', `/api/circles/${id}/invitations?limit=0`, { token: ann })).json.error.field).toBe('limit');
    expect((await call(a.port, 'GET', `/api/circles/${id}/invitations?cursor=bad`, { token: ann })).json.error.field).toBe('cursor');
    expect((await call(a.port, 'GET', `/api/circles/${id}/invitations?username=aaa`, { token: ann })).json.error.field).toBe('username');
    a.now.value = T0 + 7 * DAY; // sessions idle out after 30 minutes, so sign in again
    expect((await call(a.port, 'GET', `/api/circles/${id}/invitations`, { token: await signInAgain(a, 'ann') })).json.items).toEqual([]);
  });
});

describe('withdrawing an invitation', () => {
  it('204 for an owner (any role) and a manager (members and observers), 403 for a manager over a bigger role, and it can no longer be accepted', async () => {
    const { a, id, ann, bob, cat, dan } = await started();
    await invite(a, ann, id, 'dan', 'manager');
    await invite(a, ann, id, 'eve', 'member');
    const list = (await call(a.port, 'GET', `/api/circles/${id}/invitations`, { token: ann })).json.items as Array<{ id: string; username: string }>;
    const danInvite = list.find((i) => i.username === 'dan') as { id: string };
    const eveInvite = list.find((i) => i.username === 'eve') as { id: string };
    const refused = await call(a.port, 'DELETE', `/api/circles/${id}/invitations/${danInvite.id}`, { token: bob });
    expect(refused.status).toBe(403);
    expect(refused.json).toEqual({ error: FORBIDDEN });
    expect((await call(a.port, 'DELETE', `/api/circles/${id}/invitations/${eveInvite.id}`, { token: cat })).status).toBe(403); // a member
    const gone = await call(a.port, 'DELETE', `/api/circles/${id}/invitations/${eveInvite.id}`, { token: bob });
    expect(gone.status).toBe(204);
    expect(gone.text).toBe('');
    expect((await call(a.port, 'POST', `/api/invitations/${eveInvite.id}/accept`, { token: (await signInAgain(a, 'eve')) })).json).toEqual({ error: NO_INVITATION });
    expect((await call(a.port, 'DELETE', `/api/circles/${id}/invitations/${danInvite.id}`, { token: ann })).status).toBe(204);
    expect(await mine(a, dan)).toEqual([]);
  });

  it('a withdrawal that carries body fields is refused by name and withdraws nothing', async () => {
    const { a, id, ann } = await started();
    await invite(a, ann, id, 'aaa');
    const [first] = (await call(a.port, 'GET', `/api/circles/${id}/invitations`, { token: ann })).json.items as Array<{ id: string }>;
    const r = await call(a.port, 'DELETE', `/api/circles/${id}/invitations/${first?.id}`, { token: ann, body: { force: true } });
    expect(r.status).toBe(422);
    expect(r.json.error.field).toBe('force');
    expect((await call(a.port, 'GET', `/api/circles/${id}/invitations`, { token: ann })).json.items).toHaveLength(1);
  });

  it('"no such invitation" for a made-up id, another circle\'s id and a repeat; a stranger is told "no such circle"', async () => {
    const { a, id, ann, eve } = await started();
    const other = (await call(a.port, 'POST', '/api/circles', { token: ann, body: { name: 'Other' } })).json.circle.id as string;
    await invite(a, ann, id, 'aaa');
    await invite(a, ann, other, 'bbb');
    const mineId = ((await call(a.port, 'GET', `/api/circles/${id}/invitations`, { token: ann })).json.items[0] as { id: string }).id;
    const otherId = ((await call(a.port, 'GET', `/api/circles/${other}/invitations`, { token: ann })).json.items[0] as { id: string }).id;
    expect((await call(a.port, 'DELETE', `/api/circles/${id}/invitations/i0000000000000000`, { token: ann })).json).toEqual({ error: NO_INVITATION });
    expect((await call(a.port, 'DELETE', `/api/circles/${id}/invitations/${otherId}`, { token: ann })).json).toEqual({ error: NO_INVITATION });
    expect((await call(a.port, 'DELETE', `/api/circles/${id}/invitations/${mineId}`, { token: ann })).status).toBe(204);
    expect((await call(a.port, 'DELETE', `/api/circles/${id}/invitations/${mineId}`, { token: ann })).json).toEqual({ error: NO_INVITATION });
    expect((await call(a.port, 'DELETE', `/api/circles/${id}/invitations/${mineId}`, { token: eve })).json).toEqual({ error: NO_CIRCLE });
  });
});

async function signInAgain(a: CircleApp, name: string): Promise<string> {
  const login = await call(a.port, 'POST', '/api/login', { body: { username: name, password: 'correct horse 7 staple' } });
  return login.cookie?.split(';')[0]?.slice('caci_session='.length) as string;
}

describe('my invitations', () => {
  it('shows what is needed to decide and nothing about anyone else, a page at a time', async () => {
    const { a, id, ann, bob, eve } = await started();
    const second = (await call(a.port, 'POST', '/api/circles', { token: bob, body: { name: 'Second' } })).json.circle.id as string;
    await invite(a, ann, id, 'eve', 'manager');
    await invite(a, bob, second, 'eve');
    await invite(a, ann, id, 'somebody-else');
    const r = await call(a.port, 'GET', '/api/invitations', { token: eve });
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(2);
    for (const item of r.json.items) expect(Object.keys(item).sort()).toEqual(['circle', 'createdAt', 'expiresAt', 'id', 'invitedBy', 'role']);
    expect(r.text).not.toContain(a.ids.ann as string);
    expect(r.text).not.toContain(a.ids.bob as string);
    const names = r.json.items.map((i: { circle: { name: string } }) => i.circle.name).sort();
    expect(names).toEqual(['Second', 'Team']);
    const paged = await call(a.port, 'GET', '/api/invitations?limit=1', { token: eve });
    expect(paged.json.items).toHaveLength(1);
    expect((await call(a.port, 'GET', `/api/invitations?limit=1&cursor=${encodeURIComponent(paged.json.nextCursor)}`, { token: eve })).json.items).toHaveLength(1);
    expect((await call(a.port, 'GET', '/api/invitations?limit=abc', { token: eve })).json.error.field).toBe('limit');
    expect((await call(a.port, 'GET', '/api/invitations?cursor=zzz', { token: eve })).json.error.field).toBe('cursor');
    expect((await call(a.port, 'GET', '/api/invitations?circle=x', { token: eve })).json.error.field).toBe('circle');
    expect((await call(a.port, 'GET', '/api/invitations', { token: ann })).json.items).toEqual([]);
  });
});

describe('accepting and declining', () => {
  it('accepting joins with the offered role and shows the circle; the invitation is then gone', async () => {
    const { a, id, ann, eve } = await started();
    await invite(a, ann, id, 'eve', 'manager');
    const [i] = await mine(a, eve);
    a.now.value = T0 + 5000;
    const r = await call(a.port, 'POST', `/api/invitations/${i?.id}/accept`, { token: eve });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(['circle']);
    expect(r.json.circle).toMatchObject({ id, name: 'Team', role: 'manager', memberCount: 4 });
    expect((await call(a.port, 'POST', `/api/invitations/${i?.id}/accept`, { token: eve })).json).toEqual({ error: NO_INVITATION });
    expect(await mine(a, eve)).toEqual([]);
    const roster = (await call(a.port, 'GET', `/api/circles/${id}/members`, { token: eve })).json.items as Array<{ username: string; role: string; joinedAt: number }>;
    expect(roster.find((m) => m.username === 'eve')).toMatchObject({ role: 'manager', joinedAt: T0 + 5000 });
  });

  it('anyone but the person it is addressed to, a made-up id, an expired one and one for a circle that has gone are all 404 "no such invitation"', async () => {
    const { a, id, ann, bob, cat, eve } = await started();
    await invite(a, ann, id, 'eve');
    const other = (await call(a.port, 'POST', '/api/circles', { token: ann, body: { name: 'Gone' } })).json.circle.id as string;
    await invite(a, ann, other, 'eve');
    const items = await mine(a, eve);
    const toTeam = items.find((i) => i.circle.id === id) as { id: string };
    const toGone = items.find((i) => i.circle.id === other) as { id: string };
    for (const token of [ann, bob, cat]) {
      const r = await call(a.port, 'POST', `/api/invitations/${toTeam.id}/accept`, { token });
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ error: NO_INVITATION });
    }
    expect((await call(a.port, 'POST', '/api/invitations/i0000000000000000/accept', { token: eve })).json).toEqual({ error: NO_INVITATION });
    await call(a.port, 'DELETE', `/api/circles/${other}`, { token: ann });
    expect((await call(a.port, 'POST', `/api/invitations/${toGone.id}/accept`, { token: eve })).json).toEqual({ error: NO_INVITATION });
    a.now.value = T0 + 7 * DAY;
    expect((await call(a.port, 'POST', `/api/invitations/${toTeam.id}/accept`, { token: await signInAgain(a, 'eve') })).json).toEqual({ error: NO_INVITATION });
  });

  it('429 LIMIT_REACHED when the circle is full or the person is in the most circles allowed, and the invitation stays open', async () => {
    const full = await started({ limits: { maxMembersPerCircle: 3 } });
    await invite(full.a, full.ann, full.id, 'eve');
    const [i] = await mine(full.a, full.eve);
    const refused = await call(full.a.port, 'POST', `/api/invitations/${i?.id}/accept`, { token: full.eve });
    expect(refused.status).toBe(429);
    expect(refused.json.error.code).toBe('LIMIT_REACHED');
    expect(await mine(full.a, full.eve)).toHaveLength(1);
    await call(full.a.port, 'POST', `/api/circles/${full.id}/leave`, { token: full.cat });
    expect((await call(full.a.port, 'POST', `/api/invitations/${i?.id}/accept`, { token: full.eve })).status).toBe(200);
  });

  it('declining is 204 and ends it for good; only for the person it is addressed to', async () => {
    const { a, id, ann, bob, eve } = await started();
    await invite(a, ann, id, 'eve');
    const [i] = await mine(a, eve);
    expect((await call(a.port, 'POST', `/api/invitations/${i?.id}/decline`, { token: bob })).json).toEqual({ error: NO_INVITATION });
    const declined = await call(a.port, 'POST', `/api/invitations/${i?.id}/decline`, { token: eve });
    expect(declined.status).toBe(204);
    expect(declined.text).toBe('');
    expect((await call(a.port, 'POST', `/api/invitations/${i?.id}/decline`, { token: eve })).json).toEqual({ error: NO_INVITATION });
    expect((await call(a.port, 'POST', `/api/invitations/${i?.id}/accept`, { token: eve })).json).toEqual({ error: NO_INVITATION });
    expect((await call(a.port, 'GET', `/api/circles/${id}`, { token: eve })).status).toBe(404); // declining did not join anything
  });

  it('accept and decline take no body: a field is refused by name', async () => {
    const { a, id, ann, eve } = await started();
    await invite(a, ann, id, 'eve');
    const [i] = await mine(a, eve);
    for (const verb of ['accept', 'decline']) {
      const r = await call(a.port, 'POST', `/api/invitations/${i?.id}/${verb}`, { token: eve, body: { role: 'owner' } });
      expect(r.status).toBe(422);
      expect(r.json.error.field).toBe('role');
    }
    expect(await mine(a, eve)).toHaveLength(1);
  });
});

describe('sessions, methods and shared rules', () => {
  it('every route is 401 without a session, and 401 with a stale cookie that is cleared', async () => {
    const { a } = await started();
    const routes: Array<[string, string]> = [['POST', '/api/circles/cx/invitations'], ['GET', '/api/circles/cx/invitations'], ['DELETE', '/api/circles/cx/invitations/ix'], ['GET', '/api/invitations'], ['POST', '/api/invitations/ix/accept'], ['POST', '/api/invitations/ix/decline']];
    for (const [method, path] of routes) {
      const withBody = method === 'POST' ? { body: {} } : {};
      const none = await call(a.port, method, path, withBody);
      expect(none.status, `${method} ${path}`).toBe(401);
      expect(none.json).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
      const stale = await call(a.port, method, path, { token: 'A'.repeat(43), ...withBody });
      expect(stale.status).toBe(401);
      expect(stale.cookie).toMatch(/Max-Age=0/);
    }
  });

  it('wrong methods are 405 with Allow; cross-origin writes are 403; odd ids are not routes', async () => {
    const { a, ann, id } = await started();
    const wrong = await call(a.port, 'PUT', '/api/invitations/ix/accept', { token: ann, body: {} });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe('POST');
    expect((await call(a.port, 'GET', '/api/invitations/ix/accept', { token: ann })).status).toBe(405);
    expect((await call(a.port, 'DELETE', '/api/invitations', { token: ann })).status).toBe(405);
    const cross = await call(a.port, 'POST', `/api/circles/${id}/invitations`, { token: ann, body: { username: 'someone', role: 'member' }, headers: { origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    for (const path of ['/api/invitations/../accept', '/api/invitations/%2e%2e/accept', `/api/invitations/${'i'.repeat(200)}/accept`, '/api/invitations//accept']) {
      expect((await call(a.port, 'POST', path, { token: ann, body: {} })).status, path).toBe(404);
    }
    expect((await call(a.port, 'POST', `/api/circles/${id}/invitations`, { token: ann, body: 'username=x', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
  });

  it('a storage failure is a fixed 500', async () => {
    const { createMemoryCircleStore } = await import('../circles/index.js');
    const base = createMemoryCircleStore();
    const broken = new Proxy(base, { get: (target, key) => (key === 'listInvitationsFor' ? async () => { throw new Error('secret /var/db/users.db'); } : (target as never)[key]) });
    const s = await started({ store: broken });
    const r = await call(s.a.port, 'GET', '/api/invitations', { token: s.eve });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: { code: 'STORAGE_ERROR', message: 'the circle service could not complete the request' } });
    expect(r.text).not.toContain('secret');
  });
});

describe('a circle forming over HTTP', () => {
  it('create, invite, accept, invite on, accept; everyone sees the same people', async () => {
    app = await startCircleApp();
    const a = app;
    const ann = await signIn(a, 'ann');
    const bob = await signIn(a, 'bob');
    const cat = await signIn(a, 'cat');
    const id = (await call(a.port, 'POST', '/api/circles', { token: ann, body: { name: 'Neighbours' } })).json.circle.id as string;
    expect((await invite(a, ann, id, 'bob', 'manager')).status).toBe(202);
    expect((await call(a.port, 'POST', `/api/invitations/${(await mine(a, bob))[0]?.id}/accept`, { token: bob })).status).toBe(200);
    expect((await invite(a, bob, id, 'cat', 'member')).status).toBe(202);
    expect((await call(a.port, 'POST', `/api/invitations/${(await mine(a, cat))[0]?.id}/accept`, { token: cat })).status).toBe(200);
    for (const token of [ann, bob, cat]) {
      const roster = (await call(a.port, 'GET', `/api/circles/${id}/members`, { token })).json.items as Array<{ username: string; role: string }>;
      expect(Object.fromEntries(roster.map((m) => [m.username, m.role]))).toEqual({ ann: 'owner', bob: 'manager', cat: 'member' });
    }
  });
});
