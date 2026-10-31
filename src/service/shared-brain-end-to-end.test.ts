import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js';
import { listGraphs } from '../graph_store/index.js';
import type { ServiceConfig } from './config.js';
import { startService, type RunningService } from './service.js';

// The shared circle brain as people use it: the real service on real SQLite files over real HTTP, with the demo
// model. root is the first account (the administrator); ann owns two circles; bob is a member; cat an observer.

const PW = 'correct horse 7 staple';
const MARK = 'METFORMIN';
const NOTE = `Collected the ${MARK} prescription refill from the chemist`;
const dirs: string[] = [];
const running: RunningService[] = [];
const outsiders: string[] = []; // everything a stranger or the administrator was told
const everything: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  const all = everything.join('\n');
  expect(everything.length).toBeGreaterThan(80);
  for (const leak of [PW, 'scrypt$', 'passwordHash', 'user-u', 'circle-c']) expect(all.includes(leak), `a response held "${leak}"`).toBe(false);
  expect(outsiders.length).toBeGreaterThan(20);
  expect(outsiders.join('\n').includes(MARK), 'a stranger or the administrator was shown circle content').toBe(false);
});

const config = (dataDir: string): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 0, allowInsecure: false, llm: 'demo', proposalsPerHour: 100, maxPendingPerUser: 20, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, maxBrainScopes: 25, statusPerHour: 20, ledgerDays: 90, sessionIdleDays: 7, sessionDays: 30 });

interface Reply {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  headers: Headers;
}
type Person = ReturnType<typeof person>;
function person(getPort: () => number, outsider = false) {
  let cookie: string | undefined;
  return {
    async call(method: string, path: string, body?: unknown): Promise<Reply> {
      const res = await fetch(`http://127.0.0.1:${getPort()}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      if (path.startsWith('/api/brain') || path.startsWith('/api/capture') || path.startsWith('/api/graph')) everything.push(text);
      if (outsider && (path.startsWith('/api/brain') || path.startsWith('/api/capture') || path.startsWith('/api/graph'))) outsiders.push(text);
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text), text, headers: res.headers };
    },
    async signIn(name: string): Promise<string> {
      const r = await this.call('POST', '/api/register', { username: name, displayName: `Display ${name}`, password: PW });
      await this.call('POST', '/api/login', { username: name, password: PW });
      return r.json.user.id as string;
    },
  };
}

async function world(extra: Partial<ServiceConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'caci-shared-brain-'));
  dirs.push(dir);
  const service = await startService({ ...config(dir), ...extra });
  running.push(service);
  const port = { value: service.port };
  const get = () => port.value;
  const p = { root: person(get, true), ann: person(get), bob: person(get), cat: person(get), dan: person(get, true) };
  const ids: Record<string, string> = {};
  for (const [name, who] of Object.entries(p)) ids[name] = await who.signIn(name);
  const circle = async (owner: Person, name: string): Promise<string> => (await owner.call('POST', '/api/circles', { name })).json.circle.id as string;
  const accept = async (owner: Person, member: Person, id: string, username: string, role: string) => {
    await owner.call('POST', `/api/circles/${id}/invitations`, { username, role });
    const inv = (await member.call('GET', '/api/invitations')).json.items.find((i: { circle: { id: string } }) => i.circle.id === id).id as string;
    expect((await member.call('POST', `/api/invitations/${inv}/accept`)).status).toBe(200);
  };
  const parent = await circle(p.ann, 'Parent');
  const inlaw = await circle(p.ann, 'In-law');
  await accept(p.ann, p.bob, parent, 'bob', 'member');
  await accept(p.ann, p.bob, inlaw, 'bob', 'member');
  await accept(p.ann, p.cat, parent, 'cat', 'observer');
  /** Proposes and approves a note in a scope; returns the proposal. */
  const capture = async (who: Person, text: string, scope?: unknown) => {
    const made = await who.call('POST', '/api/capture/propose', { text, ...(scope === undefined ? {} : { scope }) });
    expect(made.status, made.text).toBe(201);
    expect((await who.call('POST', `/api/capture/proposals/${made.json.proposal.id}/approve`)).status).toBe(200);
    return made.json.proposal;
  };
  const cs = (id: string) => ({ kind: 'circle', circleId: id });
  return { dir, service, port, p, ids, parent, inlaw, capture, cs, circle };
}
const summary = async (who: Person, scope: string) => (await who.call('GET', `/api/brain?scope=${scope}`)).json.summary;
const NO_CIRCLE = { code: 'NOT_FOUND', message: 'no such circle' };

describe('the shared circle brain over the real service', () => {
  it('a member captures into a circle, the preview names it, nothing is written until approval, and only that circle changes', async () => {
    const w = await world();
    const made = await w.p.ann.call('POST', '/api/capture/propose', { text: NOTE, scope: w.cs(w.parent) });
    expect(made.json.proposal.scope).toEqual({ kind: 'circle', circleId: w.parent, circleName: 'Parent' });
    expect((await summary(w.p.ann, `circle:${w.parent}`)).itemCount).toBe(0);
    expect((await w.p.ann.call('GET', `/api/capture/proposals/${made.json.proposal.id}`)).json.proposal.scope.circleName).toBe('Parent');
    expect((await w.p.ann.call('POST', `/api/capture/proposals/${made.json.proposal.id}/approve`)).status).toBe(200);
    expect((await summary(w.p.ann, `circle:${w.parent}`)).itemCount).toBe(1);
    expect((await summary(w.p.ann, `circle:${w.inlaw}`)).itemCount).toBe(0);
    expect((await summary(w.p.ann, 'personal')).itemCount).toBe(0);
    expect((await w.p.ann.call('GET', '/api/graph')).json.summary.itemCount).toBe(0);
  });

  it('the same note into the personal brain and two circles gives the same ids three times, kept apart and tagged in My Brain, in a fixed order', async () => {
    const w = await world();
    await w.capture(w.p.bob, NOTE);
    await w.capture(w.p.bob, NOTE, w.cs(w.parent));
    await w.capture(w.p.bob, NOTE, w.cs(w.inlaw));
    const cats = (await w.p.bob.call('GET', '/api/brain/categories?scope=mine&limit=100')).json.items as Array<{ id: string; scope: { kind: string; circleId?: string } }>;
    const byId = new Map<string, number>();
    for (const c of cats) byId.set(c.id, (byId.get(c.id) ?? 0) + 1);
    expect(Math.max(...byId.values())).toBe(3); // some id appears in all three scopes
    const keys = cats.map((c) => `${c.scope.circleId ?? 'personal'}/${c.id}`);
    expect(new Set(keys).size).toBe(cats.length);
    expect(cats[0]?.scope.kind).toBe('personal');
    const circleOrder = [...new Set(cats.filter((c) => c.scope.kind === 'circle').map((c) => c.scope.circleId))];
    expect(circleOrder).toEqual([w.parent, w.inlaw].sort());
    const again = await w.p.bob.call('GET', '/api/brain/categories?scope=mine&limit=100');
    expect(again.json.items).toEqual(cats);
    const s = (await summary(w.p.bob, 'mine')) as { itemCount: number; scopes: Array<{ itemCount: number; scope: { kind: string } }> };
    expect(s.scopes.map((x) => x.itemCount)).toEqual([1, 1, 1]);
    expect(s.itemCount).toBe(3);
    // the same id in each scope is a different category with its own item
    const shared = [...byId].find(([, n]) => n === 3)?.[0] as string;
    const titles = [];
    for (const src of ['personal', `circle:${w.parent}`, `circle:${w.inlaw}`]) {
      const r = await w.p.bob.call('GET', `/api/brain/category?scope=mine&source=${src}&id=${encodeURIComponent(shared)}`);
      expect(r.status).toBe(200);
      expect(r.json.items).toHaveLength(1);
      titles.push(r.json.items[0].scope);
    }
    expect(titles).toEqual([{ kind: 'personal' }, { kind: 'circle', circleId: w.parent, circleName: 'Parent' }, { kind: 'circle', circleId: w.inlaw, circleName: 'In-law' }]);
  });

  it('an item says who added it', async () => {
    const w = await world();
    await w.capture(w.p.bob, NOTE, w.cs(w.parent));
    const cats = (await w.p.cat.call('GET', `/api/brain/categories?scope=circle:${w.parent}`)).json.items;
    const items = (await w.p.cat.call('GET', `/api/brain/category?scope=circle:${w.parent}&id=${encodeURIComponent(cats[0].id)}`)).json.items;
    expect(items[0].data.contributedBy).toBe(w.ids.bob);
  });

  it('an observer reads the circle and sees it in My Brain, and cannot capture: the same 404 as a stranger', async () => {
    const w = await world();
    await w.capture(w.p.ann, NOTE, w.cs(w.parent));
    expect((await summary(w.p.cat, `circle:${w.parent}`)).itemCount).toBe(1);
    const scopes = (await w.p.cat.call('GET', '/api/brain/scopes')).json.items;
    expect(scopes.map((s: { scope: { kind: string } }) => s.scope.kind)).toEqual(['personal', 'circle']);
    expect(scopes[1]).toMatchObject({ role: 'observer', canCapture: false });
    expect((await summary(w.p.cat, 'mine')).itemCount).toBe(1);
    const observer = await w.p.cat.call('POST', '/api/capture/propose', { text: NOTE, scope: w.cs(w.parent) });
    const stranger = await w.p.dan.call('POST', '/api/capture/propose', { text: NOTE, scope: w.cs(w.parent) });
    const madeUp = await w.p.dan.call('POST', '/api/capture/propose', { text: NOTE, scope: w.cs('c9999999999999999') });
    for (const r of [observer, stranger, madeUp]) {
      expect(r.status).toBe(404);
      expect(r.json.error).toEqual(NO_CIRCLE);
    }
    expect(observer.text).toBe(stranger.text);
  });

  it('a stranger and the administrator read nothing of a circle, from every route, and the answers are byte-identical to a made-up circle\'s', async () => {
    const w = await world();
    await w.capture(w.p.ann, NOTE, w.cs(w.parent));
    const cats = (await w.p.ann.call('GET', `/api/brain/categories?scope=circle:${w.parent}`)).json.items;
    const id = encodeURIComponent(cats[0].id);
    const routes = (c: string) => [`/api/brain?scope=circle:${c}`, `/api/brain/categories?scope=circle:${c}`, `/api/brain/category?scope=circle:${c}&id=${id}`, `/api/brain/item?scope=circle:${c}&id=${id}`, `/api/brain/category?scope=mine&source=circle:${c}&id=${id}`, `/api/brain/item?scope=mine&source=circle:${c}&id=${id}`];
    for (const who of [w.p.dan, w.p.root]) {
      for (const [i, path] of routes(w.parent).entries()) {
        const real = await who.call('GET', path);
        const fake = await who.call('GET', routes('c9999999999999999')[i] as string);
        expect(real.status, path).toBe(404);
        expect(real.text, path).toBe(fake.text);
        expect(real.headers.get('content-type')).toBe(fake.headers.get('content-type'));
      }
      expect((await who.call('GET', '/api/brain/scopes')).json.items).toHaveLength(1);
      expect((await who.call('GET', '/api/brain/categories?scope=mine')).json.items).toEqual([]);
    }
  });

  it('removal, demotion and promotion take effect on the next request, and records stay for the others', async () => {
    const w = await world();
    await w.capture(w.p.bob, NOTE, w.cs(w.parent));
    expect((await summary(w.p.bob, `circle:${w.parent}`)).itemCount).toBe(1);
    // bob has a proposal pending, then loses the right to capture
    const pending = await w.p.bob.call('POST', '/api/capture/propose', { text: NOTE, scope: w.cs(w.parent) });
    expect((await w.p.ann.call('PATCH', `/api/circles/${w.parent}/members/${w.ids.bob}`, { role: 'observer' })).status).toBe(200);
    expect((await summary(w.p.bob, `circle:${w.parent}`)).itemCount).toBe(1); // may still read
    const refused = await w.p.bob.call('POST', `/api/capture/proposals/${pending.json.proposal.id}/approve`);
    expect(refused.status).toBe(404);
    expect(refused.json.error).toEqual({ code: 'NOT_FOUND', message: 'no such proposal' });
    expect((await w.p.bob.call('POST', '/api/capture/propose', { text: NOTE, scope: w.cs(w.parent) })).status).toBe(404);
    expect((await w.p.ann.call('PATCH', `/api/circles/${w.parent}/members/${w.ids.bob}`, { role: 'member' })).status).toBe(200);
    await w.capture(w.p.bob, `${NOTE} again`, w.cs(w.parent));
    expect((await summary(w.p.ann, `circle:${w.parent}`)).itemCount).toBe(2);
    // removal
    expect((await w.p.ann.call('DELETE', `/api/circles/${w.parent}/members/${w.ids.bob}`)).status).toBe(204);
    const gone = await w.p.bob.call('GET', `/api/brain?scope=circle:${w.parent}`);
    expect(gone.status).toBe(404);
    expect(gone.json.error).toEqual(NO_CIRCLE);
    expect((await w.p.bob.call('GET', '/api/brain/scopes')).json.items.map((s: { scope: { kind: string; circleId?: string } }) => s.scope.circleId ?? 'personal')).toEqual(['personal', w.inlaw]);
    expect((await summary(w.p.ann, `circle:${w.parent}`)).itemCount).toBe(2); // what he added stays
  });

  it('deleting a circle drops its brain and nothing else; leaving does not touch it', async () => {
    const w = await world();
    await w.capture(w.p.ann, NOTE, w.cs(w.parent));
    await w.capture(w.p.ann, NOTE, w.cs(w.inlaw));
    await w.capture(w.p.ann, NOTE);
    expect((await w.p.bob.call('POST', `/api/circles/${w.parent}/leave`)).status).toBe(204);
    expect((await summary(w.p.ann, `circle:${w.parent}`)).itemCount).toBe(1);
    expect((await w.p.ann.call('DELETE', `/api/circles/${w.inlaw}`)).status).toBe(204);
    expect((await w.p.ann.call('GET', `/api/brain?scope=circle:${w.inlaw}`)).status).toBe(404);
    const s = await summary(w.p.ann, 'mine');
    expect(s.scopes).toHaveLength(2);
    expect(s.itemCount).toBe(2);
    const adapter = createSqliteAdapter({ path: join(w.dir, 'graphs.db') });
    try {
      const r = await listGraphs(adapter, { limit: 100 });
      const names = r.ok ? r.value.items.filter((g) => g.startsWith('circle-')) : [];
      expect(names).toEqual([`circle-${w.parent}`]);
    } finally {
      await adapter.close();
    }
  });

  it('a contributor deleting their account leaves what they added, and the circle they alone belonged to goes with its brain', async () => {
    const w = await world();
    await w.capture(w.p.bob, NOTE, w.cs(w.parent));
    const bobs = await w.circle(w.p.bob, 'Bobs own');
    await w.capture(w.p.bob, NOTE, w.cs(bobs));
    expect((await w.p.bob.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    expect((await summary(w.p.ann, `circle:${w.parent}`)).itemCount).toBe(1);
    const adapter = createSqliteAdapter({ path: join(w.dir, 'graphs.db') });
    try {
      const r = await listGraphs(adapter, { limit: 100 });
      expect((r.ok ? r.value.items : []).filter((g) => g === `circle-${bobs}`)).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it('a limit on how many scopes My Brain combines is a clear 422 naming scope, and one circle can still be browsed', async () => {
    const w = await world({ maxBrainScopes: 2 });
    await w.capture(w.p.ann, NOTE, w.cs(w.parent));
    for (const path of ['/api/brain/scopes', '/api/brain?scope=mine', '/api/brain/categories?scope=mine']) {
      const r = await w.p.ann.call('GET', path);
      expect(r.status, path).toBe(422);
      expect(r.json.error.field, path).toBe('scope');
      expect(r.json.error.message).toContain('choose one circle');
    }
    expect((await summary(w.p.ann, `circle:${w.parent}`)).itemCount).toBe(1);
    expect((await w.p.bob.call('GET', '/api/brain/scopes')).status).toBe(422);
    expect((await w.p.cat.call('GET', '/api/brain/scopes')).status).toBe(200);
  });

  it('a restart keeps the circle brains and forgets the pending proposal', async () => {
    const w = await world();
    await w.capture(w.p.ann, NOTE, w.cs(w.parent));
    const pending = await w.p.ann.call('POST', '/api/capture/propose', { text: NOTE, scope: w.cs(w.parent) });
    running.splice(running.indexOf(w.service), 1);
    await w.service.close();
    const again = await startService(config(w.dir));
    running.push(again);
    w.port.value = again.port;
    expect((await summary(w.p.ann, `circle:${w.parent}`)).itemCount).toBe(1);
    expect((await summary(w.p.cat, `circle:${w.parent}`)).itemCount).toBe(1);
    expect((await w.p.ann.call('GET', `/api/capture/proposals/${pending.json.proposal.id}`)).status).toBe(404);
  });

  it('every wrong scope or source is a plain 422 naming what to fix, for everyone', async () => {
    const w = await world();
    for (const [path, field] of [['/api/brain?scope=nope', 'scope'], ['/api/brain?scope=circle:x', 'scope.circleId'], ['/api/brain/item?scope=mine&id=x', 'source'], ['/api/brain/item?scope=personal&source=personal&id=x', 'source'], ['/api/brain/categories?scope=mine&limit=0', 'limit']] as const) {
      const r = await w.p.ann.call('GET', path);
      expect(r.status, path).toBe(422);
      expect(r.json.error.field, path).toBe(field);
    }
  });
});
