import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createSharing } from '../sharing/index.js';
import { write } from '../graph_store/index.js';
import { addMember, call, seen, secrets, signIn, startCircleApp, type CircleApp } from './circle-routes.test-util.js';
import { createSharingRoutes } from './sharing-routes.js';

let app: CircleApp | undefined;
afterEach(async () => {
  await app?.api.close();
  app = undefined;
});
afterAll(() => {
  const all = seen.join('\n');
  expect(seen.length).toBeGreaterThan(30);
  for (const secret of secrets) expect(all.includes(secret), 'a password or a session token appeared in a response').toBe(false);
  for (const leak of ['scrypt$', 'passwordHash', 'example.com', 'user-u', 'PRIVATE-NAME']) expect(all, leak).not.toContain(leak);
});

/** ann owns a circle with bob (member) and cat (observer); dan is outside. ann has categories health, travel and a private one. */
async function started() {
  app = await startCircleApp({
    more: ({ users, directory, store, graphs }) => createSharingRoutes({ sharing: createSharing({ users, directory, store, graphAdapter: graphs }) }),
  });
  const a = app;
  const tokens = { ann: await signIn(a, 'ann'), bob: await signIn(a, 'bob'), cat: await signIn(a, 'cat'), dan: await signIn(a, 'dan') };
  const circle = (await call(a.port, 'POST', '/api/circles', { token: tokens.ann, body: { name: 'Club' } })).json.circle.id as string;
  await addMember(a, circle, 'bob', 'member');
  await addMember(a, circle, 'cat', 'observer');
  const r = await write(a.graphs, {
    version: 1,
    kind: 'mutation',
    graphId: `user-${a.ids.ann}`,
    ops: [
      { op: 'upsertNode', partition: 'category', id: 'health', data: { name: 'Health' } },
      { op: 'upsertNode', partition: 'category', id: 'travel', data: { name: 'Travel' } },
      { op: 'upsertNode', partition: 'category', id: 'private', data: { name: 'PRIVATE-NAME' } },
      { op: 'upsertNode', partition: 'item', id: 'i1', data: { title: 'T' } },
      { op: 'link', item: 'i1', category: 'health' },
    ],
  } as never);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return { a, ...tokens, circle };
}
const NO_CIRCLE = { code: 'NOT_FOUND', message: 'no such circle' };

describe('what I share', () => {
  it('PUT sets a grant (200 with it), GET lists it, a new PUT replaces, an empty one is 204 and withdraws', async () => {
    const { a, ann, circle } = await started();
    const path = `/api/circles/${circle}/grants/${a.ids.bob}`;
    const set = await call(a.port, 'PUT', path, { token: ann, body: { categories: ['travel', 'health'] } });
    expect(set.status).toBe(200);
    expect(Object.keys(set.json)).toEqual(['grant']);
    expect(set.json.grant).toEqual({ userId: a.ids.bob, username: 'bob', displayName: 'Display bob', categories: [{ id: 'health', name: 'Health' }, { id: 'travel', name: 'Travel' }], updatedAt: expect.any(Number) });
    const listed = await call(a.port, 'GET', `/api/circles/${circle}/grants`, { token: ann });
    expect(listed.status).toBe(200);
    expect(listed.json).toEqual({ items: [set.json.grant], nextCursor: null });
    const narrowed = await call(a.port, 'PUT', path, { token: ann, body: { categories: ['travel'] } });
    expect(narrowed.json.grant.categories).toEqual([{ id: 'travel', name: 'Travel' }]);
    const emptied = await call(a.port, 'PUT', path, { token: ann, body: { categories: [] } });
    expect(emptied.status).toBe(204);
    expect(emptied.text).toBe('');
    expect((await call(a.port, 'GET', `/api/circles/${circle}/grants`, { token: ann })).json.items).toEqual([]);
  });

  it('DELETE withdraws (204), also when there was nothing to withdraw', async () => {
    const { a, ann, circle } = await started();
    const path = `/api/circles/${circle}/grants/${a.ids.bob}`;
    await call(a.port, 'PUT', path, { token: ann, body: { categories: ['health'] } });
    expect((await call(a.port, 'DELETE', path, { token: ann })).status).toBe(204);
    expect((await call(a.port, 'GET', `/api/circles/${circle}/grants`, { token: ann })).json.items).toEqual([]);
    expect((await call(a.port, 'DELETE', path, { token: ann })).status).toBe(204);
  });

  it('is one direction: the receiver has no grants of their own', async () => {
    const { a, ann, bob, circle } = await started();
    await call(a.port, 'PUT', `/api/circles/${circle}/grants/${a.ids.bob}`, { token: ann, body: { categories: ['health'] } });
    expect((await call(a.port, 'GET', `/api/circles/${circle}/grants`, { token: bob })).json.items).toEqual([]);
  });

  it('the body takes categories and nothing else: owner, graph and user ids are refused by name', async () => {
    const { a, ann, circle } = await started();
    const path = `/api/circles/${circle}/grants/${a.ids.bob}`;
    for (const stray of ['ownerId', 'userId', 'graphId', 'granteeId', 'role', 'x']) {
      const r = await call(a.port, 'PUT', path, { token: ann, body: { categories: ['health'], [stray]: 'u0000000000000001' } });
      expect(r.status, stray).toBe(422);
      expect(r.json.error).toMatchObject({ code: 'INVALID_INPUT', field: stray });
    }
    expect((await call(a.port, 'GET', `/api/circles/${circle}/grants`, { token: ann })).json.items).toEqual([]);
    for (const body of [undefined, {}, { categories: 'health' }, { categories: [5] }, { categories: [''] }]) {
      const r = await call(a.port, 'PUT', path, { token: ann, ...(body === undefined ? {} : { body }) });
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.json.error.field).toBe('categories');
    }
  });

  it('refuses an unknown query parameter, and a body on DELETE, by name', async () => {
    const { a, ann, circle } = await started();
    const r = await call(a.port, 'GET', `/api/circles/${circle}/grants?ownerId=${a.ids.ann}`, { token: ann });
    expect(r.status).toBe(422);
    expect(r.json.error).toMatchObject({ code: 'INVALID_INPUT', field: 'ownerId' });
    const d = await call(a.port, 'DELETE', `/api/circles/${circle}/grants/${a.ids.bob}`, { token: ann, body: { categories: [] } });
    expect(d.status).toBe(422);
    expect(d.json.error.field).toBe('categories');
    const bad = await call(a.port, 'GET', `/api/circles/${circle}/grants?limit=abc`, { token: ann });
    expect(bad.json.error).toMatchObject({ field: 'limit' });
  });

  it('refuses categories that are not the caller\'s own, without repeating them', async () => {
    const { a, ann, bob, circle } = await started();
    await write(a.graphs, { version: 1, kind: 'mutation', graphId: `user-${a.ids.bob}`, ops: [{ op: 'upsertNode', partition: 'category', id: 'bobs', data: { name: 'BOBS' } }] } as never);
    for (const id of ['bobs', 'i1', 'nope']) {
      const r = await call(a.port, 'PUT', `/api/circles/${circle}/grants/${a.ids.bob}`, { token: ann, body: { categories: [id] } });
      expect(r.status).toBe(422);
      expect(r.text).not.toContain(`"${id}"`);
    }
    expect((await call(a.port, 'PUT', `/api/circles/${circle}/grants/${a.ids.ann}`, { token: bob, body: { categories: ['bobs'] } })).status).toBe(200);
  });

  it('refuses sharing with yourself (422) or with someone who is not in the circle (404)', async () => {
    const { a, ann, circle } = await started();
    const self = await call(a.port, 'PUT', `/api/circles/${circle}/grants/${a.ids.ann}`, { token: ann, body: { categories: ['health'] } });
    expect(self.status).toBe(422);
    expect(self.json.error.field).toBe('granteeId');
    for (const who of [a.ids.dan, 'u0000000000000000']) {
      const r = await call(a.port, 'PUT', `/api/circles/${circle}/grants/${who}`, { token: ann, body: { categories: ['health'] } });
      expect(r.status).toBe(404);
      expect(r.json.error).toEqual({ code: 'NOT_FOUND', message: 'no such member' });
    }
  });
});

describe('who may ask', () => {
  it('a stranger gets the answer for a made-up circle from all three routes', async () => {
    const { a, dan, circle } = await started();
    const made = 'c0000000000000000';
    for (const [method, tail, body] of [['GET', '/grants', undefined], ['PUT', `/grants/${a.ids.bob}`, { categories: ['health'] }], ['DELETE', `/grants/${a.ids.bob}`, undefined]] as const) {
      const real = await call(a.port, method, `/api/circles/${circle}${tail}`, { token: dan, ...(body === undefined ? {} : { body }) });
      const fake = await call(a.port, method, `/api/circles/${made}${tail}`, { token: dan, ...(body === undefined ? {} : { body }) });
      expect(real.status, method).toBe(404);
      expect(real.json.error).toEqual(NO_CIRCLE);
      expect(fake.text).toBe(real.text);
    }
  });

  it('needs the session cookie and nothing else: no cookie is 401 without a cookie set, a stale cookie is cleared, other credentials are ignored', async () => {
    const { a, ann, circle } = await started();
    const none = await call(a.port, 'GET', `/api/circles/${circle}/grants`);
    expect(none.status).toBe(401);
    expect(none.cookie).toBeUndefined();
    const stale = await call(a.port, 'GET', `/api/circles/${circle}/grants`, { token: 'not-a-session' });
    expect(stale.status).toBe(401);
    expect(stale.cookie).toMatch(/Max-Age=0/);
    expect((await call(a.port, 'GET', `/api/circles/${circle}/grants`, { headers: { authorization: `Bearer ${ann}` } })).status).toBe(401);
  });

  it('a cross-origin write is refused before anything changes, and a form post is 415', async () => {
    const { a, ann, circle } = await started();
    const path = `/api/circles/${circle}/grants/${a.ids.bob}`;
    const cross = await call(a.port, 'PUT', path, { token: ann, body: { categories: ['health'] }, headers: { origin: 'http://evil.example' } });
    expect(cross.status).toBe(403);
    const form = await call(a.port, 'PUT', path, { token: ann, body: 'categories=health', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(form.status).toBe(415);
    expect((await call(a.port, 'GET', `/api/circles/${circle}/grants`, { token: ann })).json.items).toEqual([]);
  });

  it('odd ids and wrong methods never reach a handler', async () => {
    const { a, ann, circle } = await started();
    for (const p of [`/api/circles/${circle}/grants/..`, `/api/circles/${circle}/grants/%2e%2e`, `/api/circles/${circle}/grants/${'u'.repeat(200)}/y`, `/api/circles/${circle}/grants/`, '/api/circles//grants']) {
      const r = await call(a.port, 'PUT', p, { token: ann, body: { categories: [] } });
      expect([400, 404], p).toContain(r.status);
    }
    const post = await call(a.port, 'POST', `/api/circles/${circle}/grants/${a.ids.bob}`, { token: ann, body: {} });
    expect(post.status).toBe(405);
    expect(String(post.headers.allow)).toContain('PUT');
    expect((await call(a.port, 'PATCH', `/api/circles/${circle}/grants`, { token: ann, body: {} })).status).toBe(405);
  });

  it('pages the list with limit and cursor', async () => {
    const { a, ann, circle } = await started();
    for (const who of ['bob', 'cat']) await call(a.port, 'PUT', `/api/circles/${circle}/grants/${a.ids[who]}`, { token: ann, body: { categories: ['health'] } });
    const one = await call(a.port, 'GET', `/api/circles/${circle}/grants?limit=1`, { token: ann });
    expect(one.json.items).toHaveLength(1);
    const two = await call(a.port, 'GET', `/api/circles/${circle}/grants?limit=1&cursor=${encodeURIComponent(one.json.nextCursor)}`, { token: ann });
    expect(two.json.items).toHaveLength(1);
    expect(two.json.items[0].userId).not.toBe(one.json.items[0].userId);
  });

  it('never reveals a private category', async () => {
    const { a, ann, circle } = await started();
    const r = await call(a.port, 'PUT', `/api/circles/${circle}/grants/${a.ids.bob}`, { token: ann, body: { categories: ['health'] } });
    expect(r.text).not.toContain('PRIVATE-NAME');
  });
});
