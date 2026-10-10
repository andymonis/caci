import { describe, expect, it } from 'vitest';
import { fakePage, waitFor } from './fake-page.test-util.mjs';
import { mount } from './mount.js';
import { ODD_CATEGORY, SECRET, world } from './sharing-world.test-util.mjs';

// The whole sharing journey through the pages' own code against the real service: real SQLite files, real
// HTTP, real sessions. Each person has their own page (built from the real index.html) on their own cookie jar.

function browser(person, hash) {
  const page = fakePage();
  let current = hash;
  const listeners = [];
  const env = { getHash: () => current, setHash: (h) => { current = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  mount(page.document, person.fetch, env);
  return { page, go: (h) => env.setHash(h), hash: () => current };
}
const el = (b, id) => b.page.el(id);
const rows = (b, id) => el(b, id).children;
const slot = (row, name) => row.querySelector(`[data-slot="${name}"]`);
const click = (b, id) => el(b, id).fire('click');
const allText = (b) => b.page.ids.map((id) => b.page.el(id).textContent ?? '').join('\n');
const shareRow = (b, userId) => rows(b, 'share-list').find((r) => r.getAttribute('data-user') === userId);
const choices = (row) => [...slot(row, 'choices').children];
const label = (li) => slot(li, 'label').textContent;
const box = (li) => slot(li, 'box');

async function circlePage(person, circle) {
  const b = browser(person, `#/circles/${circle}`);
  await waitFor(() => !el(b, 'circle-body').hidden || !el(b, 'circle-gone').hidden);
  return b;
}

describe('sharing through the pages, against the real service', () => {
  it('ann shares two categories with bob; bob reads exactly those; narrowing, stopping and leaving take effect on his next look; a stranger reads nothing', async () => {
    const w = await world();
    const ann = await circlePage(w.ann, w.circle);
    const bob = await circlePage(w.bob, w.circle);
    const cat = await circlePage(w.cat, w.circle);
    const dan = await circlePage(w.dan, w.circle);
    const seenByOthers = () => [bob, cat, dan].map(allText).join('\n');

    // nothing is requested until the button is pressed; the other members are listed, not ann herself
    expect(el(ann, 'share-load').hidden).toBe(false);
    click(ann, 'share-load');
    await waitFor(() => rows(ann, 'share-list').length === 2);
    expect(rows(ann, 'share-list').map((r) => slot(r, 'name').textContent).sort()).toEqual(['Display bob', 'Display cat']);
    expect(rows(ann, 'share-list').every((r) => slot(r, 'meta').textContent === 'Nothing shared')).toBe(true);

    // she chooses health and the odd one for bob (the picker lists her own categories, the private one included)
    slot(shareRow(ann, w.bob.id), 'change').fire('click');
    await waitFor(() => choices(shareRow(ann, w.bob.id)).length === 3);
    expect(choices(shareRow(ann, w.bob.id)).map(label).sort()).toEqual(['Health <i>x</i>', 'Odd', SECRET].sort());
    const tick = (name) => box(choices(shareRow(ann, w.bob.id)).find((li) => label(li) === name)).fire('change');
    tick('Health <i>x</i>');
    tick('Odd');
    slot(shareRow(ann, w.bob.id), 'save').fire('click');
    await waitFor(() => el(ann, 'share-notice').textContent === 'Now sharing 2 categories with Display bob.');
    expect(slot(shareRow(ann, w.bob.id), 'meta').textContent).toBe('Sharing 2 categories: Odd, Health <i>x</i>');
    expect(slot(shareRow(ann, w.bob.id), 'name').children).toEqual([]);

    // bob presses the button: ann has shared two categories
    click(bob, 'shared-load');
    await waitFor(() => rows(bob, 'shared-people-list').length === 1);
    expect(slot(rows(bob, 'shared-people-list')[0], 'meta').textContent).toBe('2 categories shared');
    slot(rows(bob, 'shared-people-list')[0], 'open').fire('click');
    await waitFor(() => rows(bob, 'shared-categories-list').length === 2);
    expect(el(bob, 'shared-readonly').textContent).toContain('Read-only');
    expect(rows(bob, 'shared-categories-list').map((r) => slot(r, 'name').textContent).sort()).toEqual(['Health <i>x</i>', 'Odd']);
    const healthRow = rows(bob, 'shared-categories-list').find((r) => slot(r, 'name').textContent === 'Health <i>x</i>');
    expect(slot(healthRow, 'name').children).toEqual([]);
    slot(healthRow, 'open').fire('click');
    await waitFor(() => rows(bob, 'shared-items-list').length === 1);
    expect(slot(rows(bob, 'shared-items-list')[0], 'title').textContent).toBe('Dentist');
    slot(rows(bob, 'shared-items-list')[0], 'open').fire('click');
    await waitFor(() => rows(bob, 'shared-item-categories').length === 1);
    expect(el(bob, 'shared-item-heading').textContent).toBe('Dentist');
    expect(slot(rows(bob, 'shared-item-categories')[0], 'name').textContent).toBe('Health <i>x</i>'); // the private category it is also filed under is not there
    expect(allText(bob)).not.toContain(SECRET);

    // cat has been given nothing; dan is not in the circle
    click(cat, 'shared-load');
    await waitFor(() => !el(cat, 'shared-empty').hidden);
    expect(el(cat, 'shared-empty').textContent).toBe('Nobody has shared anything with you in this circle.');
    expect(el(dan, 'circle-gone').hidden).toBe(false);
    expect(el(dan, 'circle-gone').textContent).toBe('No such circle, or you are not in it.');

    // ann narrows to the odd one; bob, still looking at the item, is told it is no longer shared
    slot(shareRow(ann, w.bob.id), 'change').fire('click');
    await waitFor(() => choices(shareRow(ann, w.bob.id)).length === 3);
    tick('Health <i>x</i>');
    slot(shareRow(ann, w.bob.id), 'save').fire('click');
    await waitFor(() => el(ann, 'share-notice').textContent === 'Now sharing 1 category with Display bob.');
    click(bob, 'shared-item-back');
    await waitFor(() => !el(bob, 'shared-category').hidden);
    slot(rows(bob, 'shared-items-list')[0], 'open').fire('click');
    await waitFor(() => !el(bob, 'shared-item-error').hidden);
    expect(el(bob, 'shared-item-error').textContent).toBe('Not found: it may no longer be shared with you.');
    expect(rows(bob, 'shared-item-data')).toHaveLength(0);

    // ann stops sharing after a question; bob refreshes and sees nobody
    slot(shareRow(ann, w.bob.id), 'stop').fire('click');
    expect(slot(shareRow(ann, w.bob.id), 'stopAsk').hidden).toBe(false);
    slot(shareRow(ann, w.bob.id), 'stopYes').fire('click');
    await waitFor(() => el(ann, 'share-notice').textContent === 'Stopped sharing with Display bob.');
    bob.go('#/circles');
    await waitFor(() => !el(bob, 'view-circles').hidden);
    bob.go(`#/circles/${w.circle}`);
    await waitFor(() => !el(bob, 'circle-body').hidden);
    click(bob, 'shared-load');
    await waitFor(() => !el(bob, 'shared-empty').hidden);

    // sharing again, then bob leaves: ann's list no longer has him, and nothing comes back if he rejoins
    await w.ann.sharing.setGrant(w.circle, w.bob.id, [ODD_CATEGORY]);
    expect((await w.bob.circles.leaveCircle(w.circle)).ok).toBe(true);
    ann.go('#/circles');
    await waitFor(() => !el(ann, 'view-circles').hidden);
    ann.go(`#/circles/${w.circle}`);
    await waitFor(() => !el(ann, 'circle-body').hidden);
    click(ann, 'share-load');
    await waitFor(() => rows(ann, 'share-list').length === 1);
    expect(slot(rows(ann, 'share-list')[0], 'name').textContent).toBe('Display cat');
    const gone = await circlePage(w.bob, w.circle);
    expect(el(gone, 'circle-gone').textContent).toBe('No such circle, or you are not in it.');

    // the private category's name never reached anyone else's page
    expect(seenByOthers()).not.toContain(SECRET);
    expect(seenByOthers()).not.toContain('hidden');
  });
});
