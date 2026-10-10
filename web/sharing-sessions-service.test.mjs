import { describe, expect, it } from 'vitest';
import { createGrantsSession } from './grants-session.js';
import { createSharedSession } from './shared-session.js';
import { ODD_CATEGORY, ODD_ITEM, SECRET, world } from './sharing-world.test-util.mjs';

// The two sharing sessions against the real service: real SQLite files, real HTTP, three accounts.

const grantsFor = (p) => createGrantsSession({ sharing: p.sharing, circles: p.circles, notes: p.notes });
const sharedFor = (p) => createSharedSession({ client: p.sharing });

describe('what you share, through the real service', () => {
  it('lists the other members, picks from my own categories, saves, narrows and stops after a question', async () => {
    const w = await world();
    const grants = grantsFor(w.ann);
    await grants.open(w.circle, w.annId);
    expect(grants.getState().people.map((p) => [p.username, p.shared.length])).toEqual(expect.arrayContaining([['bob', 0], ['cat', 0]]));
    expect(grants.getState().people).toHaveLength(2);

    await grants.edit(w.bob.id);
    expect(grants.getState().mine.items.map((c) => c.id).sort()).toEqual([ODD_CATEGORY, 'health', 'secret'].sort());
    grants.toggle('health');
    grants.toggle(ODD_CATEGORY);
    expect(await grants.save()).toEqual({ ok: true });
    expect(grants.getState().notice).toBe('Now sharing 2 categories with Display bob.');
    const bob = grants.getState().people.find((p) => p.userId === w.bob.id);
    expect(bob.shared.map((c) => c.id).sort()).toEqual([ODD_CATEGORY, 'health'].sort());

    // narrow to one
    await grants.edit(w.bob.id);
    expect([...grants.getState().editing.draft].sort()).toEqual([ODD_CATEGORY, 'health'].sort());
    grants.toggle('health');
    await grants.save();
    expect(grants.getState().notice).toBe('Now sharing 1 category with Display bob.');

    // stopping asks first
    grants.askStop(w.bob.id);
    expect(await grants.confirmStop()).toEqual({ ok: true });
    expect(grants.getState().notice).toBe('Stopped sharing with Display bob.');
    expect(grants.getState().people.every((p) => p.shared.length === 0)).toBe(true);
  });

  it('a person who left reloads the list with the words', async () => {
    const w = await world();
    const grants = grantsFor(w.ann);
    await grants.open(w.circle, w.annId);
    await grants.edit(w.bob.id);
    grants.toggle('health');
    await w.bob.circles.leaveCircle(w.circle);
    expect(await grants.save()).toMatchObject({ ok: false, kind: 'not-found' });
    expect(grants.getState().people.map((p) => p.userId)).toEqual([w.cat.id]);
    expect(grants.getState()).toMatchObject({ editing: null, problem: 'That person is no longer in this circle.' });
  });

  it('a stranger\'s circle is gone, in the one set of words', async () => {
    const w = await world();
    await w.cat.circles.leaveCircle(w.circle);
    const grants = grantsFor(w.cat);
    await grants.open(w.circle, w.cat.id);
    expect(grants.getState()).toMatchObject({ status: 'gone', message: 'No such circle, or you are not in it.', people: [] });
  });
});

describe('what is shared with you, through the real service', () => {
  it('walks people, categories, a category\'s items and an item, with only what was shared', async () => {
    const w = await world();
    await w.ann.sharing.setGrant(w.circle, w.bob.id, ['health', ODD_CATEGORY]);
    const shared = sharedFor(w.bob);
    await shared.open(w.circle);
    expect(shared.getState().people.items).toEqual([{ userId: w.annId, username: 'ann', displayName: 'Display ann', categoryCount: 2 }]);
    await shared.selectPerson(w.annId);
    expect(shared.getState().categories.items.map((c) => c.id).sort()).toEqual([ODD_CATEGORY, 'health'].sort());
    await shared.selectCategory('health');
    expect(shared.getState().category.items.map((i) => i.id)).toEqual(['both']);
    await shared.selectItem('both');
    expect(shared.getState().item.detail.categories.map((c) => c.id)).toEqual(['health']);
    expect(JSON.stringify(shared.getState())).not.toContain(SECRET);
    // the way back, step by step
    shared.back();
    shared.back();
    shared.back();
    expect(shared.getState().view).toBe('people');
    // awkward ids
    await shared.selectPerson(w.annId);
    await shared.selectCategory(ODD_CATEGORY);
    await shared.selectItem(ODD_ITEM);
    expect(shared.getState().item).toMatchObject({ status: 'loaded', id: ODD_ITEM });
  });

  it('withdrawing makes what was open read as gone, reloads the people, and a member with no grant sees nobody', async () => {
    const w = await world();
    await w.ann.sharing.setGrant(w.circle, w.bob.id, ['health']);
    const shared = sharedFor(w.bob);
    await shared.open(w.circle);
    await shared.selectPerson(w.annId);
    await shared.selectCategory('health');
    await w.ann.sharing.setGrant(w.circle, w.bob.id, []);
    await shared.selectItem('both');
    expect(shared.getState()).toMatchObject({ item: { status: 'gone', error: 'Not found: it may no longer be shared with you.' }, people: { items: [] } });
    const nobody = sharedFor(w.cat);
    await nobody.open(w.circle);
    expect(nobody.getState()).toMatchObject({ status: 'loaded', people: { items: [] } });
    await nobody.selectPerson(w.annId);
    expect(nobody.getState()).toMatchObject({ view: 'people', message: 'Nothing is shared with you by that person.' });
  });

  it('a private category and an item reachable only through it read as gone, like a made-up one', async () => {
    const w = await world();
    await w.ann.sharing.setGrant(w.circle, w.bob.id, ['health']);
    const shared = sharedFor(w.bob);
    await shared.open(w.circle);
    await shared.selectPerson(w.annId);
    await shared.selectCategory('secret');
    const secret = shared.getState().category;
    shared.back();
    await shared.selectCategory('made-up');
    expect({ ...shared.getState().category, id: 'secret' }).toEqual(secret);
    shared.back();
    await shared.selectItem('hidden');
    expect(shared.getState().item).toMatchObject({ status: 'gone' });
  });
});
