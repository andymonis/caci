import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createController } from '../app/index.js';
import { createCaciController, defaultVerbs } from '../caci/index.js';
import { createGraph, write } from '../graph_store/index.js';
import { createDemoModelClient, createLlm } from '../llm/index.js';
import { createMemoryResolutionStore } from '../resolutions/index.js';
import { createScopeResolver } from '../scopes/index.js';
import { addMember, call, secrets, signIn, startCircleApp, type CircleApp } from './circle-routes.test-util.js';
import { createFactRoutes } from './fact-routes.js';
import { SHIPPED_CONTROLS } from '../llm/testing/shipped-controls.test-util.js';

// R-025 VR-FR-09: the verb routes translate, nothing more: strict input, the cookie only, the one status table, and private answers.

let app: CircleApp | undefined;
const all: string[] = [];
afterEach(async () => {
  await app?.api.close();
  app = undefined;
});
afterAll(() => {
  const text = all.join('\n');
  expect(all.length).toBeGreaterThan(30);
  for (const secret of secrets) expect(text.includes(secret), 'a password or session token appeared in a response').toBe(false);
  for (const leak of ['scrypt$', 'passwordHash', 'user-u', 'circle-c', 'sk-ant', 'Pay for this week']) expect(text, leak).not.toContain(leak);
});

const send = async (a: CircleApp, method: string, path: string, token?: string, body?: unknown) => {
  const r = await call(a.port, method, path, { token, body });
  all.push(r.text);
  return r;
};

async function started() {
  app = await startCircleApp({
    more: ({ users, store, graphs, now }) => {
      const llm = createLlm({ controls: SHIPPED_CONTROLS, client: createDemoModelClient() });
      const capture = createController({ adapter: graphs, llm, now: () => now.value });
      const scopes = createScopeResolver({ users, store });
      const caci = createCaciController({ users, capture, graphAdapter: graphs, scopes, clock: () => now.value, llm, verbs: defaultVerbs(), resolutions: createMemoryResolutionStore() });
      return createFactRoutes({ caci });
    },
  });
  const a = app;
  const t = { root: await signIn(a, 'root'), ann: await signIn(a, 'ann'), bob: await signIn(a, 'bob'), cat: await signIn(a, 'cat'), eve: await signIn(a, 'eve') };
  const circle = (await send(a, 'POST', '/api/circles', t.ann, { name: 'Yoga' })).json.circle.id as string;
  await addMember(a, circle, 'bob', 'member');
  await addMember(a, circle, 'cat', 'observer');
  for (const g of [`circle-${circle}`, `user-${a.ids.ann}`, `user-${a.ids.bob}`, `user-${a.ids.eve}`]) await createGraph(a.graphs, g);
  for (const id of ['yoga-1', 'yoga-2', 'yoga-3']) {
    await write(a.graphs, { version: 1, kind: 'mutation', graphId: `circle-${circle}`, ops: [{ op: 'upsertNode', partition: 'item', id, data: { title: 'Pay for this week yoga', summary: 'x' } }] } as never);
  }
  await write(a.graphs, { version: 1, kind: 'mutation', graphId: `user-${a.ids.bob}`, ops: [{ op: 'upsertNode', partition: 'item', id: 'mine', data: { title: 'Mine', summary: 'x' } }] } as never);
  return { a, t, circle };
}
const ref = (circle: string, id = 'yoga-1') => ({ scope: { kind: 'circle', circleId: circle }, id });

describe('POST /api/facts/resolve', () => {
  it('records the verb for the caller, and answers with the fact, verb, effect and result only', async () => {
    const { a, t, circle } = await started();
    const r = await send(a, 'POST', '/api/facts/resolve', t.bob, { ...ref(circle), verb: 'pay' });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ resolved: { fact: { scope: { kind: 'circle', circleId: circle }, id: 'yoga-1' }, verb: 'pay', effect: 'clear', result: 'hidden' } });
    const again = await send(a, 'POST', '/api/facts/resolve', t.bob, { ...ref(circle), verb: 'clear' });
    expect(again.status).toBe(200);
    const mine = await send(a, 'GET', '/api/facts/resolutions', t.bob);
    expect(mine.json.items).toHaveLength(1);
    expect(mine.json.items[0]).toMatchObject({ verb: 'clear' });
  });

  it('an observer may resolve for themselves; a member may not remove; the owner may', async () => {
    const { a, t, circle } = await started();
    expect((await send(a, 'POST', '/api/facts/resolve', t.cat, { ...ref(circle, 'yoga-2'), verb: 'clear' })).status).toBe(200);
    const refused = await send(a, 'POST', '/api/facts/resolve', t.bob, { ...ref(circle, 'yoga-2'), verb: 'remove' });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('FORBIDDEN');
    const cat = await send(a, 'POST', '/api/facts/resolve', t.cat, { ...ref(circle, 'yoga-2'), verb: 'remove' });
    expect(cat.status).toBe(403);
    const owner = await send(a, 'POST', '/api/facts/resolve', t.ann, { ...ref(circle, 'yoga-2'), verb: 'remove' });
    expect(owner.status, owner.text).toBe(200);
    expect(owner.json.resolved.result).toBe('deleted');
    expect((await send(a, 'POST', '/api/facts/resolve', t.ann, { ...ref(circle, 'yoga-2'), verb: 'remove' })).status).toBe(404);
  });

  it('with no scope the fact is in your own brain, where clear deletes it', async () => {
    const { a, t } = await started();
    const r = await send(a, 'POST', '/api/facts/resolve', t.bob, { id: 'mine', verb: 'clear' });
    expect(r.status, r.text).toBe(200);
    expect(r.json.resolved).toMatchObject({ fact: { scope: { kind: 'personal' }, id: 'mine' }, result: 'deleted' });
    expect((await send(a, 'POST', '/api/facts/resolve', t.bob, { id: 'mine', verb: 'clear' })).status).toBe(404);
  });

  it('a stranger, a non-member and a made-up circle get byte-identical 404s (VR-AC-04)', async () => {
    const { a, t, circle } = await started();
    const replies = [
      await send(a, 'POST', '/api/facts/resolve', t.eve, { ...ref(circle), verb: 'pay' }),
      await send(a, 'POST', '/api/facts/resolve', t.root, { ...ref(circle), verb: 'pay' }),
      await send(a, 'POST', '/api/facts/resolve', t.bob, { ...ref('c9999999999999999'), verb: 'pay' }),
    ];
    for (const r of replies) expect(r.status).toBe(404);
    expect(new Set(replies.map((r) => r.text)).size).toBe(1);
    const unresolve = [
      await send(a, 'POST', '/api/facts/unresolve', t.eve, ref(circle)),
      await send(a, 'POST', '/api/facts/unresolve', t.bob, ref('c9999999999999999')),
    ];
    for (const r of unresolve) expect(r.status).toBe(404);
    expect(new Set(unresolve.map((r) => r.text)).size).toBe(1);
  });

  it('refuses unknown fields, query strings, a bad verb, a bad scope, a missing id and a non-object, by name', async () => {
    const { a, t, circle } = await started();
    const expectField = async (body: unknown, field: string, path = '/api/facts/resolve') => {
      const r = await send(a, 'POST', path, t.bob, body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.json.error.field, JSON.stringify(body)).toBe(field);
    };
    await expectField({ ...ref(circle), verb: 'pay', extra: 1 }, 'extra');
    await expectField({ ...ref(circle), verb: 'pay', userId: 'u0000000000000002' }, 'userId');
    await expectField({ ...ref(circle), verb: 'dance' }, 'verb');
    await expectField({ ...ref(circle) }, 'verb');
    await expectField({ scope: ref(circle).scope, verb: 'pay' }, 'id');
    await expectField({ ...ref(circle), id: 5, verb: 'pay' }, 'id');
    await expectField({ scope: { kind: 'group' }, id: 'x', verb: 'pay' }, 'scope');
    await expectField({ ...ref(circle), verb: 'pay' }, 'verb', '/api/facts/unresolve');
    const q = await send(a, 'POST', '/api/facts/resolve?scope=personal', t.bob, { ...ref(circle), verb: 'pay' });
    expect(q.status).toBe(422);
    expect(q.json.error.field).toBe('scope');
  });

  it('needs the session cookie: a missing or stale one is 401, and the stale cookie is cleared', async () => {
    const { a, circle } = await started();
    const none = await send(a, 'POST', '/api/facts/resolve', undefined, { ...ref(circle), verb: 'pay' });
    expect(none.status).toBe(401);
    const stale = await send(a, 'POST', '/api/facts/resolve', 'not-a-real-token', { ...ref(circle), verb: 'pay' });
    expect(stale.status).toBe(401);
    expect(String(stale.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await send(a, 'GET', '/api/facts/resolutions', undefined)).status).toBe(401);
    expect((await send(a, 'POST', '/api/facts/unresolve', undefined, ref(circle))).status).toBe(401);
  });

  it('the wrong method is 405', async () => {
    const { a, t } = await started();
    for (const [method, path] of [['GET', '/api/facts/resolve'], ['GET', '/api/facts/unresolve'], ['POST', '/api/facts/resolutions'], ['DELETE', '/api/facts/resolve']] as const) {
      expect((await send(a, method, path, t.bob, method === 'POST' ? {} : undefined)).status, `${method} ${path}`).toBe(405);
    }
  });
});

describe('POST /api/facts/unresolve', () => {
  it('takes back your own, and answers the same when there was none', async () => {
    const { a, t, circle } = await started();
    await send(a, 'POST', '/api/facts/resolve', t.bob, { ...ref(circle), verb: 'pay' });
    await send(a, 'POST', '/api/facts/resolve', t.cat, { ...ref(circle), verb: 'clear' });
    const first = await send(a, 'POST', '/api/facts/unresolve', t.bob, ref(circle));
    const second = await send(a, 'POST', '/api/facts/unresolve', t.bob, ref(circle));
    expect(first.status).toBe(200);
    expect(first.text).toBe(second.text);
    expect(first.json).toEqual({ unresolved: { fact: { scope: { kind: 'circle', circleId: circle }, id: 'yoga-1' } } });
    expect((await send(a, 'GET', '/api/facts/resolutions', t.bob)).json.items).toEqual([]);
    expect((await send(a, 'GET', '/api/facts/resolutions', t.cat)).json.items).toHaveLength(1);
  });
});

describe('GET /api/facts/resolutions', () => {
  it('lists only your own, in pages that continue from after_scope and after_id, and no words', async () => {
    const { a, t, circle } = await started();
    for (const id of ['yoga-3', 'yoga-1', 'yoga-2']) await send(a, 'POST', '/api/facts/resolve', t.bob, { ...ref(circle, id), verb: 'pay' });
    await send(a, 'POST', '/api/facts/resolve', t.cat, { ...ref(circle, 'yoga-1'), verb: 'clear' });
    const first = await send(a, 'GET', '/api/facts/resolutions?limit=2', t.bob);
    expect(first.status).toBe(200);
    expect(first.json.items.map((i: { fact: { id: string } }) => i.fact.id)).toEqual(['yoga-1', 'yoga-2']);
    expect(first.json.next).toEqual({ scope: { kind: 'circle', circleId: circle }, id: 'yoga-2' });
    const second = await send(a, 'GET', `/api/facts/resolutions?limit=2&after_scope=circle:${circle}&after_id=yoga-2`, t.bob);
    expect(second.json.items.map((i: { fact: { id: string } }) => i.fact.id)).toEqual(['yoga-3']);
    expect(second.json.next).toBeNull();
    expect(Object.keys(first.json.items[0]).sort()).toEqual(['at', 'fact', 'verb']);
    expect(first.text).not.toContain('Pay for');
    expect((await send(a, 'GET', '/api/facts/resolutions', t.eve)).json).toEqual({ items: [], next: null });
  });

  it('refuses a bad limit, one cursor part alone, a bad scope and unknown parameters, by name', async () => {
    const { a, t } = await started();
    const field = async (query: string): Promise<string | undefined> => {
      const r = await send(a, 'GET', `/api/facts/resolutions${query}`, t.bob);
      expect(r.status, query).toBe(422);
      return r.json.error.field;
    };
    expect(await field('?limit=0')).toBe('limit');
    expect(await field('?limit=101')).toBe('limit');
    expect(await field('?limit=abc')).toBe('limit');
    expect(await field('?limit=')).toBe('limit');
    expect(await field('?after_scope=personal')).toBe('after_id');
    expect(await field('?after_id=x')).toBe('after_scope');
    expect(await field('?after_scope=group&after_id=x')).toBe('after_scope');
    expect(await field('?user=u0000000000000002')).toBe('user');
    expect(await field('?cursor=abc')).toBe('cursor');
  });
});
