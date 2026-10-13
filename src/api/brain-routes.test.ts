import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createController } from '../app/index.js';
import { createCaciController } from '../caci/index.js';
import { createGraph, write } from '../graph_store/index.js';
import { createDemoModelClient, createLlm } from '../llm/index.js';
import { createScopeResolver } from '../scopes/index.js';
import { addMember, call, secrets, signIn, startCircleApp, type CircleApp } from './circle-routes.test-util.js';
import { createBrainRoutes } from './brain-routes.js';
import { createCaptureRoutes } from './capture-routes.js';
import { createReadRoutes } from './read-routes.js';
import { SHIPPED_CONTROLS } from '../llm/testing/shipped-controls.test-util.js';

let app: CircleApp | undefined;
const all: string[] = [];
afterEach(async () => {
  await app?.api.close();
  app = undefined;
});
afterAll(() => {
  const text = all.join('\n');
  expect(all.length).toBeGreaterThan(80);
  for (const secret of secrets) expect(text.includes(secret), 'a password or session token appeared in a response').toBe(false);
  for (const leak of ['scrypt$', 'passwordHash', 'user-u', 'circle-c', 'SECRET-OF-C4']) expect(text, leak).not.toContain(leak);
});

const get = async (a: CircleApp, path: string, token?: string) => {
  const r = await call(a.port, 'GET', path, { token });
  all.push(r.text);
  return r;
};
const post = async (a: CircleApp, path: string, body: unknown, token?: string) => {
  const r = await call(a.port, 'POST', path, { token, body });
  all.push(r.text);
  return r;
};
const must = (r: { ok: boolean; error?: unknown }) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
};

async function fill(a: CircleApp, graphId: string, ids: string[], label: string) {
  const ops: unknown[] = [];
  for (const id of ids) ops.push({ op: 'upsertNode', partition: 'category', id, data: { name: `${id} of ${label}` } }, { op: 'upsertNode', partition: 'item', id: `item-${id}`, data: { title: `${label} ${id}` } }, { op: 'link', item: `item-${id}`, category: id });
  must(await write(a.graphs, { version: 1, kind: 'mutation', graphId, ops } as never));
}

/** root (the administrator), ann (owner of circle 1, member of 2, observer of 3), bob, cat (in none), dan. */
async function started() {
  app = await startCircleApp({
    more: ({ users, store, graphs, now }) => {
      const capture = createController({ adapter: graphs, llm: createLlm({ controls: SHIPPED_CONTROLS, client: createDemoModelClient() }), now: () => now.value });
      const scopes = createScopeResolver({ users, store });
      const caci = createCaciController({ users, capture, graphAdapter: graphs, scopes, clock: () => now.value });
      return [...createCaptureRoutes({ caci }), ...createReadRoutes({ caci }), ...createBrainRoutes({ caci })];
    },
  });
  const a = app;
  const t = { root: await signIn(a, 'root'), ann: await signIn(a, 'ann'), bob: await signIn(a, 'bob'), cat: await signIn(a, 'cat'), dan: await signIn(a, 'dan') };
  const mk = async (token: string, name: string) => (await call(a.port, 'POST', '/api/circles', { token, body: { name } })).json.circle.id as string;
  const c1 = await mk(t.bob, 'One');
  const c2 = await mk(t.bob, 'Two');
  const c3 = await mk(t.bob, 'Three');
  const c4 = await mk(t.dan, 'Four');
  a.ids.bob ??= '';
  for (const c of [c1, c2, c3, c4]) must(await createGraph(a.graphs, `circle-${c}`));
  await addMember(a, c1, 'ann', 'owner');
  await addMember(a, c2, 'ann', 'member');
  await addMember(a, c3, 'ann', 'observer');
  await fill(a, `user-${a.ids.ann}`, ['shared', 'p-only'], 'PERSONAL');
  await fill(a, `circle-${c1}`, ['shared', 'one-only'], 'C1');
  await fill(a, `circle-${c2}`, ['shared'], 'C2');
  await fill(a, `circle-${c3}`, ['shared'], 'C3');
  await fill(a, `circle-${c4}`, ['secret'], 'SECRET-OF-C4');
  return { a, t, c1, c2, c3, c4 };
}
const NO_CIRCLE = { code: 'NOT_FOUND', message: 'no such circle' };

describe('capturing into a circle', () => {
  it('a body scope puts the note in that circle: 201 with the circle named, approval writes there, and the answer names no graph', async () => {
    const { a, t, c1 } = await started();
    const made = await post(a, '/api/capture/propose', { text: 'Dr Patel booked my blood test', scope: { kind: 'circle', circleId: c1 } }, t.ann);
    expect(made.status).toBe(201);
    expect(made.json.proposal.scope).toEqual({ kind: 'circle', circleId: c1, circleName: 'One' });
    const before = (await get(a, `/api/brain?scope=circle:${c1}`, t.ann)).json.summary.itemCount;
    expect((await post(a, `/api/capture/proposals/${made.json.proposal.id}/approve`, undefined, t.ann)).status).toBe(200);
    expect((await get(a, `/api/brain?scope=circle:${c1}`, t.ann)).json.summary.itemCount).toBe(before + 1);
    expect((await get(a, '/api/graph', t.ann)).json.summary.itemCount).toBe(2); // the personal brain is untouched
  });

  it('with no scope, or the personal scope, it is the same as before and the proposal has no scope', async () => {
    const { a, t } = await started();
    for (const body of [{ text: 'gardening notes' }, { text: 'gardening notes', scope: { kind: 'personal' } }]) {
      const r = await post(a, '/api/capture/propose', body, t.cat);
      expect(r.status).toBe(201);
      expect('scope' in r.json.proposal).toBe(false);
    }
  });

  it('an observer, a stranger and a made-up circle are all the same 404; a malformed scope is 422 naming it; an extra body key is refused by name', async () => {
    const { a, t, c3, c4 } = await started();
    const text = 'Dr Patel booked my blood test';
    const one = await post(a, '/api/capture/propose', { text, scope: { kind: 'circle', circleId: c3 } }, t.ann); // observer
    const two = await post(a, '/api/capture/propose', { text, scope: { kind: 'circle', circleId: c4 } }, t.ann); // not in it
    const three = await post(a, '/api/capture/propose', { text, scope: { kind: 'circle', circleId: 'c9999999999999999' } }, t.ann);
    const four = await post(a, '/api/capture/propose', { text, scope: { kind: 'circle', circleId: c4 } }, t.root); // the administrator
    for (const r of [one, two, three, four]) {
      expect(r.status).toBe(404);
      expect(r.json.error).toEqual(NO_CIRCLE);
    }
    expect([one.text, two.text, three.text, four.text].every((x) => x === one.text)).toBe(true);
    const bad = await post(a, '/api/capture/propose', { text, scope: { kind: 'circle', circleId: 'x' } }, t.ann);
    expect(bad.status).toBe(422);
    expect(bad.json.error.field).toBe('scope.circleId');
    expect((await post(a, '/api/capture/propose', { text, scope: { kind: 'circle', circleId: c3, graphId: 'x' } }, t.ann)).json.error.field).toBe('scope.graphId');
    expect((await post(a, '/api/capture/propose', { text, graphId: 'x' }, t.ann)).json.error.field).toBe('graphId');
    expect((await post(a, '/api/capture/propose', { text, scope: 'circle' }, t.ann)).json.error.field).toBe('scope');
  });
});

describe('browsing one scope', () => {
  it('personal is the own brain, a circle is that circle with its name, and the same ids never cross', async () => {
    const { a, t, c1, c2 } = await started();
    const own = await get(a, '/api/brain?scope=personal', t.ann);
    expect(own.json).toEqual({ summary: { itemCount: 2, categoryCount: 2, edgeCount: 2 } });
    expect((await get(a, '/api/brain', t.ann)).json).toEqual(own.json);
    const one = await get(a, `/api/brain?scope=circle:${c1}`, t.ann);
    expect(one.json.summary).toMatchObject({ itemCount: 2, scope: { kind: 'circle', circleId: c1, circleName: 'One' } });
    const cats = await get(a, `/api/brain/categories?scope=circle:${c2}`, t.ann);
    expect(cats.json.items.map((c: { name: string }) => c.name)).toEqual(['shared of C2']);
    expect(cats.json.scope).toEqual({ kind: 'circle', circleId: c2, circleName: 'Two' });
    const items = await get(a, `/api/brain/category?scope=circle:${c1}&id=shared`, t.ann);
    expect(items.json.items.map((i: { data: { title: string } }) => i.data.title)).toEqual(['C1 shared']);
    const detail = await get(a, `/api/brain/item?scope=circle:${c1}&id=item-shared`, t.ann);
    expect(detail.json.item.data.title).toBe('C1 shared');
    expect(detail.json.scope.circleName).toBe('One');
    expect((await get(a, `/api/brain/category?scope=personal&id=shared`, t.ann)).json.items[0].data.title).toBe('PERSONAL shared');
  });

  it('an observer may browse; the old /api/graph routes still give the same personal answers as scope=personal', async () => {
    const { a, t, c3 } = await started();
    expect((await get(a, `/api/brain?scope=circle:${c3}`, t.ann)).status).toBe(200);
    for (const [old, now] of [['/api/graph', '/api/brain?scope=personal'], ['/api/graph/categories', '/api/brain/categories?scope=personal'], ['/api/graph/category?id=shared', '/api/brain/category?scope=personal&id=shared'], ['/api/graph/item?id=item-shared', '/api/brain/item?scope=personal&id=item-shared']] as const) {
      expect((await get(a, old, t.ann)).json, old).toEqual((await get(a, now, t.ann)).json);
    }
  });

  it('a stranger, the administrator, someone in no circle and a made-up circle get the identical 404 from every brain route', async () => {
    const { a, t, c4 } = await started();
    const paths = (c: string) => [`/api/brain?scope=circle:${c}`, `/api/brain/categories?scope=circle:${c}`, `/api/brain/category?scope=circle:${c}&id=secret`, `/api/brain/item?scope=circle:${c}&id=item-secret`];
    const missing = await Promise.all(paths('c9999999999999999').map((p) => get(a, p, t.ann)));
    for (const m of missing) {
      expect(m.status).toBe(404);
      expect(m.json.error).toEqual(NO_CIRCLE);
    }
    for (const who of ['ann', 'root', 'cat']) {
      for (const [i, p] of paths(c4).entries()) {
        const r = await get(a, p, t[who as 'ann']);
        expect(r.status, `${who} ${p}`).toBe(404);
        expect(r.text, `${who} ${p}`).toBe((missing[i] as { text: string }).text);
      }
    }
  });

  it('a malformed scope is 422 naming scope; a circle id of the wrong shape names scope.circleId; unknown parameters are refused by name', async () => {
    const { a, t } = await started();
    for (const s of ['mine2', 'circle', 'Circle:c1', 'everything', 'circle:']) {
      const r = await get(a, `/api/brain?scope=${s}`, t.ann);
      expect(r.status, s).toBe(422);
    }
    expect((await get(a, '/api/brain?scope=circle:nope', t.ann)).json.error.field).toBe('scope.circleId');
    expect((await get(a, '/api/brain?scope=bogus', t.ann)).json.error.field).toBe('scope');
    expect((await get(a, '/api/brain?graphId=user-u1', t.ann)).json.error.field).toBe('graphId');
    expect((await get(a, '/api/brain/categories?scope=personal&userId=x', t.ann)).json.error.field).toBe('userId');
    expect((await get(a, '/api/brain/categories?scope=personal&limit=0', t.ann)).json.error.field).toBe('limit');
  });
});

describe('My Brain', () => {
  it('lists the scopes the person may use, their own first, with role and whether they may capture', async () => {
    const { a, t, c1, c2, c3 } = await started();
    const r = await get(a, '/api/brain/scopes', t.ann);
    expect(r.status).toBe(200);
    const circles = [
      { scope: { kind: 'circle', circleId: c1, circleName: 'One' }, role: 'owner', canCapture: true },
      { scope: { kind: 'circle', circleId: c2, circleName: 'Two' }, role: 'member', canCapture: true },
      { scope: { kind: 'circle', circleId: c3, circleName: 'Three' }, role: 'observer', canCapture: false },
    ].sort((x, y) => (x.scope.circleId < y.scope.circleId ? -1 : 1)); // circle ids are random, the order is by id
    expect(r.json.items).toEqual([{ scope: { kind: 'personal' }, canCapture: true }, ...circles]);
    expect((await get(a, '/api/brain/scopes', t.cat)).json.items).toEqual([{ scope: { kind: 'personal' }, canCapture: true }]);
    expect((await get(a, '/api/brain/scopes?x=1', t.ann)).json.error.field).toBe('x');
  });

  it('the summary and the categories cover every readable scope, each tagged, in a fixed order, and page', async () => {
    const { a, t, c1, c2, c3 } = await started();
    const s = (await get(a, '/api/brain?scope=mine', t.ann)).json.summary;
    expect(s.itemCount).toBe(6);
    expect(s.scopes.map((x: { scope: { kind: string } }) => x.scope.kind)).toEqual(['personal', 'circle', 'circle', 'circle']);
    const order = [c1, c2, c3].sort();
    const first = await get(a, '/api/brain/categories?scope=mine&limit=3', t.ann);
    expect(first.json.items.map((c: { scope: { kind: string; circleId?: string }; id: string }) => `${c.scope.circleId ?? c.scope.kind}/${c.id}`).slice(0, 2)).toEqual(['personal/p-only', 'personal/shared']);
    expect(first.json.items[2].scope.circleId).toBe(order[0]);
    const rest = await get(a, `/api/brain/categories?scope=mine&limit=10&cursor=${encodeURIComponent(first.json.nextCursor)}`, t.ann);
    expect([...new Set([...first.json.items, ...rest.json.items].map((c: { scope: { circleId?: string } }) => c.scope.circleId))].filter(Boolean)).toEqual(order);
    expect(rest.json.items.length + 3).toBe(6);
    expect(rest.json.nextCursor).toBeNull();
    expect((await get(a, `/api/brain/categories?scope=mine&limit=3&cursor=${encodeURIComponent(first.json.nextCursor)}`, t.bob)).json.error.field).toBe('cursor');
    expect(JSON.stringify([s, first.json, rest.json])).not.toContain('SECRET');
  });

  it('a category or item is named by its source as well as its id; the source is required there and refused anywhere else', async () => {
    const { a, t, c1, c2 } = await started();
    const items = await get(a, `/api/brain/category?scope=mine&source=circle:${c2}&id=shared`, t.ann);
    expect(items.json.items.map((i: { data: { title: string }; scope: { circleId: string } }) => [i.data.title, i.scope.circleId])).toEqual([['C2 shared', c2]]);
    const mine = await get(a, '/api/brain/category?scope=mine&source=personal&id=shared', t.ann);
    expect(mine.json.scope).toEqual({ kind: 'personal' });
    expect(mine.json.items[0].scope).toEqual({ kind: 'personal' });
    const d = await get(a, `/api/brain/item?scope=mine&source=circle:${c1}&id=item-shared`, t.ann);
    expect(d.json.item.data.title).toBe('C1 shared');
    expect(d.json.categories[0].scope.circleId).toBe(c1);
    expect((await get(a, '/api/brain/item?scope=mine&id=item-shared', t.ann)).json.error.field).toBe('source');
    expect((await get(a, '/api/brain/item?scope=mine&source=mine&id=item-shared', t.ann)).json.error.field).toBe('source');
    expect((await get(a, '/api/brain/item?scope=mine&source=circle:x&id=item-shared', t.ann)).json.error.field).toBe('scope.circleId');
    expect((await get(a, `/api/brain/item?scope=personal&source=circle:${c1}&id=item-shared`, t.ann)).json.error.field).toBe('source');
    expect((await get(a, `/api/brain/category?scope=circle:${c1}&source=personal&id=shared`, t.ann)).json.error.field).toBe('source');
  });

  it('the items of a category in My Brain page with limit and cursor', async () => {
    const { a, t, c1 } = await started();
    const ops: unknown[] = [];
    for (let i = 0; i < 6; i++) ops.push({ op: 'upsertNode', partition: 'item', id: `m${i}`, data: { title: `M${i}` } }, { op: 'link', item: `m${i}`, category: 'shared' });
    must(await write(a.graphs, { version: 1, kind: 'mutation', graphId: `circle-${c1}`, ops } as never));
    const base = `/api/brain/category?scope=mine&source=circle:${c1}&id=shared`;
    const first = await get(a, `${base}&limit=3`, t.ann);
    expect(first.json.items).toHaveLength(3);
    const rest = await get(a, `${base}&limit=10&cursor=${encodeURIComponent(first.json.nextCursor)}`, t.ann);
    expect(rest.json.items).toHaveLength(4);
    expect(rest.json.nextCursor).toBeNull();
    expect((await get(a, `${base}&limit=0`, t.ann)).json.error.field).toBe('limit');
  });

  it('a source the person cannot read is the one 404; an id from another scope is a 404; an id is required', async () => {
    const { a, t, c4 } = await started();
    const r = await get(a, `/api/brain/item?scope=mine&source=circle:${c4}&id=item-secret`, t.ann);
    expect(r.status).toBe(404);
    expect(r.json.error).toEqual(NO_CIRCLE);
    expect((await get(a, '/api/brain/item?scope=mine&source=personal&id=item-one-only', t.ann)).status).toBe(404);
    expect((await get(a, '/api/brain/item?scope=mine&source=personal', t.ann)).json.error.field).toBe('id');
  });

  it('ids with awkward characters work in the query string', async () => {
    const { a, t, c1 } = await started();
    const odd = ['a b', 'A/B?c=d&e#f', '100%', '<b>x</b>', '😀', '..'];
    await fill(a, `circle-${c1}`, odd, 'ODD');
    for (const id of odd) {
      const r = await get(a, `/api/brain/item?scope=mine&source=circle:${c1}&id=${encodeURIComponent(`item-${id}`)}`, t.ann);
      expect(r.status, id).toBe(200);
      expect(r.json.item.id).toBe(`item-${id}`);
    }
  });
});

describe('the session and the method', () => {
  it('no cookie is 401 without a cookie set, a stale cookie is cleared, other credentials are ignored', async () => {
    const { a, t } = await started();
    for (const p of ['/api/brain', '/api/brain/scopes', '/api/brain/categories', '/api/brain/category?id=x', '/api/brain/item?id=x']) {
      const none = await get(a, p);
      expect(none.status, p).toBe(401);
      expect(none.cookie, p).toBeUndefined();
      const stale = await get(a, p, 'not-a-session');
      expect(stale.status, p).toBe(401);
      expect(stale.cookie, p).toMatch(/Max-Age=0/);
    }
    expect((await call(a.port, 'GET', '/api/brain', { headers: { authorization: `Bearer ${t.ann}` } })).status).toBe(401);
  });

  it('only GET: other methods are 405 with Allow', async () => {
    const { a, t } = await started();
    for (const p of ['/api/brain', '/api/brain/scopes', '/api/brain/categories', '/api/brain/category', '/api/brain/item']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const r = await call(a.port, method, p, { token: t.ann, ...(method === 'DELETE' ? {} : { body: {} }) });
        expect(r.status, `${method} ${p}`).toBe(405);
        expect(String(r.headers.allow)).toBe('GET');
      }
    }
  });

  it('ids in the path are plain 404 routes', async () => {
    const { a, t, c1 } = await started();
    for (const p of [`/api/brain/${c1}`, '/api/brain/categories/shared', '/api/brain/item/x', '/api/brain/']) expect((await get(a, p, t.ann)).status, p).toBe(404);
  });
});
