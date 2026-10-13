import { describe, expect, it } from 'vitest';
import { fakePage, waitFor } from './fake-page.test-util.mjs';
import { mount } from './mount.js';
import { world } from './sharing-world.test-util.mjs';

// Status updates through the pages' own code against the real service (R-011): real SQLite files, real HTTP,
// real sessions, the free demo model. Each person has their own page (built from the real index.html) on their
// own cookie jar. ann owns Club and Neighbours; bob and cat are members of Club; bob is only an observer of
// Neighbours; dan is in no circle.

function browser(person, hash) {
  const page = fakePage();
  let current = hash;
  const listeners = [];
  const env = { getHash: () => current, setHash: (h) => { current = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  mount(page.document, person.fetch, env);
  return { page, go: (h) => env.setHash(h) };
}
const el = (b, id) => b.page.el(id);
const points = (b) => el(b, 'status-points').children.map((row) => row.querySelector('[data-slot="text"]').textContent);

async function ask(b, text) {
  el(b, 'status-request').value = text;
  el(b, 'status-form').fire('submit');
  await waitFor(() => !el(b, 'status-answer').hidden && !el(b, 'status-submit').disabled && el(b, 'status-meta').textContent !== '');
}
const file = async (who, text, circleId) => {
  const made = await who.notes.propose(text, circleId === undefined ? undefined : { kind: 'circle', circleId });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  expect((await who.notes.approve(made.value.id)).ok).toBe(true);
};

describe('status updates through the pages, against the real service', () => {
  it('the notice comes first, the answer names its sources, observers can ask, nothing is written, and a removal takes effect on the next ask', async () => {
    const w = await world();
    const club = w.circle;
    const neighbours = (await w.ann.circles.createCircle({ name: 'Neighbours' })).value.id;
    for (const [name, role] of [['bob', 'observer'], ['cat', 'member']]) {
      await w.ann.circles.invite(neighbours, { username: name, role });
      const invitation = (await w[name].circles.myInvitations()).value.items.find((i) => i.circle.id === neighbours).id;
      expect((await w[name].circles.acceptInvitation(invitation)).ok).toBe(true);
    }
    await file(w.ann, 'Mum new tablets one a day with food MARK-CLUB', club);
    await file(w.cat, 'Bin collection moved to Thursday MARK-NEIGH', neighbours);
    await file(w.cat, 'Dentist appointment on Friday morning MARK-CAT');
    await file(w.dan, 'Holiday plan in Spain MARK-DAN');

    const before = JSON.stringify([(await w.cat.notes.mineSummary()).value, (await w.dan.notes.mineSummary()).value]);

    // the notice, what is sent and the suggestions are on the page before anything is asked
    const cat = browser(w.cat, '#/');
    cat.go('#/status');
    await waitFor(() => !el(cat, 'view-status').hidden && !el(cat, 'status-submit').disabled);
    expect(el(cat, 'status-mode-notice').textContent).toBe('Answered by the free demo model: nothing leaves this machine.');
    expect(el(cat, 'status-context-notice').textContent).toContain('everything you can read');
    expect(el(cat, 'status-answer').hidden).toBe(true);
    el(cat, 'status-suggest-0').fire('click');
    expect(el(cat, 'status-request').value).toBe('Give me a morning status check');
    await ask(cat, el(cat, 'status-request').value);
    const text = points(cat).join('\n');
    expect(text).toContain('MARK-CLUB');
    expect(text).toContain('MARK-NEIGH');
    expect(text).toContain('MARK-CAT');
    expect(text).not.toContain('MARK-DAN');
    expect(points(cat).find((p) => p.includes('MARK-CLUB'))).toMatch(/\(From: "Club"\)$/);
    expect(points(cat).find((p) => p.includes('MARK-NEIGH'))).toMatch(/\(From: "Neighbours"\)$/);
    expect(points(cat).find((p) => p.includes('MARK-CAT'))).toMatch(/\(From: your own notes\)$/);
    expect(el(cat, 'status-meta').textContent).toMatch(/^Based on 3 notes\. Made \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/);
    expect(el(cat, 'status-not-saved').textContent).toContain('not saved anywhere');

    // an observer of Neighbours can ask, and reads Club too as a member; a stranger sees only his own
    const bob = browser(w.bob, '#/status');
    await waitFor(() => !el(bob, 'view-status').hidden && !el(bob, 'status-submit').disabled);
    await ask(bob, 'I am heading into town');
    const bobText = points(bob).join('\n');
    expect(bobText).toContain('MARK-NEIGH');
    expect(bobText).toContain('MARK-CLUB');
    expect(bobText).not.toContain('MARK-CAT');
    expect(bobText).not.toContain('MARK-DAN');
    const dan = browser(w.dan, '#/status');
    await waitFor(() => !el(dan, 'view-status').hidden && !el(dan, 'status-submit').disabled);
    await ask(dan, 'status');
    expect(points(dan).join('\n')).toContain('MARK-DAN');
    for (const m of ['MARK-CLUB', 'MARK-NEIGH', 'MARK-CAT']) expect(points(dan).join('\n')).not.toContain(m);

    // nothing was written anywhere by any of it
    expect(JSON.stringify([(await w.cat.notes.mineSummary()).value, (await w.dan.notes.mineSummary()).value])).toBe(before);

    // removal: bob is taken out of Club and his next answer lacks it
    expect((await w.ann.circles.removeMember(club, w.bob.id)).ok).toBe(true);
    await ask(bob, 'again');
    expect(points(bob).join('\n')).not.toContain('MARK-CLUB');
    expect(points(bob).join('\n')).toContain('MARK-NEIGH');

    // leaving the screen forgets the answer and the typed request
    cat.go('#/circles');
    await waitFor(() => !el(cat, 'view-circles').hidden);
    expect(el(cat, 'status-answer').hidden).toBe(true);
    expect(el(cat, 'status-request').value).toBe('');
    expect(points(cat)).toEqual([]);
  });

  it('a person with no notes is told nothing relevant was found, and markup in a note stays text', async () => {
    const w = await world();
    const hostile = '<img src=x onerror=alert(1)> Dentist appointment';
    await file(w.cat, hostile);
    const dan = browser(w.dan, '#/status');
    await waitFor(() => !el(dan, 'view-status').hidden && !el(dan, 'status-submit').disabled);
    await ask(dan, 'status please');
    expect(el(dan, 'status-nothing').hidden).toBe(false);
    expect(el(dan, 'status-nothing').textContent).toBe('Nothing relevant was found in what you can read.');
    const cat = browser(w.cat, '#/status');
    await waitFor(() => !el(cat, 'view-status').hidden && !el(cat, 'status-submit').disabled);
    await ask(cat, 'Dentist');
    expect(points(cat).join('\n')).toContain(hostile);
    expect(el(cat, 'status-points').children[0].children.every((c) => String(c.tagName).toLowerCase() === 'span')).toBe(true);
  });
});
