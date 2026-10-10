import { describe, expect, it } from 'vitest';
import { createSharingClient } from './sharing-client.js';

const C = 'c0123456789abcdef';
const U = 'u0123456789abcdef';
const U2 = 'uabcdefghij012345';
const GRANT = { userId: U, username: 'bob', displayName: 'Bob B', categories: [{ id: 'health', name: 'Health' }, { id: 'plain' }], updatedAt: 5 };
const BRAIN = { userId: U, username: 'ann', displayName: 'Ann A', categoryCount: 2 };
const CATEGORY = { id: 'health', name: 'Health', itemCount: 3 };
const ITEM = { id: 'i1', data: { title: 'T' } };

function fake(answer) {
  const calls = [];
  const fetchFn = async (path, init) => {
    calls.push({ path, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body), init });
    const a = typeof answer === 'function' ? answer(path, init) : answer;
    if (a instanceof Error) throw a;
    return { status: a.status, headers: { get: (n) => (a.headers && a.headers[n]) ?? null }, text: async () => (a.raw !== undefined ? a.raw : a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { calls, client: createSharingClient({ fetchFn }) };
}
const err = (status, error, headers) => ({ status, body: { error }, ...(headers ? { headers } : {}) });

describe('what I share', () => {
  it('lists grants by GET with the circle id in the path', async () => {
    const { calls, client } = fake({ status: 200, body: { items: [GRANT], nextCursor: null } });
    const r = await client.listGrants(C);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: `/api/circles/${C}/grants`, method: 'GET' });
    expect(r).toEqual({ ok: true, value: { items: [{ userId: U, username: 'bob', displayName: 'Bob B', categories: [{ id: 'health', name: 'Health' }, { id: 'plain' }], updatedAt: 5 }], nextCursor: null } });
    expect(Object.isFrozen(r.value) && Object.isFrozen(r.value.items[0]) && Object.isFrozen(r.value.items[0].categories[0])).toBe(true);
  });

  it('sets a grant by PUT sending only the categories, and an empty set is 204', async () => {
    const { calls, client } = fake({ status: 200, body: { grant: GRANT } });
    const r = await client.setGrant(C, U, ['health', 'plain']);
    expect(calls[0]).toMatchObject({ path: `/api/circles/${C}/grants/${U}`, method: 'PUT', body: { categories: ['health', 'plain'] } });
    expect(Object.keys(calls[0].body)).toEqual(['categories']);
    expect(r.ok && r.value.grant.userId).toBe(U);
    const none = fake({ status: 204 });
    expect(await none.client.setGrant(C, U, [])).toEqual({ ok: true, value: { grant: null } });
    expect(none.calls[0].body).toEqual({ categories: [] });
  });

  it('refuses a bad category list before anything is sent', async () => {
    const { calls, client } = fake({ status: 204 });
    const many = Array.from({ length: 201 }, (_, i) => `c${i}`);
    for (const bad of [undefined, null, 'health', {}, [5], [''], ['x'.repeat(257)], ['\ud800'], many]) {
      const r = await client.setGrant(C, U, bad);
      expect(r, String(bad)).toMatchObject({ ok: false, error: { kind: 'invalid', field: 'categories' } });
    }
    expect(calls).toHaveLength(0);
    expect((await client.setGrant(C, U, many.slice(0, 200))).ok).toBe(true);
  });

  it('accepts 256 characters and any text as a category id', async () => {
    const { calls, client } = fake({ status: 204 });
    expect((await client.setGrant(C, U, ['x'.repeat(256), 'a b/c?d=e&f#g 😀', '<b>&"'])).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('withdraws by DELETE with no body', async () => {
    const { calls, client } = fake({ status: 204 });
    expect(await client.withdrawGrant(C, U)).toEqual({ ok: true, value: true });
    expect(calls[0]).toMatchObject({ path: `/api/circles/${C}/grants/${U}`, method: 'DELETE', body: undefined });
  });

  it('a 200 for a set that is not shaped like a grant is a server problem', async () => {
    for (const body of [{}, { grant: {} }, { grant: { ...GRANT, userId: 'nope' } }, { grant: { ...GRANT, categories: [{ id: '' }] } }, { grant: { ...GRANT, updatedAt: -1 } }, { grant: { ...GRANT, username: 5 } }]) {
      const { client } = fake({ status: 200, body });
      expect(await client.setGrant(C, U, ['x']), JSON.stringify(body)).toMatchObject({ ok: false, error: { kind: 'server' } });
    }
  });
});

describe('what is shared with me', () => {
  it('lists who has shared, with counts', async () => {
    const { calls, client } = fake({ status: 200, body: { items: [{ ...BRAIN, email: 'x@y.z', graphId: 'user-u1' }], nextCursor: null } });
    const r = await client.sharedWithMe(C);
    expect(calls[0]).toMatchObject({ path: `/api/circles/${C}/shared`, method: 'GET' });
    expect(r).toEqual({ ok: true, value: { items: [BRAIN], nextCursor: null } });
    expect(JSON.stringify(r)).not.toMatch(/email|graphId/);
  });

  it('reads categories, a category\'s items and one item with the ids in the right places', async () => {
    const cats = fake({ status: 200, body: { items: [CATEGORY], nextCursor: null } });
    expect((await cats.client.sharedCategories(C, U)).value.items[0]).toEqual(CATEGORY);
    expect(cats.calls[0].path).toBe(`/api/circles/${C}/shared/${U}/categories`);

    const items = fake({ status: 200, body: { category: { id: 'health', name: 'Health' }, items: [ITEM], nextCursor: null } });
    const r = await items.client.sharedCategoryItems(C, U, 'a b/c?d=e&f#g 😀');
    expect(items.calls[0].path).toBe(`/api/circles/${C}/shared/${U}/category?id=${encodeURIComponent('a b/c?d=e&f#g 😀')}`);
    expect(r.value.items[0].id).toBe('i1');

    const one = fake({ status: 200, body: { item: ITEM, categories: [{ id: 'health', name: 'Health', weight: 0.9 }] } });
    const d = await one.client.sharedItem(C, U, 'i1');
    expect(one.calls[0].path).toBe(`/api/circles/${C}/shared/${U}/item?id=i1`);
    expect(d.value.categories).toEqual([{ id: 'health', name: 'Health', weight: 0.9 }]);
  });

  it('builds paging into the query string and refuses bad paging before sending', async () => {
    const { calls, client } = fake({ status: 200, body: { items: [], nextCursor: null } });
    await client.sharedCategories(C, U, { limit: 5, cursor: 'sAbC-_' });
    expect(calls[0].path).toBe(`/api/circles/${C}/shared/${U}/categories?limit=5&cursor=sAbC-_`);
    await client.sharedCategoryItems(C, U, 'x', { limit: 2 });
    expect(calls[1].path).toBe(`/api/circles/${C}/shared/${U}/category?id=x&limit=2`);
    for (const page of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: 'a b' }, { cursor: 5 }, 'x']) {
      expect(await client.sharedWithMe(C, page), JSON.stringify(page)).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    }
    expect(calls).toHaveLength(2);
  });

  it('a page is refused whole if any item is wrongly shaped, or the cursor is', async () => {
    for (const body of [{ items: [{ ...BRAIN, categoryCount: -1 }], nextCursor: null }, { items: [{ ...BRAIN, userId: 'x' }], nextCursor: null }, { items: [BRAIN], nextCursor: '' }, { items: [BRAIN], nextCursor: 5 }, { items: 'x', nextCursor: null }, []]) {
      const { client } = fake({ status: 200, body });
      expect(await client.sharedWithMe(C), JSON.stringify(body)).toMatchObject({ ok: false, error: { kind: 'server' } });
    }
  });
});

describe('ids', () => {
  const BAD = ['', 'c', 'C0123456789abcdef', 'c0123456789abcde', 'c0123456789abcdef0', '../x', 'c0123456789abcd%2f', 'c0123456789abcd?x=1', U, undefined, null, 5];
  it('a bad circle id is "no such circle" and nothing is sent, for every call', async () => {
    const { calls, client } = fake({ status: 200, body: {} });
    for (const bad of BAD) {
      const results = [await client.listGrants(bad), await client.setGrant(bad, U, []), await client.withdrawGrant(bad, U), await client.sharedWithMe(bad), await client.sharedCategories(bad, U), await client.sharedCategoryItems(bad, U, 'x'), await client.sharedItem(bad, U, 'x')];
      for (const r of results) expect(r, String(bad)).toMatchObject({ ok: false, error: { kind: 'not-found', what: 'circle', message: 'No such circle, or you are not in it.' } });
    }
    expect(calls).toHaveLength(0);
  });

  it('a bad person id is not sent: "no such member" for grants, "nothing shared" for reads', async () => {
    const { calls, client } = fake({ status: 200, body: {} });
    for (const bad of ['', 'u', 'U0123456789abcdef', C, '..', 'u0123456789abcd/f', undefined, 7]) {
      for (const r of [await client.setGrant(C, bad, []), await client.withdrawGrant(C, bad)]) expect(r, String(bad)).toMatchObject({ ok: false, error: { kind: 'not-found', what: 'member' } });
      for (const r of [await client.sharedCategories(C, bad), await client.sharedCategoryItems(C, bad, 'x'), await client.sharedItem(C, bad, 'x')]) expect(r, String(bad)).toMatchObject({ ok: false, error: { kind: 'not-found', what: 'brain', message: 'Nothing is shared with you by that person.' } });
    }
    expect(calls).toHaveLength(0);
  });

  it('a bad category or item id is not sent', async () => {
    const { calls, client } = fake({ status: 200, body: {} });
    for (const bad of ['', 'x'.repeat(257), '\udc00', undefined, 5, null]) {
      expect(await client.sharedCategoryItems(C, U, bad), String(bad)).toMatchObject({ ok: false, error: { kind: 'not-found', what: 'category' } });
      expect(await client.sharedItem(C, U, bad), String(bad)).toMatchObject({ ok: false, error: { kind: 'not-found', what: 'item' } });
    }
    expect(calls).toHaveLength(0);
    expect((await client.sharedItem(C, U, 'x'.repeat(256))).ok).toBe(false); // sent, and the stand-in's answer is not an item
    expect(calls).toHaveLength(1);
  });

  it('every request is on the same address by path, with the cookie left to the browser', async () => {
    const { calls, client } = fake({ status: 200, body: { items: [], nextCursor: null } });
    await client.listGrants(C);
    await client.sharedCategories(C, U2);
    for (const c of calls) {
      expect(c.path.startsWith('/api/')).toBe(true);
      expect(c.init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      expect(JSON.stringify(c.init.headers)).not.toMatch(/authorization|cookie/i);
    }
  });
});

describe('refusals', () => {
  const ask = (answer, run = (c) => c.sharedCategories(C, U)) => run(fake(answer).client);
  it('401 is signed out', async () => {
    expect(await ask(err(401, { code: 'UNAUTHENTICATED', message: 'not signed in' }))).toMatchObject({ error: { kind: 'signed-out', message: 'Your session has ended. Sign in again.' } });
  });
  it('403 uses our words, not the service\'s', async () => {
    const r = await ask(err(403, { code: 'FORBIDDEN', message: 'SERVICE WORDS' }));
    expect(r.error).toEqual({ kind: 'forbidden', message: 'The service refused that request.' });
  });
  it('404 is told apart by the service\'s fixed words, and everything not shared reads the same', async () => {
    expect((await ask(err(404, { code: 'NOT_FOUND', message: 'no such circle' }))).error).toMatchObject({ kind: 'not-found', what: 'circle' });
    expect((await ask(err(404, { code: 'NOT_FOUND', message: 'no such shared brain' }))).error).toMatchObject({ kind: 'not-found', what: 'brain' });
    const category = await ask(err(404, { code: 'NOT_FOUND', message: 'no such category' }), (c) => c.sharedCategoryItems(C, U, 'x'));
    const item = await ask(err(404, { code: 'NOT_FOUND', message: 'no such item' }), (c) => c.sharedItem(C, U, 'x'));
    expect(category.error).toMatchObject({ kind: 'not-found', what: 'category' });
    expect(item.error).toMatchObject({ kind: 'not-found', what: 'item' });
    expect(category.error.message).toBe(item.error.message);
    const member = await ask(err(404, { code: 'NOT_FOUND', message: 'no such member' }), (c) => c.setGrant(C, U, ['x']));
    expect(member.error).toMatchObject({ kind: 'not-found', what: 'member', message: 'That person is no longer in this circle.' });
    // a 404 with an unknown message still reads as the call's own subject, in our words
    expect((await ask(err(404, { message: 'SECRET' }))).error).toEqual({ kind: 'not-found', what: 'brain', message: 'Nothing is shared with you by that person.' });
    expect((await ask({ status: 404, raw: 'not json' })).error.kind).toBe('not-found');
  });
  it('422 names a field only if the call has it', async () => {
    const set = (field) => ask(err(422, { code: 'INVALID_INPUT', message: 'every category must be one of your own', field }), (c) => c.setGrant(C, U, ['x']));
    expect((await set('categories')).error).toMatchObject({ kind: 'invalid', field: 'categories', message: 'every category must be one of your own' });
    expect((await set('granteeId')).error.field).toBe('granteeId');
    expect((await set('username')).error.field).toBeUndefined();
    const read = await ask(err(422, { code: 'INVALID_INPUT', message: 'limit must be 1 to 100', field: 'limit' }));
    expect(read.error).toMatchObject({ kind: 'invalid', field: 'limit' });
    expect((await ask(err(422, { code: 'INVALID_INPUT', message: 'x', field: 'categories' }))).error.field).toBeUndefined();
  });
  it('429 is a limit in the service\'s words or a wait', async () => {
    expect((await ask(err(429, { code: 'LIMIT_REACHED', message: 'at most 200 categories' }))).error).toEqual({ kind: 'limit', message: 'at most 200 categories' });
    const wait = (await ask(err(429, { code: 'THROTTLED', message: 'x' }, { 'retry-after': '7' }))).error;
    expect(wait).toMatchObject({ kind: 'throttled', retryAfterSeconds: 7 });
    expect(wait.message).toContain('7 seconds');
    expect((await ask(err(429, { code: 'THROTTLED', message: 'x' }))).error.retryAfterSeconds).toBeUndefined();
  });
  it('everything else is a fixed server message that carries nothing from inside', async () => {
    for (const status of [500, 502, 503, 400, 418]) {
      const r = await ask(err(status, { code: 'STORAGE_ERROR', message: 'disk exploded at /secret/path' }));
      expect(r.error).toEqual({ kind: 'server', message: 'Something went wrong on the service. Try again in a moment.' });
    }
    expect((await ask({ status: 200, raw: '<html>' })).error.kind).toBe('server');
  });
  it('a network failure never throws', async () => {
    expect((await ask(new Error('boom'))).error.kind).toBe('network');
    expect((await ask({ status: 200, body: { items: [], nextCursor: null } }, (c) => c.listGrants(C))).ok).toBe(true);
  });
  it('the service\'s words are cleaned and cut', async () => {
    const r = await ask(err(429, { code: 'LIMIT_REACHED', message: `a${String.fromCharCode(0)}b${'x'.repeat(400)}` }));
    expect(r.error.message.includes(String.fromCharCode(0))).toBe(false);
    expect(r.error.message.length).toBeLessThanOrEqual(300);
  });
  it('construction needs a fetch function', () => {
    expect(() => createSharingClient({})).toThrow(TypeError);
  });
});
