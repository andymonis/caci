import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './sharing.test-util.js';

const kept: World[] = [];
afterEach(() => {
  for (const w of kept.splice(0)) w.dispose();
});
const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
const errorOf = (r: { ok: boolean; error?: unknown }) => (r.ok ? undefined : r.error);

describe.each(['memory', 'sqlite'] as const)('reading a shared brain over the %s circle store', (kind) => {
  /** ann owns; bob and cat are members; dan is outside. ann shares health+travel with bob, keeps secret. */
  async function setup() {
    const w = await world(kind);
    kept.push(w);
    const circle = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'member']]);
    await w.seed('ann', {
      categories: { health: 'Health', travel: 'Travel', secret: 'Secret', lonely: 'Lonely' },
      items: [
        { id: 'both', under: ['health', 'secret'] },
        { id: 'shared-only', under: [['travel', 0.5]] },
        { id: 'private-only', under: ['secret'] },
      ],
    });
    must(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health', 'travel', 'lonely'] }));
    return { w, circle, ann: w.id('ann') };
  }

  it('says who has shared with me and how many categories', async () => {
    const { w, circle, ann } = await setup();
    const r = must(await w.sharing.sharedWithMe(w.token('bob'), circle));
    expect(r.items).toEqual([{ userId: ann, username: 'ann', displayName: 'Display ann', categoryCount: 3 }]);
    expect(must(await w.sharing.sharedWithMe(w.token('cat'), circle)).items).toEqual([]);
    expect(must(await w.sharing.sharedWithMe(w.token('ann'), circle)).items).toEqual([]);
  });

  it('lists only shared categories with counts of the items under them', async () => {
    const { w, circle, ann } = await setup();
    const r = must(await w.sharing.sharedCategories(w.token('bob'), circle, ann));
    expect(r.items).toEqual([
      { id: 'health', name: 'Health', itemCount: 1 },
      { id: 'lonely', name: 'Lonely', itemCount: 0 },
      { id: 'travel', name: 'Travel', itemCount: 1 },
    ]);
    expect(JSON.stringify(r)).not.toContain('Secret');
  });

  it('pages the categories with an opaque cursor', async () => {
    const { w, circle, ann } = await setup();
    const one = must(await w.sharing.sharedCategories(w.token('bob'), circle, ann, { limit: 2 }));
    expect(one.items.map((c) => c.id)).toEqual(['health', 'lonely']);
    expect(one.nextCursor).not.toBeNull();
    const two = must(await w.sharing.sharedCategories(w.token('bob'), circle, ann, { limit: 2, cursor: one.nextCursor }));
    expect(two.items.map((c) => c.id)).toEqual(['travel']);
    expect(two.nextCursor).toBeNull();
    for (const cursor of ['x', 'sA', 'sZZZ', 5 as never, 's'.padEnd(3000, 'a')]) {
      expect(errorOf(await w.sharing.sharedCategories(w.token('bob'), circle, ann, { cursor }))).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
    }
  });

  it('lists the items of a shared category, and an item filed under a private category too is shown only as the shared one', async () => {
    const { w, circle, ann } = await setup();
    const r = must(await w.sharing.sharedCategoryItems(w.token('bob'), circle, ann, 'health'));
    expect(r.category).toEqual({ id: 'health', name: 'Health' });
    expect(r.items.map((i) => i.id)).toEqual(['both']);
    expect(r.items[0]?.data).toEqual({ title: 'Title of both', summary: 'Summary of both' });
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('shows one item with only its shared categories named', async () => {
    const { w, circle, ann } = await setup();
    const both = must(await w.sharing.sharedItem(w.token('bob'), circle, ann, 'both'));
    expect(both.categories).toEqual([{ id: 'health', name: 'Health', weight: 1 }]);
    expect(JSON.stringify(both)).not.toMatch(/secret|Secret/);
    const only = must(await w.sharing.sharedItem(w.token('bob'), circle, ann, 'shared-only'));
    expect(only.categories).toEqual([{ id: 'travel', name: 'Travel', weight: 0.5 }]);
  });

  it('gives one not-found answer for everything that is not shared', async () => {
    const { w, circle, ann } = await setup();
    const t = w.token('bob');
    const same = async (real: unknown, madeUp: unknown) => expect(real).toEqual(madeUp);
    // a private category used as a shared one, an unshared category that exists, a made-up one, and a category that is shared but gone
    await same(await w.sharing.sharedCategoryItems(t, circle, ann, 'secret'), await w.sharing.sharedCategoryItems(t, circle, ann, 'nope'));
    expect(errorOf(await w.sharing.sharedCategoryItems(t, circle, ann, 'secret'))).toEqual({ code: 'NOT_FOUND', message: 'no such category' });
    // an item reachable only through a private category, and a made-up item
    await same(await w.sharing.sharedItem(t, circle, ann, 'private-only'), await w.sharing.sharedItem(t, circle, ann, 'nope'));
    expect(errorOf(await w.sharing.sharedItem(t, circle, ann, 'private-only'))).toEqual({ code: 'NOT_FOUND', message: 'no such item' });
    // an item in a category that exists only as another category's name
    expect(errorOf(await w.sharing.sharedItem(t, circle, ann, 'health'))).toEqual({ code: 'NOT_FOUND', message: 'no such item' });
    expect(errorOf(await w.sharing.sharedCategoryItems(t, circle, ann, 'both'))).toEqual({ code: 'NOT_FOUND', message: 'no such category' });
    // a member with no grant, oneself, a non-member's id, a made-up owner and a malformed one
    const brain = { code: 'NOT_FOUND', message: 'no such shared brain' };
    for (const owner of [w.id('bob'), w.id('dan'), 'u0000000000000000', 'nope', 7, undefined]) {
      expect(errorOf(await w.sharing.sharedCategories(t, circle, owner))).toEqual(brain);
      expect(errorOf(await w.sharing.sharedCategoryItems(t, circle, owner, 'health'))).toEqual(brain);
      expect(errorOf(await w.sharing.sharedItem(t, circle, owner, 'both'))).toEqual(brain);
    }
    expect(errorOf(await w.sharing.sharedCategories(w.token('cat'), circle, ann))).toEqual(brain);
  });

  it('a stranger, a non-text token and a made-up circle all read as no such circle', async () => {
    const { w, circle, ann } = await setup();
    await w.circle(2, 'cat', []);
    const nope = { code: 'NOT_FOUND', message: 'no such circle' };
    for (const c of [circle.replace('1', '9'), 'x', 5, undefined]) {
      expect(errorOf(await w.sharing.sharedWithMe(w.token('bob'), c))).toEqual(nope);
      expect(errorOf(await w.sharing.sharedCategories(w.token('bob'), c, ann))).toEqual(nope);
    }
    // bob is in circle 1 but not 2
    expect(errorOf(await w.sharing.sharedCategories(w.token('bob'), `c${'0'.repeat(15)}2`, ann))).toEqual(nope);
    expect(errorOf(await w.sharing.sharedWithMe('tok-zed', circle))).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(errorOf(await w.sharing.sharedItem(w.token('dan'), circle, ann, 'both'))).toEqual(nope);
  });

  it('re-checks the grant on every call: narrowing and withdrawing take effect at once', async () => {
    const { w, circle, ann } = await setup();
    const t = w.token('bob');
    must(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['travel'] }));
    expect(errorOf(await w.sharing.sharedCategoryItems(t, circle, ann, 'health'))).toMatchObject({ code: 'NOT_FOUND' });
    expect(errorOf(await w.sharing.sharedItem(t, circle, ann, 'both'))).toMatchObject({ code: 'NOT_FOUND' });
    expect(must(await w.sharing.sharedItem(t, circle, ann, 'shared-only')).item.id).toBe('shared-only');
    must(await w.sharing.withdraw(w.token('ann'), circle, w.id('bob')));
    expect(errorOf(await w.sharing.sharedCategories(t, circle, ann))).toMatchObject({ message: 'no such shared brain' });
    expect(must(await w.sharing.sharedWithMe(t, circle)).items).toEqual([]);
  });

  it('ends when either person leaves or is removed, and when the circle goes', async () => {
    const { w, circle, ann } = await setup();
    const t = w.token('bob');
    // the grantee leaves
    const gone = await w.store.removeMember(circle, w.id('bob'));
    expect(gone.ok).toBe(true);
    expect(errorOf(await w.sharing.sharedCategories(t, circle, ann))).toMatchObject({ message: 'no such circle' });
    expect(await w.store.getGrant(circle, ann, w.id('bob'))).toBeUndefined();
  });

  it('a grant whose owner left reads as nothing', async () => {
    const w = await world(kind);
    kept.push(w);
    const circle = await w.circle(1, 'ann', [['bob', 'owner'], ['cat', 'member']]);
    await w.seed('cat', { categories: { pets: 'Pets' }, items: [{ id: 'rex', under: ['pets'] }] });
    must(await w.sharing.setGrant(w.token('cat'), circle, w.id('bob'), { categories: ['pets'] }));
    expect(must(await w.sharing.sharedCategories(w.token('bob'), circle, w.id('cat'))).items).toHaveLength(1);
    await w.store.removeMember(circle, w.id('cat'));
    expect(errorOf(await w.sharing.sharedCategories(w.token('bob'), circle, w.id('cat')))).toMatchObject({ message: 'no such shared brain' });
  });

  it('a shared category that was deleted from the owner brain disappears quietly', async () => {
    const w = await world(kind);
    kept.push(w);
    const circle = await w.circle(1, 'ann', [['bob', 'member']]);
    await w.seed('ann', { categories: { a: 'A', b: 'B' } });
    must(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['a', 'b'] }));
    const { write } = await import('../graph_store/index.js');
    await write(w.graphs, { version: 1, kind: 'mutation', graphId: w.graphOf('ann'), ops: [{ op: 'deleteNode', partition: 'category', id: 'a' }] } as never);
    const list = must(await w.sharing.sharedCategories(w.token('bob'), circle, w.id('ann')));
    expect(list.items.map((c) => c.id)).toEqual(['b']);
    expect(must(await w.sharing.sharedWithMe(w.token('bob'), circle)).items[0]?.categoryCount).toBe(1);
    expect(errorOf(await w.sharing.sharedCategoryItems(w.token('bob'), circle, w.id('ann'), 'a'))).toMatchObject({ message: 'no such category' });
  });

  it('caps data like the owner\'s own browsing does', async () => {
    const w = await world(kind);
    kept.push(w);
    const circle = await w.circle(1, 'ann', [['bob', 'member']]);
    const { write } = await import('../graph_store/index.js');
    await write(w.graphs, { version: 1, kind: 'mutation', graphId: w.graphOf('ann'), ops: [
      { op: 'upsertNode', partition: 'category', id: 'c', data: { name: 'C' } },
      { op: 'upsertNode', partition: 'item', id: 'big', data: { title: 'x'.repeat(3000), summary: 'y'.repeat(3000) } },
      { op: 'upsertNode', partition: 'item', id: 'huge', data: { a: ['z'.repeat(2000), 'z'.repeat(2000), 'z'.repeat(2000)] } },
      { op: 'link', item: 'big', category: 'c' },
      { op: 'link', item: 'huge', category: 'c' },
    ] } as never);
    must(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['c'] }));
    const items = must(await w.sharing.sharedCategoryItems(w.token('bob'), circle, w.id('ann'), 'c')).items;
    const big = items.find((i) => i.id === 'big');
    expect(big?.dataTruncated).toBe(true);
    expect((big?.data.title as string).length).toBe(300);
    expect(items.find((i) => i.id === 'huge')).toMatchObject({ data: {}, dataTruncated: true });
  });

  it('pages the items of a category and refuses bad paging input', async () => {
    const w = await world(kind);
    kept.push(w);
    const circle = await w.circle(1, 'ann', [['bob', 'member']]);
    await w.seed('ann', { categories: { c: 'C' }, items: ['a', 'b', 'c'].map((id) => ({ id, under: ['c'] })) });
    must(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['c'] }));
    const ann = w.id('ann');
    const p1 = must(await w.sharing.sharedCategoryItems(w.token('bob'), circle, ann, 'c', { limit: 2 }));
    expect(p1.items.map((i) => i.id)).toEqual(['a', 'b']);
    const p2 = must(await w.sharing.sharedCategoryItems(w.token('bob'), circle, ann, 'c', { limit: 2, cursor: p1.nextCursor }));
    expect(p2.items.map((i) => i.id)).toEqual(['c']);
    expect(p2.nextCursor).toBeNull();
    expect(errorOf(await w.sharing.sharedCategoryItems(w.token('bob'), circle, ann, 'c', { cursor: 'bogus' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
    for (const limit of [0, 101, 1.5, Number.NaN]) {
      expect(errorOf(await w.sharing.sharedCategoryItems(w.token('bob'), circle, ann, 'c', { limit }))).toMatchObject({ code: 'INVALID_INPUT', field: 'limit' });
      expect(errorOf(await w.sharing.sharedCategories(w.token('bob'), circle, ann, { limit }))).toMatchObject({ field: 'limit' });
      expect(errorOf(await w.sharing.sharedWithMe(w.token('bob'), circle, { limit }))).toMatchObject({ field: 'limit' });
    }
    expect(errorOf(await w.sharing.sharedWithMe(w.token('bob'), circle, { cursor: 'bogus' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
    for (const id of [5, '', undefined, null]) {
      expect(errorOf(await w.sharing.sharedCategoryItems(w.token('bob'), circle, ann, id))).toMatchObject({ code: 'INVALID_INPUT', field: 'id' });
      expect(errorOf(await w.sharing.sharedItem(w.token('bob'), circle, ann, id))).toMatchObject({ code: 'INVALID_INPUT', field: 'id' });
    }
    expect(errorOf(await w.sharing.sharedItem(w.token('bob'), circle, ann, 'x'.repeat(300)))).toMatchObject({ code: 'NOT_FOUND', message: 'no such item' });
  });

  it('awkward ids work', async () => {
    const w = await world(kind);
    kept.push(w);
    const circle = await w.circle(1, 'ann', [['bob', 'member']]);
    const odd = ['a b', 'A/B?c=d&e#f', '100%', '😀', '<img>', '..'];
    await w.seed('ann', { categories: Object.fromEntries(odd.map((o) => [`cat ${o}`, o])), items: odd.map((o) => ({ id: `item ${o}`, under: [`cat ${o}`] })) });
    must(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: odd.map((o) => `cat ${o}`) }));
    for (const o of odd) {
      const c = must(await w.sharing.sharedCategoryItems(w.token('bob'), circle, w.id('ann'), `cat ${o}`));
      expect(c.items.map((i) => i.id)).toEqual([`item ${o}`]);
      expect(must(await w.sharing.sharedItem(w.token('bob'), circle, w.id('ann'), `item ${o}`)).categories[0]?.id).toBe(`cat ${o}`);
    }
  });

  it('is read only: no write primitive is ever called by any read', async () => {
    const { w, circle, ann } = await setup();
    w.writes.length = 0;
    const t = w.token('bob');
    await w.sharing.sharedWithMe(t, circle);
    await w.sharing.sharedCategories(t, circle, ann);
    await w.sharing.sharedCategoryItems(t, circle, ann, 'health');
    await w.sharing.sharedItem(t, circle, ann, 'both');
    await w.sharing.sharedItem(t, circle, ann, 'private-only');
    expect(w.writes).toEqual([]);
  });

  it('never reads the grantee\'s own graph or a third person\'s', async () => {
    const { w, circle, ann } = await setup();
    await w.seed('bob', { categories: { health: 'BOB-HEALTH' }, items: [{ id: 'both', under: ['health'] }] });
    const r = must(await w.sharing.sharedCategories(w.token('bob'), circle, ann));
    expect(JSON.stringify(r)).not.toContain('BOB-HEALTH');
    expect(must(await w.sharing.sharedItem(w.token('bob'), circle, ann, 'both')).categories.map((c) => c.name)).toEqual(['Health']);
  });

  it('an item and a category with the same id are told apart, and a missing owner graph reads as not found', async () => {
    const w = await world(kind);
    kept.push(w);
    const circle = await w.circle(1, 'ann', [['bob', 'member']]);
    await w.seed('ann', { categories: { same: 'Same', other: 'Other' }, items: [{ id: 'same', under: ['other'] }, { id: 'plain', under: ['same'] }] });
    must(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['same'] }));
    const t = w.token('bob');
    const ann = w.id('ann');
    // the item "same" is filed only under the private category "other": not visible, although a category "same" is shared
    expect(errorOf(await w.sharing.sharedItem(t, circle, ann, 'same'))).toMatchObject({ message: 'no such item' });
    expect(must(await w.sharing.sharedItem(t, circle, ann, 'plain')).categories[0]?.id).toBe('same');
    const { dropGraph } = await import('../graph_store/index.js');
    await dropGraph(w.graphs, w.graphOf('ann'));
    expect(errorOf(await w.sharing.sharedItem(t, circle, ann, 'plain'))).toMatchObject({ message: 'no such item' });
    expect(errorOf(await w.sharing.sharedCategoryItems(t, circle, ann, 'same'))).toMatchObject({ message: 'no such category' });
    expect(must(await w.sharing.sharedCategories(t, circle, ann)).items).toEqual([]);
  });

  it('reports a storage failure in the one fixed message', async () => {
    const { w, circle, ann } = await setup();
    const original = w.store.getGrant.bind(w.store);
    w.store.getGrant = async () => {
      throw new Error('disk exploded at /secret/path');
    };
    for (const r of [await w.sharing.sharedCategories(w.token('bob'), circle, ann), await w.sharing.sharedItem(w.token('bob'), circle, ann, 'both')]) {
      expect(errorOf(r)).toEqual({ code: 'STORAGE_ERROR', message: 'the sharing service could not complete the request' });
    }
    w.store.getGrant = original;
  });
});
