import { describe, expect, it } from 'vitest';
import { createJoinClient, isJoinLinkId, isJoinRequestId, isJoinToken, UNAVAILABLE } from './join-client.js';

const C = 'c0123456789abcdef';
const J = 'j0123456789abcdef';
const R = 'r0123456789abcdef';
const U = 'u0123456789abcdef';
const TOKEN = `cjoin_${'Ab1_-'.repeat(8)}Abc`;
const LINK = { id: J, role: 'member', label: 'Club', createdBy: { userId: U, displayName: 'Ann A' }, createdAt: 1, expiresAt: 2, maxUses: 3, uses: 1, approval: true };
const REQUEST = { id: R, person: { displayName: 'Eve E' }, role: 'observer', createdAt: 1, expiresAt: 2 };
const MINE = { id: R, circle: { name: 'Team' }, role: 'observer', createdAt: 1, expiresAt: 2 };
const CIRCLE = { id: C, name: 'Team', role: 'member', memberCount: 3, createdAt: 10, updatedAt: 20 };
const MEMBER = { userId: U, username: 'eve', displayName: 'Eve E', role: 'observer', joinedAt: 30 };

function fake(answer) {
  const calls = [];
  const fetchFn = async (path, init) => {
    calls.push({ path, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const a = typeof answer === 'function' ? answer(path, init) : answer;
    if (a instanceof Error) throw a;
    return { status: a.status, headers: { get: (n) => (a.headers && a.headers[n]) ?? null }, text: async () => (a.raw !== undefined ? a.raw : a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { calls, client: createJoinClient({ fetchFn }) };
}
const err = (status, error, headers) => ({ status, body: { error }, ...(headers ? { headers } : {}) });
const NOT = (message) => err(404, { code: 'NOT_FOUND', message });

describe('the shapes', () => {
  it('ids and tokens are recognised only in the exact shapes the service makes', () => {
    expect(isJoinLinkId(J) && isJoinRequestId(R) && isJoinToken(TOKEN)).toBe(true);
    expect(isJoinLinkId(R) || isJoinRequestId(J)).toBe(false);
    for (const bad of ['', 'j', 'j0123456789abcde', 'j0123456789abcdef0', 'xj0123456789abcdef', 'J0123456789abcdef', 'j0123456789abcd/f', 5, null, undefined, {}]) expect(isJoinLinkId(bad), String(bad)).toBe(false);
    for (const bad of ['', 'r', 'r0123456789abcde', 'r0123456789abcdef0', 'xr0123456789abcdef', 'R0123456789abcdef', 'r0123456789abcd/f', 5, null, undefined, {}]) expect(isJoinRequestId(bad), String(bad)).toBe(false);
    for (const bad of ['', 'cjoin_', `cjoin_${'A'.repeat(42)}`, `cjoin_${'A'.repeat(44)}`, `cpat_${'A'.repeat(43)}`, `${TOKEN} `, `${TOKEN}\n`, `cjoin_${'A'.repeat(42)}/`, `cjoin_${'A'.repeat(42)}é`, 5, null, undefined]) expect(isJoinToken(bad), String(bad)).toBe(false);
  });
});

describe('what is sent', () => {
  it('each call goes to its route by path only, the token only ever in a body', async () => {
    const { calls, client } = fake({ status: 200, body: { token: TOKEN, link: LINK, items: [], nextCursor: null, preview: { circle: { name: 'T' }, role: 'member', createdBy: {} }, result: { state: 'waiting', circle: { name: 'T' }, role: 'member', expiresAt: 5 }, member: MEMBER } });
    await client.createLink(C, { label: 'Club' });
    await client.listLinks(C);
    await client.revokeLink(C, J);
    await client.preview(TOKEN);
    await client.join(TOKEN);
    await client.listRequests(C);
    await client.approve(C, R);
    await client.decline(C, R);
    await client.myRequests();
    expect(calls.map((c) => `${c.init.method} ${c.path}`)).toEqual([
      `POST /api/circles/${C}/join-links`,
      `GET /api/circles/${C}/join-links`,
      `DELETE /api/circles/${C}/join-links/${J}`,
      'POST /api/join/preview',
      'POST /api/join',
      `GET /api/circles/${C}/join-requests`,
      `POST /api/circles/${C}/join-requests/${R}/approve`,
      `POST /api/circles/${C}/join-requests/${R}/decline`,
      'GET /api/join-requests',
    ]);
    for (const c of calls) {
      expect(c.path.startsWith('/')).toBe(true);
      expect(c.path).not.toContain(TOKEN);
      expect(c.path).not.toContain('?token');
      expect(c.init.credentials).toBe('same-origin');
      expect(c.init.headers.authorization).toBeUndefined();
    }
    expect(calls[3]?.body).toEqual({ token: TOKEN });
    expect(calls[4]?.body).toEqual({ token: TOKEN });
    expect(calls.filter((c) => c.body !== undefined && 'token' in c.body)).toHaveLength(2);
  });

  it('a new link sends only what is given, and a token that is not shaped right is a miss that is never sent', async () => {
    const { calls, client } = fake({ status: 201, body: { token: TOKEN, link: LINK } });
    await client.createLink(C, { label: 'Club' });
    await client.createLink(C, { label: 'Club', role: 'member', days: 3, uses: 2, approval: false, extra: 'x' });
    expect(calls[0]?.body).toEqual({ label: 'Club' });
    expect(calls[1]?.body).toEqual({ label: 'Club', role: 'member', days: 3, uses: 2, approval: false });
    for (const bad of ['', 'abc', `cjoin_${'A'.repeat(42)}`, 5, null, undefined]) {
      for (const run of [() => client.preview(bad), () => client.join(bad)]) {
        const r = await run();
        expect(r, String(bad)).toMatchObject({ ok: false, error: { kind: 'not-found', what: 'link' } });
      }
    }
    expect(calls).toHaveLength(2);
  });

  it('a bad id is a not-found and nothing is sent', async () => {
    const { calls, client } = fake({ status: 200, body: {} });
    for (const bad of ['', 'c1', '../x', 'c0123456789abcde%', 5, null, undefined]) {
      expect((await client.listLinks(bad)).error.what, String(bad)).toBe('circle');
      expect((await client.createLink(bad, { label: 'x' })).error.kind).toBe('not-found');
      expect((await client.listRequests(bad)).error.kind).toBe('not-found');
    }
    for (const bad of ['', 'j1', R, 'j0123456789abcd/f', 5, null]) expect((await client.revokeLink(C, bad)).error.what, String(bad)).toBe('link');
    for (const bad of ['', 'r1', J, 5, null]) {
      expect((await client.approve(C, bad)).error.what, String(bad)).toBe('request');
      expect((await client.decline(C, bad)).error.what, String(bad)).toBe('request');
    }
    expect(calls).toEqual([]);
  });

  it('paging builds the query only when given, and refuses a bad limit or cursor naming it', async () => {
    const { calls, client } = fake({ status: 200, body: { items: [], nextCursor: null } });
    await client.listLinks(C, { limit: 5, cursor: 'abc_-9' });
    await client.listRequests(C, { limit: 100 });
    await client.myRequests({ cursor: 'zz' });
    expect(calls.map((c) => c.path)).toEqual([`/api/circles/${C}/join-links?limit=5&cursor=abc_-9`, `/api/circles/${C}/join-requests?limit=100`, '/api/join-requests?cursor=zz']);
    for (const limit of [0, 101, 1.5, '5']) expect((await client.listLinks(C, { limit })).error.field, String(limit)).toBe('limit');
    for (const cursor of ['a b', 'a/b', '', 'x'.repeat(513), 5]) expect((await client.myRequests({ cursor })).error.field, String(cursor)).toBe('cursor');
    expect(calls).toHaveLength(3);
  });
});

describe('what comes back', () => {
  it('a new link gives its token once with the link, frozen, and a list gives links without any token', async () => {
    const made = await fake({ status: 201, body: { token: TOKEN, link: { ...LINK, tokenHash: 'x', extra: 1 } } }).client.createLink(C, { label: 'x' });
    expect(made.value).toEqual({ token: TOKEN, link: LINK });
    expect(Object.isFrozen(made.value) && Object.isFrozen(made.value.link) && Object.isFrozen(made.value.link.createdBy)).toBe(true);
    const listed = await fake({ status: 200, body: { items: [LINK], nextCursor: 'next' } }).client.listLinks(C);
    expect(listed.value).toEqual({ items: [LINK], nextCursor: 'next' });
    expect(JSON.stringify(listed.value)).not.toContain('cjoin_');
  });

  it('a link may have no creator name; a page with one wrongly shaped item is refused whole', async () => {
    const bare = { ...LINK, createdBy: { userId: U } };
    expect((await fake({ status: 200, body: { items: [bare], nextCursor: null } }).client.listLinks(C)).value.items[0].createdBy).toEqual({ userId: U });
    const bad = [{ ...LINK, role: 'owner' }, { ...LINK, id: 'x' }, { ...LINK, maxUses: 0 }, { ...LINK, uses: -1 }, { ...LINK, approval: 'yes' }, { ...LINK, label: 5 }, { ...LINK, createdBy: { userId: 'x' } }, { ...LINK, createdAt: 1.5 }];
    for (const item of bad) expect((await fake({ status: 200, body: { items: [LINK, item], nextCursor: null } }).client.listLinks(C)).error.kind, JSON.stringify(item)).toBe('server');
    expect((await fake({ status: 200, body: { items: [LINK], nextCursor: '' } }).client.listLinks(C)).error.kind).toBe('server');
    expect((await fake({ status: 201, body: { token: 'cjoin_short', link: LINK } }).client.createLink(C, { label: 'x' })).error.kind).toBe('server');
    expect((await fake({ status: 201, body: { link: LINK } }).client.createLink(C, { label: 'x' })).error.kind).toBe('server');
  });

  it('a preview is the name, the role and the creator, cut down', async () => {
    const r = await fake({ status: 200, body: { preview: { circle: { name: 'Team', id: C }, role: 'member', createdBy: { displayName: 'Ann', userId: U } } } }).client.preview(TOKEN);
    expect(r.value).toEqual({ circle: { name: 'Team' }, role: 'member', createdBy: { displayName: 'Ann' } });
    expect((await fake({ status: 200, body: { preview: { circle: { name: 'Team' }, role: 'member', createdBy: {} } } }).client.preview(TOKEN)).value.createdBy).toEqual({});
    for (const preview of [{ circle: { name: 5 }, role: 'member', createdBy: {} }, { circle: { name: 'T' }, role: 'owner', createdBy: {} }, { circle: { name: 'T' }, role: 'member' }, null]) expect((await fake({ status: 200, body: { preview } }).client.preview(TOKEN)).error.kind).toBe('server');
  });

  it('a join answers joined or member with the circle, requested or waiting with the name, role and end time only', async () => {
    for (const state of ['joined', 'member']) expect((await fake({ status: 200, body: { result: { state, circle: CIRCLE } } }).client.join(TOKEN)).value).toEqual({ state, circle: CIRCLE });
    for (const state of ['requested', 'waiting']) {
      const r = await fake({ status: 200, body: { result: { state, circle: { name: 'Team', id: C }, role: 'observer', expiresAt: 9, extra: 1 } } }).client.join(TOKEN);
      expect(r.value).toEqual({ state, circle: { name: 'Team' }, role: 'observer', expiresAt: 9 });
    }
    for (const result of [{ state: 'other', circle: CIRCLE }, { state: 'joined', circle: { ...CIRCLE, role: 'x' } }, { state: 'waiting', circle: { name: 'T' }, role: 'member' }, { state: 'requested', circle: { name: 1 }, role: 'member', expiresAt: 1 }, null]) {
      expect((await fake({ status: 200, body: { result } }).client.join(TOKEN)).error.kind, JSON.stringify(result)).toBe('server');
    }
  });

  it('requests: the requester by display name only, and a person\'s own with the circle\'s name only', async () => {
    const list = await fake({ status: 200, body: { items: [{ ...REQUEST, person: { displayName: 'Eve E', userId: U } }], nextCursor: null } }).client.listRequests(C);
    expect(list.value.items).toEqual([REQUEST]);
    expect((await fake({ status: 200, body: { items: [{ ...REQUEST, person: {} }], nextCursor: null } }).client.listRequests(C)).value.items[0].person).toEqual({});
    const mine = await fake({ status: 200, body: { items: [{ ...MINE, circle: { name: 'Team', id: C } }], nextCursor: null } }).client.myRequests();
    expect(mine.value.items).toEqual([MINE]);
    for (const bad of [{ ...REQUEST, role: 'manager' }, { ...REQUEST, id: 'x' }, { ...REQUEST, person: null }]) expect((await fake({ status: 200, body: { items: [bad], nextCursor: null } }).client.listRequests(C)).error.kind).toBe('server');
    for (const bad of [{ ...MINE, circle: {} }, { ...MINE, role: 'x' }, { ...MINE, expiresAt: 'x' }]) expect((await fake({ status: 200, body: { items: [bad], nextCursor: null } }).client.myRequests()).error.kind).toBe('server');
  });

  it('approving gives the new member; declining and revoking give nothing', async () => {
    expect((await fake({ status: 200, body: { member: MEMBER } }).client.approve(C, R)).value).toEqual(MEMBER);
    expect((await fake({ status: 200, body: {} }).client.approve(C, R)).error.kind).toBe('server');
    expect((await fake({ status: 204 }).client.decline(C, R)).ok).toBe(true);
    expect((await fake({ status: 204 }).client.revokeLink(C, J)).ok).toBe(true);
  });
});

describe('refusals', () => {
  const kind = async (a, run = (c) => c.myRequests()) => (await run(fake(a).client)).error;

  it('401 is signed out and 403 is in our words, never the service\'s', async () => {
    expect(await kind(err(401, { code: 'UNAUTHENTICATED', message: 'not signed in' }))).toMatchObject({ kind: 'signed-out' });
    const forbidden = await kind(err(403, { code: 'FORBIDDEN', message: 'SECRET service words' }));
    expect(forbidden.kind).toBe('forbidden');
    expect(forbidden.message).not.toContain('SECRET');
  });

  it('a 404 is classified by the service\'s fixed words, and any other 404 means the feature is off', async () => {
    expect(await kind(NOT('no such circle'), (c) => c.listLinks(C))).toMatchObject({ kind: 'not-found', what: 'circle', message: 'No such circle, or you are not in it.' });
    expect(await kind(NOT('no such join link'), (c) => c.join(TOKEN))).toMatchObject({ kind: 'not-found', what: 'link' });
    expect(await kind(NOT('no such join request'), (c) => c.approve(C, R))).toMatchObject({ kind: 'not-found', what: 'request' });
    for (const message of ['not found', 'no such invitation', '', 'toString', '__proto__']) expect(await kind(NOT(message), (c) => c.myRequests()), message).toEqual({ kind: 'unavailable', message: UNAVAILABLE });
    expect(await kind({ status: 404, raw: 'not json' })).toEqual({ kind: 'unavailable', message: UNAVAILABLE });
  });

  it('422 names a field only if the call has it, 409 uses cleaned words, 429 is a limit or a wait', async () => {
    expect(await kind(err(422, { code: 'INVALID_INPUT', message: 'label must be text', field: 'label' }), (c) => c.createLink(C, { label: 5 }))).toMatchObject({ kind: 'invalid', field: 'label' });
    expect(await kind(err(422, { code: 'INVALID_INPUT', message: 'bad', field: 'password' }), (c) => c.createLink(C, { label: 5 }))).not.toHaveProperty('field');
    expect(await kind(err(409, { code: 'CONFLICT', message: 'one\u0007 two' }))).toMatchObject({ kind: 'conflict', message: 'one two' });
    expect(await kind(err(429, { code: 'LIMIT_REACHED', message: 'a circle may have at most 4 people' }), (c) => c.approve(C, R))).toEqual({ kind: 'limit', message: 'a circle may have at most 4 people' });
    expect(await kind(err(429, { code: 'THROTTLED', message: 'x' }, { 'retry-after': '90' }))).toMatchObject({ kind: 'throttled', retryAfterSeconds: 90, message: 'Too many tries. Wait 90 seconds and try again.' });
    expect(await kind(err(429, { code: 'THROTTLED', message: 'x' }, { 'retry-after': '1' }))).toMatchObject({ message: 'Too many tries. Wait 1 second and try again.' });
    expect((await kind(err(429, { code: 'THROTTLED', message: 'x' }))).message).toBe('Too many tries. Wait a little and try again.');
    expect(await kind(err(500, { code: 'STORAGE_ERROR', message: 'SECRET' }))).toMatchObject({ kind: 'server' });
    expect((await kind(err(500, { message: 'SECRET' }))).message).not.toContain('SECRET');
  });

  it('a network failure is never thrown', async () => {
    const r = await fake(new Error('down')).client.myRequests();
    expect(r).toMatchObject({ ok: false, error: { kind: 'network' } });
  });
});
