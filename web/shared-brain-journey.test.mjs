import { describe, expect, it } from 'vitest';
import { fakePage, waitFor } from './fake-page.test-util.mjs';
import { mount } from './mount.js';
import { world } from './sharing-world.test-util.mjs';

// The shared circle brain through the pages' own code against the real service (R-009): real SQLite files, real
// HTTP, real sessions. Each person has their own page (built from the real index.html) on their own cookie jar.
// ann owns Club and Neighbours; bob and cat are members of Club; bob is only an observer of Neighbours.

function browser(person, hash) {
  const page = fakePage();
  let current = hash;
  const listeners = [];
  const env = { getHash: () => current, setHash: (h) => { current = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  mount(page.document, person.fetch, env);
  return { page, go: (h) => env.setHash(h) };
}
const el = (b, id) => b.page.el(id);
const rows = (b, id) => el(b, id).children;
const slot = (row, name) => row.querySelector(`[data-slot="${name}"]`);
const pick = async (b, select, key) => {
  el(b, select).value = key;
  el(b, select).fire('change');
  await waitFor(() => !el(b, select).disabled);
};
const optionsOf = (b, select) => el(b, select).children.map((o) => o.textContent);
const keyOf = (b, select, label) => el(b, select).children.find((o) => o.textContent === label)?.value;
const settled = (b) => waitFor(() => !el(b, 'brain-refresh').disabled);

async function capture(b, label, note) {
  b.go('#/capture');
  await waitFor(() => !el(b, 'view-capture').hidden && !el(b, 'capture-submit').disabled);
  await waitFor(() => keyOf(b, 'capture-scope', label) !== undefined);
  await pick(b, 'capture-scope', keyOf(b, 'capture-scope', label));
  el(b, 'capture-note').value = note;
  el(b, 'capture-form').fire('submit');
  await waitFor(() => !el(b, 'capture-preview').hidden);
  const preview = { scope: el(b, 'capture-preview-scope').textContent, notice: el(b, 'capture-preview-scope-notice').textContent };
  el(b, 'capture-approve').fire('click');
  await waitFor(() => !el(b, 'capture-outcome').hidden);
  return { preview, outcome: el(b, 'capture-outcome-text').textContent };
}
async function brainOf(b, label) {
  b.go('#/brain');
  await waitFor(() => !el(b, 'view-brain').hidden);
  await waitFor(() => keyOf(b, 'brain-scope', label) !== undefined);
  await pick(b, 'brain-scope', keyOf(b, 'brain-scope', label));
  await settled(b);
  return rows(b, 'brain-categories-list').map((r) => [slot(r, 'name').textContent, slot(r, 'where').textContent]);
}

describe('the shared circle brain through the pages, against the real service', () => {
  it('capture into two circles, browse each and My Brain with provenance, an observer reads but cannot capture, and removal takes effect', async () => {
    const w = await world();
    const club = w.circle;
    const neighbours = (await w.ann.circles.createCircle({ name: 'Neighbours' })).value.id;
    for (const [name, role] of [['bob', 'observer'], ['cat', 'member']]) {
      await w.ann.circles.invite(neighbours, { username: name, role });
      const invitation = (await w[name].circles.myInvitations()).value.items.find((i) => i.circle.id === neighbours).id;
      expect((await w[name].circles.acceptInvitation(invitation)).ok).toBe(true);
    }
    const ann = browser(w.ann, '#/capture');
    const bob = browser(w.bob, '#/capture');
    const cat = browser(w.cat, '#/capture');
    const dan = browser(w.dan, '#/brain');

    // the notices come before and on the preview, and the circle is named
    const made = await capture(cat, 'Club', 'Dentist appointment on Friday morning');
    const said = 'This note will be added to the circle "Club". Everyone in the circle can read it, and it cannot be taken back once approved.';
    expect(made.preview).toEqual({ scope: 'Goes to the circle "Club".', notice: said });
    expect(made.outcome).toMatch(/^Written: 3 operations .* Added to the circle "Club"\.$/);
    expect(el(cat, 'capture-scope-notice').textContent).toBe(said);

    // the same words into the other circle make the same ids in a second scope
    const second = await capture(ann, 'Neighbours', 'Dentist appointment on Friday morning');
    expect(second.preview.scope).toBe('Goes to the circle "Neighbours".');
    const mine = await capture(ann, 'My own notes', 'Dentist appointment on Friday morning');
    expect(mine.outcome).not.toContain('circle');

    // an observer is offered no way to capture into the circle she only reads, and is told so
    bob.go('#/capture');
    await waitFor(() => optionsOf(bob, 'capture-scope').includes('Club'));
    expect(optionsOf(bob, 'capture-scope')).toEqual(['My own notes', 'Club']);
    expect(el(bob, 'capture-scope-readonly').textContent).toBe('You can read, but not add notes to: "Neighbours".');
    expect((await w.bob.notes.propose('a sneaky note', { kind: 'circle', circleId: neighbours })).error).toMatchObject({ kind: 'not-found', what: 'circle' });

    // each circle shows only its notes, marked with the circle; identical ids in two circles stay two rows in My Brain
    const inClub = await brainOf(ann, 'Club');
    expect(inClub.length).toBeGreaterThan(0);
    expect(inClub.every(([, where]) => where === 'Circle "Club"')).toBe(true);
    const inNeighbours = await brainOf(ann, 'Neighbours');
    expect(inNeighbours.every(([, where]) => where === 'Circle "Neighbours"')).toBe(true);
    const all = await brainOf(ann, 'My Brain (my notes and my circles together)');
    expect(all.filter(([, where]) => where === 'My own notes').length).toBeGreaterThan(0);
    const sameName = all.filter(([name]) => inClub.some(([n]) => n === name) && inNeighbours.some(([n]) => n === name));
    // the same words made the same category in her own notes too: three rows, told apart only by where they are
    expect(sameName.map(([, where]) => where).sort()).toEqual(['Circle "Club"', 'Circle "Neighbours"', 'My own notes']);
    expect(all.length).toBe(new Set(all.map((r) => r.join('|'))).size);

    // opening the Neighbours row opens that circle's category, with that circle's name on every level
    const row = rows(ann, 'brain-categories-list').find((r) => slot(r, 'name').textContent === sameName[0][0] && slot(r, 'where').textContent === 'Circle "Neighbours"');
    slot(row, 'open').fire('click');
    await waitFor(() => !el(ann, 'brain-category').hidden && rows(ann, 'brain-items-list').length > 0);
    expect(el(ann, 'brain-category-where').textContent).toBe('Circle "Neighbours"');
    expect(rows(ann, 'brain-items-list').every((r) => slot(r, 'where').textContent === 'Circle "Neighbours"')).toBe(true);

    // the observer reads Neighbours, sees no capture link, and is told why
    const observed = await brainOf(bob, 'Neighbours');
    expect(observed.length).toBeGreaterThan(0);
    expect(el(bob, 'brain-capture-link').hidden).toBe(true);
    expect(el(bob, 'brain-scope-hint').textContent).toContain('You can read it, but not add notes to it.');

    // a stranger is offered neither circle and cannot ask for them
    await waitFor(() => !el(dan, 'view-brain').hidden && !el(dan, 'brain-refresh').disabled);
    expect(optionsOf(dan, 'brain-scope')).toEqual(['My Brain (my notes and my circles together)', 'My own notes']);
    expect((await w.dan.notes.categoriesIn({ kind: 'circle', circleId: club })).error).toMatchObject({ kind: 'not-found', what: 'circle' });

    // removal takes effect on the next look: cat is taken out of Club, her view reads as gone, and Club keeps her note (D3)
    await brainOf(cat, 'Club');
    expect((await w.ann.circles.removeMember(club, w.cat.id)).ok).toBe(true);
    el(cat, 'brain-refresh').fire('click');
    await waitFor(() => !el(cat, 'brain-gone').hidden);
    expect(el(cat, 'brain-gone-hint').textContent).toBe('No such circle, or you are not in it. Showing your own notes instead.');
    await waitFor(() => el(cat, 'brain-scope').value === 'personal' && !el(cat, 'brain-refresh').disabled);
    expect(optionsOf(cat, 'brain-scope')).not.toContain('Club');
    expect((await brainOf(ann, 'Club')).length).toBe(inClub.length);
    // and she can no longer capture into it
    expect((await w.cat.notes.propose('after removal', { kind: 'circle', circleId: club })).error).toMatchObject({ kind: 'not-found', what: 'circle' });
  });
});
