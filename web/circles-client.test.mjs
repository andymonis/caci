import { describe, expect, it } from 'vitest';
import { createCirclesClient, isCircleId, isInvitationId, isRole, isUserId } from './circles-client.js';

const C = 'c0123456789abcdef';
const C2 = 'cabcdefghij012345';
const I = 'i0123456789abcdef';
const U = 'u0123456789abcdef';
const CIRCLE = { id: C, name: 'Team', description: 'About us', role: 'owner', memberCount: 3, createdAt: 10, updatedAt: 20 };
const MEMBER = { userId: U, username: 'bob', displayName: 'Bob B', role: 'manager', joinedAt: 30 };
const INVITATION = { id: I, username: 'carol', role: 'member', invitedBy: { userId: U, displayName: 'Bob B' }, createdAt: 1, expiresAt: 2 };
const MINE = { id: I, circle: { id: C, name: 'Team' }, role: 'member', invitedBy: { displayName: 'Bob B' }, createdAt: 1, expiresAt: 2 };

function fake(answer) {
  const calls = [];
  const fetchFn = async (path, init) => {
    calls.push({ path, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const a = typeof answer === 'function' ? answer(path, init) : answer;
    if (a instanceof Error) throw a;
    return { status: a.status, headers: { get: (n) => (a.headers && a.headers[n]) ?? null }, text: async () => (a.raw !== undefined ? a.raw : a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { calls, client: createCirclesClient({ fetchFn }) };
}
const err = (status, error, headers) => ({ status, body: { error }, ...(headers ? { headers } : {}) });

describe('the ids', () => {
  it('are recognised only in the exact shapes the service makes', () => {
    expect(isCircleId(C) && isInvitationId(I) && isUserId(U)).toBe(true);
    expect(isCircleId(I) || isCircleId(U) || isInvitationId(C) || isUserId(C)).toBe(false);
    for (const bad of ['', 'c', 'c0123456789abcde', 'c0123456789abcdef0', 'C0123456789abcdef', 'c0123456789ABCDEF', ' c0123456789abcdef', 'c0123456789abcdef\n', 'c0123456789abcd/f', 'c0123456789abcd..', '../etc/passwd', 'c0123456789abcdé', 5, null, undefined, {}, ['c0123456789abcdef']]) {
      expect(isCircleId(bad), String(bad)).toBe(false);
    }
  });
  it('roles are exactly the four', () => {
    for (const r of ['owner', 'manager', 'member', 'observer']) expect(isRole(r)).toBe(true);
    for (const r of ['admin', 'Owner', '', 'toString', '__proto__', 5, null]) expect(isRole(r), String(r)).toBe(false);
  });
});

describe('what is sent', () => {
  it('each call goes to its route with its method, by path only, with the same settings as every other request', async () => {
    const { calls, client } = fake({ status: 200, body: { circle: CIRCLE, items: [], nextCursor: null, member: MEMBER, invited: true } });
    await client.listCircles();
    await client.createCircle({ name: 'Team' });
    await client.getCircle(C);
    await client.updateCircle(C, { name: 'New' });
    await client.deleteCircle(C);
    await client.listMembers(C);
    await client.changeRole(C, U, 'member');
    await client.removeMember(C, U);
    await client.leaveCircle(C);
    await client.invite(C, { username: 'carol', role: 'member' });
    await client.listInvitations(C);
    await client.withdrawInvitation(C, I);
    await client.myInvitations();
    await client.acceptInvitation(I);
    await client.declineInvitation(I);
    expect(calls.map((c) => `${c.init.method} ${c.path}`)).toEqual([
      'GET /api/circles',
      'POST /api/circles',
      `GET /api/circles/${C}`,
      `PATCH /api/circles/${C}`,
      `DELETE /api/circles/${C}`,
      `GET /api/circles/${C}/members`,
      `PATCH /api/circles/${C}/members/${U}`,
      `DELETE /api/circles/${C}/members/${U}`,
      `POST /api/circles/${C}/leave`,
      `POST /api/circles/${C}/invitations`,
      `GET /api/circles/${C}/invitations`,
      `DELETE /api/circles/${C}/invitations/${I}`,
      'GET /api/invitations',
      `POST /api/invitations/${I}/accept`,
      `POST /api/invitations/${I}/decline`,
    ]);
    for (const { path, init } of calls) {
      expect(path.startsWith('/api/')).toBe(true);
      expect(init.credentials).toBe('same-origin');
      expect(init.cache).toBe('no-store');
      expect(init.redirect).toBe('error');
      expect(Object.keys(init.headers).filter((h) => !['accept', 'content-type'].includes(h))).toEqual([]);
    }
  });

  it('bodies carry only the fields each call is meant to send', async () => {
    const { calls, client } = fake({ status: 200, body: { circle: CIRCLE, member: MEMBER, invited: true } });
    await client.createCircle({ name: 'Team', description: 'About', owner: 'u1', id: 'c1' });
    await client.createCircle({ name: 'Team', description: '' });
    await client.createCircle({ name: 'Team' });
    await client.updateCircle(C, { name: 'N', description: null, role: 'owner' });
    await client.changeRole(C, U, 'member');
    await client.invite(C, { username: 'carol', role: 'member', email: 'x', circleId: 'y' });
    expect(calls.map((c) => c.body)).toEqual([
      { name: 'Team', description: 'About' },
      { name: 'Team' },
      { name: 'Team' },
      { name: 'N', description: null },
      { role: 'member' },
      { username: 'carol', role: 'member' },
    ]);
  });

  it('calls without a body send none, and no content type', async () => {
    const { calls, client } = fake({ status: 204 });
    await client.deleteCircle(C);
    await client.leaveCircle(C);
    await client.acceptInvitation(I);
    for (const c of calls) {
      expect('body' in c.init).toBe(false);
      expect('content-type' in c.init.headers).toBe(false);
    }
  });

  it('an update with nothing in it is not sent', async () => {
    const { calls, client } = fake({ status: 200, body: { circle: CIRCLE } });
    for (const change of [undefined, null, {}, { owner: 'x' }, 'name', 5]) {
      const r = await client.updateCircle(C, change);
      expect(r).toEqual({ ok: false, error: { kind: 'invalid', field: 'body', message: 'Nothing to change.' } });
    }
    expect(calls).toEqual([]);
  });
});

describe('a bad id is a not-found and nothing is sent', () => {
  const bad = ['', 'x', '..', '../x', `${C}/members`, `${C}?x=1`, `${C}%2f`, 'C0123456789ABCDEF', 'c0123456789ABCDEF', 5, null, undefined, {}, [C]];
  it('for every call that takes one', async () => {
    const { calls, client } = fake({ status: 200, body: {} });
    for (const id of bad) {
      for (const call of [() => client.getCircle(id), () => client.updateCircle(id, { name: 'x' }), () => client.deleteCircle(id), () => client.listMembers(id), () => client.leaveCircle(id), () => client.invite(id, { username: 'carol', role: 'member' }), () => client.listInvitations(id), () => client.changeRole(id, U, 'member'), () => client.removeMember(id, U), () => client.withdrawInvitation(id, I)]) {
        expect(await call(), String(id)).toEqual({ ok: false, error: { kind: 'not-found', what: 'circle', message: 'No such circle, or you are not in it.' } });
      }
      expect(await client.acceptInvitation(id)).toEqual({ ok: false, error: { kind: 'not-found', what: 'invitation', message: 'No such invitation: it may have been withdrawn, used or expired.' } });
      expect(await client.declineInvitation(id)).toMatchObject({ error: { kind: 'not-found', what: 'invitation' } });
      expect(await client.withdrawInvitation(C, id)).toMatchObject({ error: { kind: 'not-found', what: 'invitation' } });
      expect(await client.changeRole(C, id, 'member')).toEqual({ ok: false, error: { kind: 'not-found', what: 'member', message: 'That person is no longer in this circle.' } });
      expect(await client.removeMember(C, id)).toMatchObject({ error: { kind: 'not-found', what: 'member' } });
    }
    expect(calls).toEqual([]);
  });

  it('a circle id is not accepted where an invitation id goes, or the other way round', async () => {
    const { calls, client } = fake({ status: 204 });
    expect((await client.acceptInvitation(C)).ok).toBe(false);
    expect((await client.getCircle(I)).ok).toBe(false);
    expect((await client.removeMember(C, I)).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('paging', () => {
  it('limit and cursor go in the query string, encoded, and only when given', async () => {
    const { calls, client } = fake({ status: 200, body: { items: [], nextCursor: null } });
    await client.listCircles();
    await client.listCircles({});
    await client.listCircles({ limit: 25 });
    await client.listCircles({ cursor: 'kYWJj' });
    await client.listMembers(C, { limit: 100, cursor: 'k-_9' });
    await client.listCircles({ cursor: null });
    expect(calls.map((c) => c.path)).toEqual(['/api/circles', '/api/circles', '/api/circles?limit=25', '/api/circles?cursor=kYWJj', `/api/circles/${C}/members?limit=100&cursor=k-_9`, '/api/circles']);
  });

  it('a bad limit or cursor is refused before sending, naming the field', async () => {
    const { calls, client } = fake({ status: 200, body: { items: [], nextCursor: null } });
    for (const limit of [0, -1, 101, 1.5, Number.NaN, '5', null, Number.POSITIVE_INFINITY]) expect(await client.listCircles({ limit }), String(limit)).toMatchObject({ ok: false, error: { kind: 'invalid', field: 'limit' } });
    for (const cursor of ['', 'a b', 'a&limit=1', 'x#y', 'é', 'a'.repeat(513), 5, {}]) expect(await client.listCircles({ cursor }), String(cursor)).toMatchObject({ ok: false, error: { kind: 'invalid', field: 'cursor' } });
    expect(await client.listCircles('page')).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(calls).toEqual([]);
  });

  it('a page is its items and the cursor for the next one, frozen', async () => {
    const { client } = fake({ status: 200, body: { items: [CIRCLE, { ...CIRCLE, id: C2 }], nextCursor: 'kMQ' } });
    const r = await client.listCircles();
    expect(r.value.items.map((c) => c.id)).toEqual([C, C2]);
    expect(r.value.nextCursor).toBe('kMQ');
    expect(Object.isFrozen(r.value) && Object.isFrozen(r.value.items) && Object.isFrozen(r.value.items[0])).toBe(true);
  });

  it('one item that is not shaped right refuses the whole page; so does a bad cursor', async () => {
    for (const body of [{ items: [CIRCLE, { ...CIRCLE, role: 'admin' }], nextCursor: null }, { items: [CIRCLE], nextCursor: '' }, { items: [CIRCLE], nextCursor: 5 }, { items: [CIRCLE] }, { items: 'x', nextCursor: null }, { nextCursor: null }, []]) {
      const r = await fake({ status: 200, body }).client.listCircles();
      expect(r, JSON.stringify(body).slice(0, 40)).toEqual({ ok: false, error: { kind: 'server', message: 'Something went wrong on the service. Try again in a moment.' } });
    }
  });
});

describe('what comes back when it works', () => {
  it('a circle keeps only its own fields', async () => {
    const { client } = fake({ status: 200, body: { circle: { ...CIRCLE, graphId: 'user-u1', email: 'a@b.co', members: ['x'] } } });
    const r = await client.getCircle(C);
    expect(r).toEqual({ ok: true, value: CIRCLE });
    expect(JSON.stringify(r)).not.toMatch(/graph|email|members/);
  });

  it('a circle without a description has no description key', async () => {
    const plain = { ...CIRCLE };
    delete plain.description;
    const r = await fake({ status: 200, body: { circle: plain } }).client.getCircle(C);
    expect('description' in r.value).toBe(false);
  });

  it('members, invitations and my invitations keep only their own fields, and an invitation to me carries no inviter id', async () => {
    const members = await fake({ status: 200, body: { items: [{ ...MEMBER, email: 'x@y.co', passwordHash: 'h' }], nextCursor: null } }).client.listMembers(C);
    expect(members.value.items[0]).toEqual(MEMBER);
    const open = await fake({ status: 200, body: { items: [{ ...INVITATION, token: 't' }], nextCursor: null } }).client.listInvitations(C);
    expect(open.value.items[0]).toEqual(INVITATION);
    const mine = await fake({ status: 200, body: { items: [{ ...MINE, invitedBy: { displayName: 'Bob B', userId: U } }], nextCursor: null } }).client.myInvitations();
    expect(mine.value.items[0]).toEqual(MINE);
    expect(JSON.stringify(mine)).not.toContain(U);
  });

  it('a member may lack names (the account is gone) and still be shown', async () => {
    const r = await fake({ status: 200, body: { items: [{ userId: U, role: 'member', joinedAt: 1 }], nextCursor: null } }).client.listMembers(C);
    expect(r.value.items[0]).toEqual({ userId: U, role: 'member', joinedAt: 1 });
  });

  it('change role gives the member; invite gives { invited: true }; the rest give true', async () => {
    expect(await fake({ status: 200, body: { member: MEMBER } }).client.changeRole(C, U, 'manager')).toEqual({ ok: true, value: MEMBER });
    expect(await fake({ status: 202, body: { invited: true } }).client.invite(C, { username: 'c', role: 'member' })).toEqual({ ok: true, value: { invited: true } });
    expect(await fake({ status: 204 }).client.leaveCircle(C)).toEqual({ ok: true, value: true });
    expect(await fake({ status: 200, body: { circle: CIRCLE } }).client.acceptInvitation(I)).toEqual({ ok: true, value: CIRCLE });
  });

  it('an invitation answer is the same whatever the username was', async () => {
    const answers = [];
    for (const username of ['exists', 'unknown', 'self']) answers.push(await fake({ status: 202, body: { invited: true } }).client.invite(C, { username, role: 'member' }));
    for (const a of answers) expect(a).toEqual(answers[0]);
  });

  it('answers that are not shaped right are server problems, never crashes', async () => {
    const odd = [
      [{ circle: { ...CIRCLE, id: 'nope' } }, 'getCircle'],
      [{ circle: { ...CIRCLE, role: 'chief' } }, 'getCircle'],
      [{ circle: { ...CIRCLE, memberCount: -1 } }, 'getCircle'],
      [{ circle: { ...CIRCLE, memberCount: 1.5 } }, 'getCircle'],
      [{ circle: { ...CIRCLE, name: 5 } }, 'getCircle'],
      [{ circle: { ...CIRCLE, description: 5 } }, 'getCircle'],
      [{ circle: { ...CIRCLE, createdAt: 'x' } }, 'getCircle'],
      [{ circle: null }, 'getCircle'],
      [{}, 'getCircle'],
      [{ member: { ...MEMBER, userId: 'bad' } }, 'changeRole'],
      [{ member: { ...MEMBER, role: 'x' } }, 'changeRole'],
      [{ member: { ...MEMBER, username: 5 } }, 'changeRole'],
      [{ invited: false }, 'invite'],
      [{}, 'invite'],
    ];
    for (const [body, method] of odd) {
      const { client } = fake({ status: 200, body });
      const r = method === 'changeRole' ? await client.changeRole(C, U, 'member') : method === 'invite' ? await client.invite(C, { username: 'c', role: 'member' }) : await client.getCircle(C);
      expect(r.ok, JSON.stringify(body).slice(0, 50)).toBe(false);
      expect(r.error.kind).toBe('server');
    }
    for (const body of [{ items: [{ ...INVITATION, invitedBy: { userId: 'bad' } }], nextCursor: null }, { items: [{ ...INVITATION, id: C }], nextCursor: null }, { items: [{ ...INVITATION, expiresAt: -1 }], nextCursor: null }]) {
      expect((await fake({ status: 200, body }).client.listInvitations(C)).error.kind).toBe('server');
    }
    for (const body of [{ items: [{ ...MINE, circle: { id: 'bad', name: 'x' } }], nextCursor: null }, { items: [{ ...MINE, circle: { id: C } }], nextCursor: null }, { items: [{ ...MINE, invitedBy: null }], nextCursor: null }]) {
      expect((await fake({ status: 200, body }).client.myInvitations()).error.kind).toBe('server');
    }
  });
});

describe('what a person is told', () => {
  const words = {
    signedOut: 'Your session has ended. Sign in again.',
    forbidden: 'Your role in this circle does not allow that.',
  };

  it('401 is signed-out, with the words for it, on every call', async () => {
    const { client } = fake(err(401, { code: 'UNAUTHENTICATED', message: 'not signed in' }));
    for (const r of [await client.listCircles(), await client.createCircle({ name: 'x' }), await client.getCircle(C), await client.myInvitations(), await client.acceptInvitation(I), await client.leaveCircle(C)]) {
      expect(r.error).toEqual({ kind: 'signed-out', message: words.signedOut });
    }
  });

  it('403 is forbidden, in our words, never the service\'s', async () => {
    const r = await fake(err(403, { code: 'FORBIDDEN', message: 'secret internals' })).client.updateCircle(C, { name: 'x' });
    expect(r.error).toEqual({ kind: 'forbidden', message: words.forbidden });
  });

  it('404 says what was not found, by what the call was about', async () => {
    const notFound = err(404, { code: 'NOT_FOUND', message: 'whatever the service says' });
    expect((await fake(notFound).client.getCircle(C)).error).toEqual({ kind: 'not-found', what: 'circle', message: 'No such circle, or you are not in it.' });
    expect((await fake(notFound).client.deleteCircle(C)).error.what).toBe('circle');
    expect((await fake(notFound).client.acceptInvitation(I)).error).toEqual({ kind: 'not-found', what: 'invitation', message: 'No such invitation: it may have been withdrawn, used or expired.' });
    expect((await fake(notFound).client.declineInvitation(I)).error.what).toBe('invitation');
    expect((await fake(notFound).client.withdrawInvitation(C, I)).error.what).toBe('invitation');
    expect((await fake(notFound).client.changeRole(C, U, 'member')).error).toEqual({ kind: 'not-found', what: 'member', message: 'That person is no longer in this circle.' });
    expect((await fake(notFound).client.removeMember(C, U)).error.what).toBe('member');
  });

  it('409 for the only owner uses the service\'s words; any other 409 is a plain conflict', async () => {
    const r = await fake(err(409, { code: 'LAST_OWNER', message: 'you are the only owner: make someone else an owner, or delete the circle' })).client.leaveCircle(C);
    expect(r.error).toEqual({ kind: 'last-owner', message: 'you are the only owner: make someone else an owner, or delete the circle' });
    expect((await fake(err(409, { code: 'LAST_OWNER' })).client.leaveCircle(C)).error.message).toBe('You are the only owner: make someone else an owner, or delete the circle.');
    expect((await fake(err(409, { code: 'CONFLICT', message: 'busy' })).client.createCircle({ name: 'x' })).error).toEqual({ kind: 'conflict', message: 'busy' });
    expect((await fake({ status: 409 }).client.createCircle({ name: 'x' })).error).toEqual({ kind: 'conflict', message: 'That cannot be done right now.' });
  });

  it('422 shows the message and names the field only when the call has that field', async () => {
    const invalid = (field) => err(422, { code: 'INVALID_INPUT', message: `bad ${field}`, field });
    expect((await fake(invalid('name')).client.createCircle({})).error).toEqual({ kind: 'invalid', message: 'bad name', field: 'name' });
    expect((await fake(invalid('description')).client.updateCircle(C, { description: 'x' })).error.field).toBe('description');
    expect((await fake(invalid('username')).client.invite(C, {})).error.field).toBe('username');
    expect((await fake(invalid('role')).client.invite(C, {})).error.field).toBe('role');
    expect((await fake(invalid('role')).client.changeRole(C, U, 'x')).error.field).toBe('role');
    for (const field of ['username', 'owner', 'body', '__proto__', 5, undefined]) expect((await fake(invalid(field)).client.createCircle({})).error.field, String(field)).toBeUndefined();
    expect((await fake(invalid('name')).client.changeRole(C, U, 'x')).error.field).toBeUndefined(); // not a field of that call
    expect((await fake({ status: 422 }).client.createCircle({})).error.message).toBe('Please check what you typed.');
  });

  it('429 is a limit (the service\'s words) or a wait (from Retry-After)', async () => {
    const limit = await fake(err(429, { code: 'LIMIT_REACHED', message: 'a person may be in at most 20 circles' })).client.createCircle({ name: 'x' });
    expect(limit.error).toEqual({ kind: 'limit', message: 'a person may be in at most 20 circles' });
    expect((await fake(err(429, { code: 'LIMIT_REACHED' })).client.createCircle({ name: 'x' })).error.message).toBe('A limit has been reached.');
    const wait = await fake(err(429, { code: 'THROTTLED', message: 'x' }, { 'retry-after': '90' })).client.invite(C, { username: 'c', role: 'member' });
    expect(wait.error).toEqual({ kind: 'throttled', message: 'Too many tries. Wait 90 seconds and try again.', retryAfterSeconds: 90 });
    expect((await fake(err(429, { code: 'THROTTLED' }, { 'retry-after': '1' })).client.invite(C, {})).error.message).toBe('Too many tries. Wait 1 second and try again.');
    for (const header of [undefined, '', 'soon', '-1']) {
      const e = (await fake(err(429, { code: 'THROTTLED' }, header === undefined ? undefined : { 'retry-after': header })).client.invite(C, {})).error;
      expect(e, String(header)).toEqual({ kind: 'throttled', message: 'Too many tries. Wait a little and try again.' });
    }
  });

  it('anything else, an unreachable service and a broken answer are server or network, with nothing from inside', async () => {
    for (const status of [400, 405, 413, 500, 502, 503, 301]) {
      expect((await fake({ status, body: { error: { code: 'INTERNAL_ERROR', message: 'secret /var/db' } } }).client.getCircle(C)).error, String(status)).toEqual({ kind: 'server', message: 'Something went wrong on the service. Try again in a moment.' });
    }
    expect((await fake(new TypeError('Failed to fetch')).client.getCircle(C)).error.kind).toBe('network');
    expect((await fake({ status: 200, raw: 'not json' }).client.getCircle(C)).error.kind).toBe('server');
  });

  it('the service\'s words are cleaned: controls become spaces, long text is cut, markup stays text', async () => {
    const r = await fake(err(409, { code: 'LAST_OWNER', message: `a\nb<script>x</script>${'z'.repeat(400)}` })).client.leaveCircle(C);
    expect(r.error.message.startsWith('a b<script>x</script>')).toBe(true);
    expect(r.error.message).toHaveLength(300);
  });

  it('never throws, whatever fetch gives back', async () => {
    for (const odd of [undefined, null, 5, 'x', {}, { status: 'ok' }, { status: 200 }, { status: 200, text: 5 }]) {
      const client = createCirclesClient({ fetchFn: async () => odd });
      for (const call of [() => client.listCircles(), () => client.getCircle(C), () => client.leaveCircle(C), () => client.myInvitations()]) expect(typeof (await call()).ok).toBe('boolean');
    }
    const throwingHeaders = createCirclesClient({ fetchFn: async () => ({ status: 429, headers: { get: () => { throw new Error('no'); } }, text: async () => '{}' }) });
    expect((await throwingHeaders.getCircle(C)).error.kind).toBe('throttled');
  });

  it('errors are frozen, and a client needs a fetch', async () => {
    expect(Object.isFrozen((await fake({ status: 500 }).client.getCircle(C)).error)).toBe(true);
    for (const bad of [undefined, null, 'fetch', {}]) expect(() => createCirclesClient({ fetchFn: bad })).toThrow(TypeError);
  });
});
