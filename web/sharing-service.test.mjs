import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter } from '../src/graph_store/adapters/sqlite/index.ts';
import { write } from '../src/graph_store/index.ts';
import { startService } from '../src/service/service.ts';
import { createApiClient } from './api-client.js';
import { createCirclesClient } from './circles-client.js';
import { createSharingClient } from './sharing-client.js';

// The sharing client against the real service: real SQLite files, real HTTP, three accounts.

const PW = 'correct horse 7 staple';
const SECRET = 'SECRET-PRIVATE-CATEGORY';
const dirs = [];
const running = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let client = 0;
function browserFetch(port) {
  let cookie;
  const address = `198.51.100.${(client++ % 250) + 1}`;
  return async (path, init) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method,
      headers: { ...init.headers, ...(cookie ? { cookie } : {}), origin: `http://127.0.0.1:${port}`, 'x-forwarded-for': address },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
    return res;
  };
}

const ODD_CATEGORY = 'a b/c?d=e&f#g 😀';
const ODD_ITEM = '<b>item</b> 100%';

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'caci-sharing-web-'));
  dirs.push(dir);
  const service = await startService({ port: 0, bind: '127.0.0.1', dataDir: dir, allowRegistration: true, cookieSecure: false, trustedProxies: 1, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7 });
  running.push(service);
  const people = {};
  for (const name of ['ann', 'bob', 'cat']) {
    const f = browserFetch(service.port);
    const api = createApiClient({ fetchFn: f });
    const registered = await api.register({ username: name, displayName: `Display ${name}`, password: PW });
    await api.login({ username: name, password: PW });
    people[name] = { id: registered.value.id, circles: createCirclesClient({ fetchFn: f }), sharing: createSharingClient({ fetchFn: f }) };
  }
  const circle = (await people.ann.circles.createCircle({ name: 'Club' })).value.id;
  for (const name of ['bob', 'cat']) {
    await people.ann.circles.invite(circle, { username: name, role: 'member' });
    const invitation = (await people[name].circles.myInvitations()).value.items[0].id;
    expect((await people[name].circles.acceptInvitation(invitation)).ok).toBe(true);
  }
  const graphs = createSqliteAdapter({ path: join(dir, 'graphs.db') });
  try {
    const wrote = await write(graphs, {
      version: 1,
      kind: 'mutation',
      graphId: `user-${people.ann.id}`,
      ops: [
        { op: 'upsertNode', partition: 'category', id: 'health', data: { name: 'Health <i>x</i>' } },
        { op: 'upsertNode', partition: 'category', id: 'secret', data: { name: SECRET } },
        { op: 'upsertNode', partition: 'category', id: ODD_CATEGORY, data: { name: 'Odd' } },
        { op: 'upsertNode', partition: 'item', id: 'both', data: { title: 'Dentist', summary: '<script>x</script>' } },
        { op: 'upsertNode', partition: 'item', id: 'hidden', data: { title: 'hidden' } },
        { op: 'upsertNode', partition: 'item', id: ODD_ITEM, data: { title: 'Odd' } },
        { op: 'link', item: 'both', category: 'health', weight: 0.9 },
        { op: 'link', item: 'both', category: 'secret' },
        { op: 'link', item: 'hidden', category: 'secret' },
        { op: 'link', item: ODD_ITEM, category: ODD_CATEGORY },
      ],
    });
    if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
  } finally {
    await graphs.close();
  }
  return { ...people, circle, annId: people.ann.id };
}

describe('the sharing client against the real service', () => {
  it('shares, reads exactly what was shared, and a private category reads like a made-up one', async () => {
    const w = await world();
    const set = await w.ann.sharing.setGrant(w.circle, w.bob.id, ['health', ODD_CATEGORY]);
    expect(set.ok).toBe(true);
    expect(set.value.grant).toMatchObject({ userId: w.bob.id, username: 'bob', displayName: 'Display bob' });
    expect(set.value.grant.categories.map((c) => c.id)).toEqual([ODD_CATEGORY, 'health']);
    expect((await w.ann.sharing.listGrants(w.circle)).value.items).toHaveLength(1);

    const who = await w.bob.sharing.sharedWithMe(w.circle);
    expect(who.value.items).toEqual([{ userId: w.annId, username: 'ann', displayName: 'Display ann', categoryCount: 2 }]);
    const cats = await w.bob.sharing.sharedCategories(w.circle, w.annId);
    expect(cats.value.items.map((c) => [c.id, c.itemCount])).toEqual([[ODD_CATEGORY, 1], ['health', 1]]);
    expect(cats.value.items[1].name).toBe('Health <i>x</i>'); // markup is just text here
    const items = await w.bob.sharing.sharedCategoryItems(w.circle, w.annId, 'health');
    expect(items.value.items.map((i) => i.id)).toEqual(['both']);
    const detail = await w.bob.sharing.sharedItem(w.circle, w.annId, 'both');
    expect(detail.value.categories).toEqual([{ id: 'health', name: 'Health <i>x</i>', weight: 0.9 }]);
    expect(JSON.stringify([cats, items, detail])).not.toContain(SECRET);
    // awkward ids round-trip
    expect((await w.bob.sharing.sharedCategoryItems(w.circle, w.annId, ODD_CATEGORY)).value.items.map((i) => i.id)).toEqual([ODD_ITEM]);
    expect((await w.bob.sharing.sharedItem(w.circle, w.annId, ODD_ITEM)).value.item.id).toBe(ODD_ITEM);

    // not shared: the private category, an item reachable only through it, and made-up ids read the same
    const privateCat = await w.bob.sharing.sharedCategoryItems(w.circle, w.annId, 'secret');
    const madeCat = await w.bob.sharing.sharedCategoryItems(w.circle, w.annId, 'made-up');
    expect(privateCat).toEqual(madeCat);
    expect(privateCat.error).toMatchObject({ kind: 'not-found', what: 'category' });
    const hidden = await w.bob.sharing.sharedItem(w.circle, w.annId, 'hidden');
    expect(hidden).toEqual(await w.bob.sharing.sharedItem(w.circle, w.annId, 'made-up'));
    expect(hidden.error.what).toBe('item');
    // a member with no grant reads like a made-up person
    expect((await w.cat.sharing.sharedWithMe(w.circle)).value.items).toEqual([]);
    const noGrant = await w.cat.sharing.sharedCategories(w.circle, w.annId);
    expect(noGrant).toEqual(await w.cat.sharing.sharedCategories(w.circle, 'uaaaaaaaaaaaaaaaa'));
    expect(noGrant.error).toMatchObject({ kind: 'not-found', what: 'brain' });
  });

  it('narrowing and withdrawing take effect on the next read', async () => {
    const w = await world();
    await w.ann.sharing.setGrant(w.circle, w.bob.id, ['health']);
    expect((await w.bob.sharing.sharedItem(w.circle, w.annId, 'both')).ok).toBe(true);
    await w.ann.sharing.setGrant(w.circle, w.bob.id, [ODD_CATEGORY]);
    expect((await w.bob.sharing.sharedItem(w.circle, w.annId, 'both')).error.kind).toBe('not-found');
    expect(await w.ann.sharing.setGrant(w.circle, w.bob.id, [])).toEqual({ ok: true, value: { grant: null } });
    expect((await w.bob.sharing.sharedCategories(w.circle, w.annId)).error.what).toBe('brain');
    await w.ann.sharing.setGrant(w.circle, w.cat.id, ['health']);
    expect(await w.ann.sharing.withdrawGrant(w.circle, w.cat.id)).toEqual({ ok: true, value: true });
    expect((await w.ann.sharing.listGrants(w.circle)).value.items).toEqual([]);
  });

  it('the service\'s refusals arrive as kinds and words', async () => {
    const w = await world();
    const own = await w.ann.sharing.setGrant(w.circle, w.bob.id, ['secret-of-nobody']);
    expect(own).toMatchObject({ ok: false, error: { kind: 'invalid', field: 'categories' } });
    expect(JSON.stringify(own)).not.toContain('secret-of-nobody');
    expect(await w.ann.sharing.setGrant(w.circle, w.annId, ['health'])).toMatchObject({ ok: false, error: { kind: 'invalid', field: 'granteeId' } });
    const outsider = 'uaaaaaaaaaaaaaaaa';
    expect(await w.ann.sharing.setGrant(w.circle, outsider, ['health'])).toMatchObject({ ok: false, error: { kind: 'not-found', what: 'member' } });
    expect(await w.ann.sharing.listGrants('caaaaaaaaaaaaaaaaa'.slice(0, 17))).toMatchObject({ ok: false, error: { kind: 'not-found', what: 'circle' } });
    await w.cat.circles.leaveCircle(w.circle);
    expect(await w.cat.sharing.sharedWithMe(w.circle)).toMatchObject({ ok: false, error: { kind: 'not-found', what: 'circle' } });
  });
});
