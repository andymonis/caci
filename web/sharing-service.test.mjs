import { describe, expect, it } from 'vitest';
import { ODD_CATEGORY, ODD_ITEM, SECRET, world } from './sharing-world.test-util.mjs';

// The sharing client against the real service: real SQLite files, real HTTP, three accounts.

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
