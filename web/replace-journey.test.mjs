import { describe, expect, it } from 'vitest';
import { fakePage, waitFor } from './fake-page.test-util.mjs';
import { mount } from './mount.js';
import { world } from './sharing-world.test-util.mjs';

// A new fact replacing an old one (R-014) through the capture page against the real service: real SQLite files, real HTTP,
// the free demo model. The preview says what will be removed, nothing changes until Approve, and the outcome says what went.

function browser(person, hash) {
  const page = fakePage();
  let current = hash;
  const listeners = [];
  const env = { getHash: () => current, setHash: (h) => { current = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  mount(page.document, person.fetch, env);
  return { page, go: (h) => env.setHash(h) };
}
const el = (b, id) => b.page.el(id);
const lineTexts = (b, id) => el(b, id).children.map((row) => row.querySelector('[data-slot="text"]').textContent);

async function propose(b, text) {
  el(b, 'capture-note').value = text;
  el(b, 'capture-form').fire('submit');
  await waitFor(() => !el(b, 'capture-preview').hidden);
}

describe('a new fact replaces the old one, through the capture page', () => {
  it('previews the removal, changes nothing until approved, then the old note is gone and the outcome says so', async () => {
    const w = await world();
    const ann = browser(w.ann, '#/capture');
    await waitFor(() => !el(ann, 'view-capture').hidden && !el(ann, 'capture-submit').disabled);

    const start = (await w.ann.notes.mineSummary()).value;
    await propose(ann, 'Mum takes Tablet A twice a day with food');
    expect(lineTexts(ann, 'capture-lines').filter((l) => l.startsWith('This note replaces'))).toEqual([]);
    el(ann, 'capture-approve').fire('click');
    await waitFor(() => !el(ann, 'capture-outcome').hidden);
    expect(el(ann, 'capture-outcome-text').textContent).not.toContain('removed');

    const countItems = async () => (await w.ann.notes.mineSummary()).value;
    const afterFirst = (await countItems());
    const before = JSON.stringify(afterFirst);

    el(ann, 'capture-again').fire('click');
    await propose(ann, 'Change: Mum takes Tablet A once a day with food now');
    const replaces = lineTexts(ann, 'capture-lines').filter((l) => l.startsWith('This note replaces'));
    expect(replaces).toHaveLength(1);
    expect(replaces[0]).toContain('The old note will be removed when you approve.');
    expect(lineTexts(ann, 'capture-ops').some((l) => l.startsWith('Remove note '))).toBe(true);
    expect(JSON.stringify(await countItems())).toBe(before); // nothing written by the preview

    el(ann, 'capture-approve').fire('click');
    await waitFor(() => !el(ann, 'capture-outcome').hidden);
    expect(el(ann, 'capture-outcome-text').textContent).toMatch(/removed 1 old note/);

    const after = (await w.ann.notes.mineSummary()).value;
    // the first capture added one note; the second replaced it, so the total did not grow
    expect(after.itemCount).toBe(afterFirst.itemCount);
    expect(afterFirst.itemCount).toBe(start.itemCount + 1);
  });

  it('the change-log screen shows the replacement: what was removed, said in full, and who made the change', async () => {
    const w = await world();
    const ann = browser(w.ann, '#/capture');
    await waitFor(() => !el(ann, 'view-capture').hidden && !el(ann, 'capture-submit').disabled);
    await propose(ann, 'Mum takes Tablet A twice a day with food');
    el(ann, 'capture-approve').fire('click');
    await waitFor(() => !el(ann, 'capture-outcome').hidden);
    el(ann, 'capture-again').fire('click');
    await propose(ann, 'Change: Mum takes Tablet A once a day with food now');
    el(ann, 'capture-approve').fire('click');
    await waitFor(() => !el(ann, 'capture-outcome').hidden);

    const bob = browser(w.bob, '#/ledger');
    await waitFor(() => !el(bob, 'ledger-empty').hidden);
    expect(lineTexts(bob, 'ledger-list')).toEqual([]); // bob's own log is empty: nothing of ann's is shown to him
    expect(el(bob, 'ledger-empty').hidden).toBe(false);

    ann.go('#/ledger');
    await waitFor(() => !el(ann, 'view-ledger').hidden && el(ann, 'ledger-list').children.length > 0);
    const lines = lineTexts(ann, 'ledger-list');
    expect(lines.some((l) => l.includes('· Display ann · removed note ·') && l.includes('twice a day'))).toBe(true);
    expect(lines.filter((l) => l.includes('added note'))).toHaveLength(2);
    expect(lines.every((l) => l.includes('· Display ann ·'))).toBe(true);
    expect(el(ann, 'ledger-notice').textContent).toContain('review log');
    expect(ann.page.focused().id).toBe('ledger-heading');
  });

  it('a profile note becomes separate facts, and changing the phone number replaces only the phone fact', async () => {
    const w = await world();
    const ann = browser(w.ann, '#/capture');
    await waitFor(() => !el(ann, 'view-capture').hidden && !el(ann, 'capture-submit').disabled);
    await propose(ann, 'Mum: born 4 June 1950, phone 07700 900123, email mum@example.test.');
    const first = lineTexts(ann, 'capture-lines');
    expect(first[0]).toBe('This note adds 3 facts:');
    expect(first.slice(1, 4).join(' | ')).toContain('4 June 1950');
    expect(first.slice(1, 4).join(' | ')).toContain('07700 900123');
    expect(first.slice(1, 4).join(' | ')).toContain('mum@example.test');
    el(ann, 'capture-approve').fire('click');
    await waitFor(() => !el(ann, 'capture-outcome').hidden);

    const titles = async () => {
      const out = [];
      for (const c of (await w.ann.notes.categories()).value.items) for (const i of (await w.ann.notes.categoryItems(c.id)).value.items) out.push(`${i.data.title}|${i.data.summary}`);
      return [...new Set(out)].sort();
    };
    const before = await titles();
    expect(before.filter((t) => t.includes('Mum:'))).toHaveLength(3);

    el(ann, 'capture-again').fire('click');
    await propose(ann, "Mum's new phone number: 07700 900456.");
    const replaces = lineTexts(ann, 'capture-lines').filter((l) => l.startsWith('This note replaces'));
    expect(replaces).toHaveLength(1);
    expect(replaces[0]).toContain('07700 900123');
    expect(lineTexts(ann, 'capture-lines').some((l) => l.startsWith('This note adds'))).toBe(false);
    el(ann, 'capture-approve').fire('click');
    await waitFor(() => !el(ann, 'capture-outcome').hidden);
    expect(el(ann, 'capture-outcome-text').textContent).toMatch(/removed 1 old note/);

    const after = (await titles()).join('\n');
    expect(after).toContain('4 June 1950');
    expect(after).toContain('mum@example.test');
    expect(after).toContain('07700 900456');
    expect(after).not.toContain('07700 900123');

    const log = (await w.ann.ledger.list(undefined)).value.items.map((e) => `${e.action} ${e.kind} ${e.title ?? ''}`);
    expect(log.filter((l) => l.startsWith('added item')).length).toBe(4);
    expect(log.filter((l) => l.startsWith('removed item'))).toHaveLength(1);
    expect(log.find((l) => l.startsWith('removed item'))).toContain('07700 900123');
  });
});
