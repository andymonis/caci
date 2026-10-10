import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js';
import { write } from '../graph_store/index.js';
import type { ServiceConfig } from './config.js';
import { startService, type RunningService } from './service.js';

// Shared brains as people would use them: the real service on real SQLite files, over real HTTP. root is the
// first account (the platform administrator); ann owns the brain; bob and cat are members; dan is a stranger.

const PW = 'correct horse 7 staple';
const SECRET = 'SECRET-NAME-OF-A-PRIVATE-CATEGORY';
const dirs: string[] = [];
const running: RunningService[] = [];
const readersSaw: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  const all = readersSaw.join('\n');
  expect(readersSaw.length).toBeGreaterThan(50);
  for (const leak of [SECRET, 'hidden-note', PW, 'scrypt$', 'passwordHash', 'email', 'graphId', 'user-u']) expect(all.includes(leak), `a reader's response held "${leak}"`).toBe(false);
});

const config = (dataDir: string): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 0, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, maxBrainScopes: 25 });

interface Reply {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  headers: Headers;
}
/** `reader` means what it sees must never hold the owner's private names. */
function browser(port: number, reader = false) {
  let cookie: string | undefined;
  return {
    async call(method: string, path: string, body?: unknown): Promise<Reply> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      if (reader && path.startsWith('/api/circles')) readersSaw.push(text);
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text), text, headers: res.headers };
    },
    async signIn(name: string): Promise<string> {
      const registered = await this.call('POST', '/api/register', { username: name, displayName: `Display ${name}`, password: PW });
      await this.call('POST', '/api/login', { username: name, password: PW });
      return registered.json.user.id as string;
    },
  };
}

const AWKWARD_CATEGORY = 'a b/c?d=e&f#g 😀';
const AWKWARD_ITEM = 'item <b>&"x"</b> 100%';

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'caci-sharing-e2e-'));
  dirs.push(dir);
  const service = await startService(config(dir));
  running.push(service);
  const port = service.port;
  const root = browser(port, true);
  const ann = browser(port);
  const bob = browser(port, true);
  const cat = browser(port, true);
  const dan = browser(port, true);
  await root.signIn('root');
  const ids = { ann: await ann.signIn('ann'), bob: await bob.signIn('bob'), cat: await cat.signIn('cat'), dan: await dan.signIn('dan') } as Record<string, string>;
  const circle = (await ann.call('POST', '/api/circles', { name: 'Club' })).json.circle.id as string;
  for (const [who, name] of [[bob, 'bob'], [cat, 'cat']] as const) {
    await ann.call('POST', `/api/circles/${circle}/invitations`, { username: name, role: 'member' });
    const inv = (await who.call('GET', '/api/invitations')).json.items[0].id as string;
    expect((await who.call('POST', `/api/invitations/${inv}/accept`)).status).toBe(200);
  }
  // ann's brain, written through a second connection to the graph file
  const graphs = createSqliteAdapter({ path: join(dir, 'graphs.db') });
  try {
    const wrote = await write(graphs, {
      version: 1,
      kind: 'mutation',
      graphId: `user-${ids.ann}`,
      ops: [
        { op: 'upsertNode', partition: 'category', id: 'health', data: { name: 'Health' } },
        { op: 'upsertNode', partition: 'category', id: 'travel', data: { name: 'Travel' } },
        { op: 'upsertNode', partition: 'category', id: 'secret', data: { name: SECRET } },
        { op: 'upsertNode', partition: 'category', id: AWKWARD_CATEGORY, data: { name: 'Odd' } },
        { op: 'upsertNode', partition: 'item', id: 'both', data: { title: 'Dentist', summary: 'Booked' } },
        { op: 'upsertNode', partition: 'item', id: 'solo', data: { title: 'Flights', summary: 'Lisbon' } },
        { op: 'upsertNode', partition: 'item', id: 'hidden', data: { title: 'hidden-note', summary: 'private' } },
        { op: 'upsertNode', partition: 'item', id: AWKWARD_ITEM, data: { title: 'Odd one' } },
        { op: 'link', item: 'both', category: 'health', weight: 0.9 },
        { op: 'link', item: 'both', category: 'secret', weight: 0.5 },
        { op: 'link', item: 'solo', category: 'travel' },
        { op: 'link', item: 'hidden', category: 'secret' },
        { op: 'link', item: AWKWARD_ITEM, category: AWKWARD_CATEGORY },
      ],
    } as never);
    if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
  } finally {
    await graphs.close();
  }
  const share = (who: string, categories: string[]) => ann.call('PUT', `/api/circles/${circle}/grants/${ids[who]}`, { categories });
  return { service, dir, root, ann, bob, cat, dan, ids, circle, share, port };
}

/** Status, body and the headers that matter, without the date. */
const shape = (r: Reply) => ({ status: r.status, text: r.text, type: r.headers.get('content-type'), length: r.headers.get('content-length'), csp: r.headers.get('content-security-policy'), cache: r.headers.get('cache-control') });
const q = (id: string) => encodeURIComponent(id);

describe('shared brains over the real service', () => {
  it('a member reads exactly what was shared, and a private category and what is reachable only through it read like a made-up id', async () => {
    const w = await world();
    const shared = `/api/circles/${w.circle}/shared`;
    const annId = w.ids.ann;
    // nothing is shared yet: the list is empty and the owner's brain reads like a made-up person
    expect((await w.bob.call('GET', shared)).json.items).toEqual([]);
    const noBrain = await w.bob.call('GET', `${shared}/${annId}/categories`);
    expect(noBrain.status).toBe(404);
    expect(shape(noBrain)).toEqual(shape(await w.bob.call('GET', `${shared}/u0000000000000000/categories`)));

    expect((await w.share('bob', ['health', 'travel', AWKWARD_CATEGORY])).status).toBe(200);
    expect((await w.bob.call('GET', shared)).json.items).toEqual([{ userId: annId, username: 'ann', displayName: 'Display ann', categoryCount: 3 }]);
    const cats = (await w.bob.call('GET', `${shared}/${annId}/categories`)).json;
    expect(cats.items).toEqual([
      { id: AWKWARD_CATEGORY, name: 'Odd', itemCount: 1 },
      { id: 'health', name: 'Health', itemCount: 1 },
      { id: 'travel', name: 'Travel', itemCount: 1 },
    ]);
    const health = (await w.bob.call('GET', `${shared}/${annId}/category?id=health`)).json;
    expect(health.items.map((i: { id: string }) => i.id)).toEqual(['both']);
    expect(health.items[0].data).toEqual({ title: 'Dentist', summary: 'Booked' });
    // an item in a shared and a private category shows only the shared one
    const both = (await w.bob.call('GET', `${shared}/${annId}/item?id=both`)).json;
    expect(both.categories).toEqual([{ id: 'health', name: 'Health', weight: 0.9 }]);
    // awkward ids work in the query string
    const odd = await w.bob.call('GET', `${shared}/${annId}/category?id=${q(AWKWARD_CATEGORY)}`);
    expect(odd.json.items.map((i: { id: string }) => i.id)).toEqual([AWKWARD_ITEM]);
    expect((await w.bob.call('GET', `${shared}/${annId}/item?id=${q(AWKWARD_ITEM)}`)).json.categories[0].id).toBe(AWKWARD_CATEGORY);

    // not shared: a private category, an item reachable only through it, and made-up ids all read the same
    const secretCat = await w.bob.call('GET', `${shared}/${annId}/category?id=secret`);
    expect(secretCat.status).toBe(404);
    expect(shape(secretCat)).toEqual(shape(await w.bob.call('GET', `${shared}/${annId}/category?id=made-up`)));
    const hidden = await w.bob.call('GET', `${shared}/${annId}/item?id=hidden`);
    expect(hidden.status).toBe(404);
    expect(shape(hidden)).toEqual(shape(await w.bob.call('GET', `${shared}/${annId}/item?id=made-up`)));
    // a member with no grant reads like a made-up person
    expect((await w.cat.call('GET', shared)).json.items).toEqual([]);
    expect(shape(await w.cat.call('GET', `${shared}/${annId}/category?id=health`))).toEqual(shape(await w.cat.call('GET', `${shared}/u0000000000000000/category?id=health`)));
  });

  it('narrowing and withdrawing take effect on the next request', async () => {
    const w = await world();
    const shared = `/api/circles/${w.circle}/shared/${w.ids.ann}`;
    await w.share('bob', ['health', 'travel']);
    expect((await w.bob.call('GET', `${shared}/item?id=both`)).status).toBe(200);
    await w.share('bob', ['travel']);
    expect((await w.bob.call('GET', `${shared}/item?id=both`)).status).toBe(404);
    expect((await w.bob.call('GET', `${shared}/category?id=health`)).status).toBe(404);
    expect((await w.bob.call('GET', `${shared}/item?id=solo`)).status).toBe(200);
    expect((await w.share('bob', [])).status).toBe(204);
    expect((await w.bob.call('GET', `${shared}/categories`)).status).toBe(404);
    expect((await w.bob.call('GET', `/api/circles/${w.circle}/shared`)).json.items).toEqual([]);
  });

  it('a stranger and the administrator read nothing, from all four routes', async () => {
    const w = await world();
    await w.share('bob', ['health']);
    const made = 'c0000000000000000';
    const routes = (circle: string) => [`/api/circles/${circle}/shared`, `/api/circles/${circle}/shared/${w.ids.ann}/categories`, `/api/circles/${circle}/shared/${w.ids.ann}/category?id=health`, `/api/circles/${circle}/shared/${w.ids.ann}/item?id=both`];
    for (const who of [w.dan, w.root]) {
      for (const [i, path] of routes(w.circle).entries()) {
        const real = await who.call('GET', path);
        expect(real.status, path).toBe(404);
        expect(real.json.error).toEqual({ code: 'NOT_FOUND', message: 'no such circle' });
        expect(shape(real)).toEqual(shape(await who.call('GET', routes(made)[i] as string)));
      }
    }
  });

  it('is strict: unknown parameters are refused by name, ids are never taken from the path or a body, odd paths are plain 404s', async () => {
    const w = await world();
    await w.share('bob', ['health']);
    const base = `/api/circles/${w.circle}/shared/${w.ids.ann}`;
    for (const [path, field] of [[`/api/circles/${w.circle}/shared?ownerGraph=x`, 'ownerGraph'], [`${base}/categories?userId=x`, 'userId'], [`${base}/category?id=health&owner=x`, 'owner'], [`${base}/item?id=both&limit=5`, 'limit']] as const) {
      const r = await w.bob.call('GET', path);
      expect(r.status, path).toBe(422);
      expect(r.json.error).toMatchObject({ code: 'INVALID_INPUT', field });
    }
    for (const path of [`${base}/category`, `${base}/category?id=`, `${base}/item`, `${base}/item?id=`]) {
      const r = await w.bob.call('GET', path);
      expect(r.status, path).toBe(422);
      expect(r.json.error.field).toBe('id');
    }
    expect((await w.bob.call('GET', `${base}/category?id=health&limit=0`)).json.error.field).toBe('limit');
    expect((await w.bob.call('GET', `${base}/category?id=health&cursor=bogus`)).json.error.field).toBe('cursor');
    expect((await w.bob.call('GET', `${base}/categories?cursor=bogus`)).json.error.field).toBe('cursor');
    for (const path of [`${base}/category/health`, `${base}/item/both`, `/api/circles/${w.circle}/shared/..`, `/api/circles/${w.circle}/shared/%2e%2e/categories`, `${base}/categories/`]) expect((await w.bob.call('GET', path)).status, path).toBe(404);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) expect((await w.bob.call(method, `${base}/categories`, method === 'DELETE' ? undefined : {})).status, method).toBe(405);
    expect((await w.bob.call('GET', `${base}/categories`)).status).toBe(200);
  });

  it('leaving, being removed and rejoining end access and resurrect nothing', async () => {
    const w = await world();
    const shared = `/api/circles/${w.circle}/shared/${w.ids.ann}`;
    await w.share('bob', ['health']);
    await w.share('cat', ['health']);
    expect((await w.bob.call('POST', `/api/circles/${w.circle}/leave`)).status).toBe(204);
    expect((await w.bob.call('GET', `${shared}/categories`)).json.error.message).toBe('no such circle');
    expect((await w.ann.call('DELETE', `/api/circles/${w.circle}/members/${w.ids.cat}`)).status).toBe(204);
    expect((await w.cat.call('GET', `${shared}/categories`)).status).toBe(404);
    // both come back by invitation: no grant comes back with them
    for (const [who, name] of [[w.bob, 'bob'], [w.cat, 'cat']] as const) {
      await w.ann.call('POST', `/api/circles/${w.circle}/invitations`, { username: name, role: 'member' });
      const inv = (await who.call('GET', '/api/invitations')).json.items[0].id as string;
      await who.call('POST', `/api/invitations/${inv}/accept`);
      expect((await who.call('GET', `/api/circles/${w.circle}/shared`)).json.items).toEqual([]);
      expect((await who.call('GET', `${shared}/categories`)).json.error.message).toBe('no such shared brain');
    }
    expect((await w.ann.call('GET', `/api/circles/${w.circle}/grants`)).json.items).toEqual([]);
  });

  it('an account deletion removes the person\'s shares, on both sides', async () => {
    const w = await world();
    await w.share('bob', ['health']);
    await w.share('cat', ['travel']);
    // cat shares something back with bob, then cat deletes the account
    const graphs = createSqliteAdapter({ path: join(w.dir, 'graphs.db') });
    try {
      await write(graphs, { version: 1, kind: 'mutation', graphId: `user-${w.ids.cat}`, ops: [{ op: 'upsertNode', partition: 'category', id: 'pets', data: { name: 'Pets' } }] } as never);
    } finally {
      await graphs.close();
    }
    expect((await w.cat.call('PUT', `/api/circles/${w.circle}/grants/${w.ids.bob}`, { categories: ['pets'] })).status).toBe(200);
    expect((await w.bob.call('GET', `/api/circles/${w.circle}/shared`)).json.items).toHaveLength(2);
    expect((await w.cat.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    const seenByBob = (await w.bob.call('GET', `/api/circles/${w.circle}/shared`)).json.items as Array<{ username: string }>;
    expect(seenByBob.map((i) => i.username)).toEqual(['ann']);
    expect((await w.ann.call('GET', `/api/circles/${w.circle}/grants`)).json.items.map((g: { username: string }) => g.username)).toEqual(['bob']);
    // ann deletes hers: bob keeps the circle (handed over) and sees nothing shared
    expect((await w.ann.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    expect((await w.bob.call('GET', `/api/circles/${w.circle}/shared`)).json.items).toEqual([]);
  });

  it('a restart keeps a grant and a session', async () => {
    const w = await world();
    await w.share('bob', ['health']);
    await w.service.close();
    running.splice(running.indexOf(w.service), 1);
    const again = await startService(config(w.dir));
    running.push(again);
    const bob = browser(again.port, true);
    await bob.call('POST', '/api/login', { username: 'bob', password: PW });
    const r = await bob.call('GET', `/api/circles/${w.circle}/shared`);
    expect(r.json.items).toHaveLength(1);
    expect((await bob.call('GET', `/api/circles/${w.circle}/shared/${w.ids.ann}/item?id=both`)).json.item.data.title).toBe('Dentist');
  });
});
