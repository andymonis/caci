import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createController } from '../app/index.js';
import { createCaciController } from '../caci/index.js';
import { createGraph } from '../graph_store/index.js';
import { createMemoryLedgerStore } from '../ledger/index.js';
import { createDemoModelClient, createLlm } from '../llm/index.js';
import { createScopeResolver } from '../scopes/index.js';
import { SHIPPED_CONTROLS } from '../llm/testing/shipped-controls.test-util.js';
import { createCaptureRoutes } from './capture-routes.js';
import { addMember, call, COOKIE, secrets, signIn, startCircleApp, type CircleApp } from './circle-routes.test-util.js';
import { createLedgerRoutes } from './ledger-routes.js';

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
  for (const leak of ['scrypt$', 'passwordHash', 'user-u', 'circle-c', 'prop-', 'proposalId']) expect(text, leak).not.toContain(leak);
});

const get = async (a: CircleApp, path: string, token?: string, headers?: Record<string, string>) => {
  const r = await call(a.port, 'GET', path, { token, ...(headers === undefined ? {} : { headers }) });
  all.push(r.text);
  return r;
};
const post = (a: CircleApp, path: string, body: unknown, token?: string) => call(a.port, 'POST', path, { token, body });
const NO_CIRCLE = { code: 'NOT_FOUND', message: 'no such circle' };
const OLD = 'Mum takes 2 x Tablet A a day for her blood pressure.';
const CHANGE = 'Mum now takes tablet day blood morning.';

/** root (the administrator), ann (owner of circle 1), bob (member), cat (observer), dan (in none). */
async function started(withLedger = true) {
  const ledger = createMemoryLedgerStore();
  app = await startCircleApp({
    more: ({ users, store, graphs, now, directory }) => {
      const capture = createController({ adapter: graphs, llm: createLlm({ controls: SHIPPED_CONTROLS, client: createDemoModelClient() }), now: () => now.value });
      const scopes = createScopeResolver({ users, store });
      const caci = createCaciController({ users, capture, graphAdapter: graphs, scopes, clock: () => now.value, ...(withLedger ? { ledger } : {}), directory });
      return [...createCaptureRoutes({ caci }), ...createLedgerRoutes({ caci })];
    },
  });
  const a = app;
  const t = { root: await signIn(a, 'root'), ann: await signIn(a, 'ann'), bob: await signIn(a, 'bob'), cat: await signIn(a, 'cat'), dan: await signIn(a, 'dan') };
  const c1 = (await call(a.port, 'POST', '/api/circles', { token: t.ann, body: { name: 'One' } })).json.circle.id as string;
  await createGraph(a.graphs, `circle-${c1}`);
  await addMember(a, c1, 'bob', 'member');
  await addMember(a, c1, 'cat', 'observer');
  const file = async (token: string, text: string, scope?: unknown) => {
    const made = await post(a, '/api/capture/propose', scope === undefined ? { text } : { text, scope }, token);
    expect(made.status).toBe(201);
    const done = await post(a, `/api/capture/proposals/${made.json.proposal.id}/approve`, undefined, token);
    expect(done.status).toBe(200);
  };
  return { a, t, c1, file, ledger };
}

describe('GET /api/ledger', () => {
  it('shows the person\'s own log by default, newest first, with the removed text, and says who', async () => {
    const { a, t, file } = await started();
    await file(t.ann, OLD);
    a.now.value += 5000;
    await file(t.ann, CHANGE);
    const r = await get(a, '/api/ledger', t.ann);
    expect(r.status).toBe(200);
    expect(r.json.nextCursor).toBeNull();
    const rows = r.json.items as Array<{ action: string; kind: string; title?: string; summary?: string; by?: { username: string; displayName: string } }>;
    expect(rows.map((e) => `${e.action} ${e.kind}`)).toEqual(['added item', 'added category', 'removed item', 'removed category', 'added input', 'added item', 'added category', 'added input']);
    expect(rows[2]?.summary).toContain('2 x Tablet A');
    expect(rows[0]?.by).toEqual({ username: 'ann', displayName: 'Display ann' });
    expect('scope' in r.json).toBe(false);
    expect(Object.keys(rows[0] as object).sort()).toEqual(['action', 'at', 'by', 'id', 'kind', 'subject', 'summary', 'title']);
    expect((await get(a, '/api/ledger?scope=personal', t.ann)).json).toEqual(r.json);
  });
  it('shows the words of each update as an input: the exact text, who, no subject and nothing of the proposal', async () => {
    const { a, t, file } = await started();
    const words = '  Mum new tablets one a day with food 😀 <b>MARK</b>\nsecond line  ';
    await file(t.ann, words);
    const r = await get(a, '/api/ledger', t.ann);
    const input = (r.json.items as Array<Record<string, unknown>>).filter((e) => e.kind === 'input');
    expect(input).toHaveLength(1);
    expect(Object.keys(input[0] as object).sort()).toEqual(['action', 'at', 'by', 'id', 'kind', 'text']);
    expect(input[0]).toMatchObject({ action: 'added', kind: 'input', text: words, by: { username: 'ann' } });
    expect(r.text).not.toContain('prop-');
    expect((r.json.items as Array<{ kind: string }>).at(-1)?.kind).toBe('input'); // directly under the facts it produced
  });

  it('an observer and every member read the words of a circle update; a stranger, the administrator and a made-up circle get the one 404', async () => {
    const { a, t, c1, file } = await started();
    await file(t.bob, 'Dentist appointment on Friday morning CIRCLE-WORDS', { kind: 'circle', circleId: c1 });
    for (const who of ['ann', 'bob', 'cat'] as const) {
      const r = await get(a, `/api/ledger?scope=circle:${c1}`, t[who]);
      expect(r.status, who).toBe(200);
      expect((r.json.items as Array<{ kind: string; text?: string; by?: { username: string } }>).find((e) => e.kind === 'input')).toMatchObject({ text: 'Dentist appointment on Friday morning CIRCLE-WORDS', by: { username: 'bob' } });
    }
    const made = await get(a, '/api/ledger?scope=circle:c0000000000000999', t.dan);
    for (const who of ['dan', 'root'] as const) {
      const r = await get(a, `/api/ledger?scope=circle:${c1}`, t[who]);
      expect(r.status, who).toBe(404);
      expect(r.json).toEqual(made.json);
      expect(r.text).not.toContain('CIRCLE-WORDS');
    }
    // the same words never appear in anyone's personal log
    expect((await get(a, '/api/ledger', t.bob)).text).not.toContain('CIRCLE-WORDS');
    expect((await get(a, '/api/ledger', t.cat)).text).not.toContain('CIRCLE-WORDS');
  });

  it('is the same for a member, an observer and the owner of a circle, and names the circle', async () => {
    const { a, t, c1, file } = await started();
    await file(t.bob, OLD, { kind: 'circle', circleId: c1 });
    const ann = await get(a, `/api/ledger?scope=circle:${c1}`, t.ann);
    expect(ann.status).toBe(200);
    expect(ann.json.scope).toEqual({ kind: 'circle', circleId: c1, circleName: 'One' });
    expect(ann.json.items[0].by.username).toBe('bob');
    expect((await get(a, `/api/ledger?scope=circle:${c1}`, t.bob)).json).toEqual(ann.json);
    expect((await get(a, `/api/ledger?scope=circle:${c1}`, t.cat)).json).toEqual(ann.json);
    expect((await get(a, '/api/ledger', t.bob)).json.items).toEqual([]);
  });
  it('a person in no circle, the administrator and a made-up circle all get the same 404', async () => {
    const { a, t, c1, file } = await started();
    await file(t.bob, OLD, { kind: 'circle', circleId: c1 });
    const replies = [await get(a, `/api/ledger?scope=circle:${c1}`, t.dan), await get(a, `/api/ledger?scope=circle:${c1}`, t.root), await get(a, '/api/ledger?scope=circle:c9999999999999999', t.ann), await get(a, '/api/ledger?scope=circle:x', t.ann)];
    expect(replies.slice(0, 3).map((r) => r.status)).toEqual([404, 404, 404]);
    for (const r of replies.slice(0, 3)) expect(r.json.error).toEqual(NO_CIRCLE);
    expect(new Set(replies.slice(0, 3).map((r) => r.text)).size).toBe(1);
    expect(replies[3]?.status).toBe(422); // a malformed circle id is refused by name
    expect(replies[3]?.json.error.field).toBe('scope.circleId');
  });
  it('pages newest first without gaps or repeats, and a cursor from another scope is refused', async () => {
    const { a, t, c1, file } = await started();
    for (let i = 0; i < 3; i++) {
      await file(t.ann, `Note ${i} about topic${i} gardening things`);
      a.now.value += 1000;
    }
    await file(t.ann, 'Something in the circle here', { kind: 'circle', circleId: c1 });
    const everything = (await get(a, '/api/ledger?limit=100', t.ann)).json.items.map((e: { id: string }) => e.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 30; guard++) {
      const r = await get(a, `/api/ledger?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, t.ann);
      expect(r.status).toBe(200);
      seen.push(...r.json.items.map((e: { id: string }) => e.id));
      cursor = r.json.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(everything);
    const first = await get(a, '/api/ledger?limit=1', t.ann);
    const bad = await get(a, `/api/ledger?scope=circle:${c1}&cursor=${encodeURIComponent(first.json.nextCursor)}`, t.ann);
    expect(bad.status).toBe(422);
    expect(bad.json.error.field).toBe('cursor');
  });
  it('refuses bad input by name: an unknown parameter, a bad scope, a limit that is not a number or is out of range, a bad cursor', async () => {
    const { a, t } = await started();
    const cases: Array<[string, string]> = [['x=1', 'x'], ['scope=mine', 'scope'], ['scope=group', 'scope'], ['limit=abc', 'limit'], ['limit=0', 'limit'], ['limit=101', 'limit'], ['limit=', 'limit'], ['cursor=junk', 'cursor'], ['graphId=user-x', 'graphId'], ['userId=u1', 'userId']];
    for (const [query, field] of cases) {
      const r = await get(a, `/api/ledger?${query}`, t.ann);
      expect(r.status, query).toBe(422);
      expect(r.json.error.field, query).toBe(field);
    }
  });
  it('needs the session cookie and nothing else counts: no cookie is 401 setting nothing, a stale cookie is cleared, Authorization and ?token= are ignored', async () => {
    const { a, t } = await started();
    const none = await get(a, '/api/ledger');
    expect(none.status).toBe(401);
    expect(none.cookie).toBeUndefined();
    const stale = await get(a, '/api/ledger', 'x'.repeat(43));
    expect(stale.status).toBe(401);
    expect(stale.cookie).toContain(`${COOKIE}=;`);
    expect((await get(a, '/api/ledger', undefined, { authorization: `Bearer ${t.ann}` })).status).toBe(401);
    expect((await get(a, `/api/ledger?token=${t.ann}`)).status).toBe(401);
    expect((await get(a, `/api/ledger?token=${t.ann}`, t.ann)).status).toBe(422);
  });
  it('is read-only and exactly one path: other methods are 405 with Allow: GET, other paths 404', async () => {
    const { a, t } = await started();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await call(a.port, method, '/api/ledger', { token: t.ann, ...(method === 'DELETE' ? {} : { body: {} }) });
      all.push(r.text);
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe('GET');
    }
    for (const path of ['/api/ledger/', '/api/ledger/x', '/api/ledger/..', '/api/ledgers']) expect((await get(a, path, t.ann)).status, path).toBe(404);
  });
  it('without a change log it says so, as a 404', async () => {
    const { a, t } = await started(false);
    const r = await get(a, '/api/ledger', t.ann);
    expect(r.status).toBe(404);
    expect(r.json.error.message).toBe('the change log is not available');
  });
  it('has the standard protective headers', async () => {
    const { a, t } = await started();
    const r = await get(a, '/api/ledger', t.ann);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});
