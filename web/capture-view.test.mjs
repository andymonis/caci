import { describe, expect, it } from 'vitest';
import { circleNotice, countText, expiresText, formatTime, MODE_LOADING, MODE_UNKNOWN, MODE_WORDS, modeNotice, noteLines, opText, outcomeText, PERSONAL_NOTICE, previewNotice, problemLines, readOnlyLine, REJECTED_WORDS, replaceLines, scopeLine, scopeNotice, withWait, writtenText } from './capture-view.js';

const SUMMARY = (extra = {}) => ({ newItems: [], updatedItems: [], newCategories: [], updatedCategories: [], reusedCategories: [], newLinks: [], problems: [], notes: [], ...extra });

describe('which model files the note', () => {
  it('says each mode in the words the spec gives', () => {
    expect(MODE_WORDS.demo).toBe('Filed by the free demo model: nothing leaves this machine.');
    expect(MODE_WORDS.anthropic).toBe("Filed by Anthropic's model: your note and the names of your categories are sent to Anthropic and are not anonymised.");
    expect(modeNotice({ status: 'known', value: 'demo' })).toBe(MODE_WORDS.demo);
    expect(modeNotice({ status: 'known', value: 'anthropic' })).toBe(MODE_WORDS.anthropic);
  });
  it('says it could not tell when the mode is not known, failed, or is not one of the two', () => {
    for (const mode of [{ status: 'error', value: 'demo' }, { status: 'unknown', value: 'anthropic' }, { status: 'unknown', value: null }, { status: 'error', value: null }, { status: 'known', value: 'other' }, { status: 'known', value: '__proto__' }, { status: 'known', value: 'toString' }, undefined, null, {}]) expect(modeNotice(mode), JSON.stringify(mode)).toBe(MODE_UNKNOWN);
    expect(modeNotice({ status: 'loading', value: null })).toBe(MODE_LOADING);
    expect(MODE_UNKNOWN).toBe('Could not tell which model files your notes.');
  });
  it('the preview uses the mode the proposal carries', () => {
    expect(previewNotice({ mode: 'demo' })).toBe(MODE_WORDS.demo);
    expect(previewNotice({ mode: 'anthropic' })).toBe(MODE_WORDS.anthropic);
    for (const p of [{ mode: 'x' }, { mode: 'toString' }, {}, null, undefined]) expect(previewNotice(p)).toBe(MODE_UNKNOWN);
  });
});

describe('numbers and times', () => {
  it('the count', () => {
    expect(countText(0)).toBe('0 / 8,000');
    expect(countText(1234)).toBe('1,234 / 8,000');
    for (const bad of [-5, NaN, 1.5, '5', undefined, null]) expect(countText(bad), String(bad)).toBe('0 / 8,000');
  });
  it('times are UTC to the minute, or nothing', () => {
    expect(formatTime(Date.UTC(2026, 9, 9, 14, 5, 59))).toBe('2026-10-09 14:05 UTC');
    expect(formatTime(0)).toBe('1970-01-01 00:00 UTC');
    for (const bad of [-1, NaN, 1.5, '5', null]) expect(formatTime(bad), String(bad)).toBe('');
    expect(expiresText(Date.UTC(2026, 9, 9, 14, 5))).toBe('Expires 2026-10-09 14:05 UTC. After that it is forgotten and nothing is written.');
    expect(expiresText(-1)).toBe('');
  });
});

describe('operations and what was written', () => {
  it('each operation in words, with the title or name when there is one', () => {
    expect(opText({ op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 'Blood test', summary: 'S' } })).toBe('Add or update item note-1 "Blood test"');
    expect(opText({ op: 'upsertNode', partition: 'category', id: 'health', data: { name: 'Health' } })).toBe('Add or update category health "Health"');
    expect(opText({ op: 'upsertNode', partition: 'item', id: 'x' })).toBe('Add or update item x');
    expect(opText({ op: 'upsertNode', partition: 'item', id: 'x', data: { title: '' } })).toBe('Add or update item x');
    expect(opText({ op: 'upsertNode', partition: 'item', id: 'x', data: { title: 5 } })).toBe('Add or update item x');
    expect(opText({ op: 'upsertNode', partition: 'category', id: 'x', data: { title: '', name: 'N' } })).toBe('Add or update category x "N"');
    expect(opText({ op: 'link', item: 'note-1', category: 'health', weight: 0.9 })).toBe('Link item note-1 to category health (weight 0.9)');
    expect(opText({ op: 'link', item: 'a', category: 'b' })).toBe('Link item a to category b');
    expect(opText({ op: 'upsertNode', partition: 'item', id: '<b>x</b>', data: { title: '<i>t</i>' } })).toBe('Add or update item <b>x</b> "<i>t</i>"');
  });
  it('problems and notes are labelled', () => {
    const s = SUMMARY({ problems: ['link to missing category'], notes: ['a repeat'] });
    expect(problemLines(s)).toEqual(['Problem: link to missing category']);
    expect(noteLines(s)).toEqual(['Note: a repeat']);
    expect(problemLines(SUMMARY())).toEqual([]);
  });
  it('what was written, counted', () => {
    expect(writtenText({ applied: 3, summary: SUMMARY({ newItems: ['a'], newCategories: ['b'], newLinks: [{ item: 'a', category: 'b' }] }) })).toBe('Written: 3 operations (1 new item, 1 new category, 1 link).');
    expect(writtenText({ applied: 1, summary: SUMMARY() })).toBe('Written: 1 operation.');
    expect(writtenText({ applied: 5, summary: SUMMARY({ newItems: ['a', 'b'], updatedItems: ['c'], updatedCategories: ['d', 'e'], reusedCategories: ['f'], newLinks: [{ item: 'a', category: 'f' }, { item: 'b', category: 'f' }] }) })).toBe('Written: 5 operations (2 new items, 1 updated item, 2 updated categories, 1 category reused, 2 links).');
    expect(writtenText({ applied: 2, summary: SUMMARY({ newCategories: ['a', 'b'], reusedCategories: ['c', 'd'] }) })).toBe('Written: 2 operations (2 new categories, 2 categories reused).');
  });
  it('the sentence for each outcome', () => {
    expect(outcomeText({ kind: 'rejected' })).toBe(REJECTED_WORDS);
    expect(REJECTED_WORDS).toBe('Rejected. Nothing was written.');
    expect(outcomeText({ kind: 'written', applied: 1, summary: SUMMARY() })).toBe('Written: 1 operation.');
    expect(outcomeText({ kind: 'expired', message: 'Gone or expired.' })).toBe('Gone or expired.');
    expect(outcomeText({ kind: 'gone', message: '' })).toBe('That proposal is gone or has expired. Make it again.');
    expect(outcomeText({ kind: 'gone' })).toBe('That proposal is gone or has expired. Make it again.');
  });
  it('a refusal gets the wait when the service gave one', () => {
    expect(withWait('Too many.', 30)).toBe('Too many. Try again in 30 seconds.');
    expect(withWait('Too many.', 1)).toBe('Too many. Try again in 1 second.');
    for (const bad of [undefined, 0, -1, 1.5, '5', NaN]) expect(withWait('Too many.', bad), String(bad)).toBe('Too many.');
  });
});

describe('what a person is told before a note goes into a circle', () => {
  it('names the circle, says who will see it and that it cannot be taken back, and (only for the real model) where it goes', async () => {
    const { circleNotice, PERSONAL_NOTICE } = await import('./capture-view.js');
    expect(circleNotice('Parent', 'demo')).toBe('This note will be added to the circle "Parent". Everyone in the circle can read it, and it cannot be taken back once approved.');
    expect(circleNotice('Parent', 'anthropic')).toBe('This note will be added to the circle "Parent". Everyone in the circle can read it, and it cannot be taken back once approved. The note and the names of the circle\'s categories are sent to Anthropic and are not anonymised.');
    expect(circleNotice('Parent', undefined)).toBe(circleNotice('Parent', 'demo'));
    expect(circleNotice('', 'demo')).toContain('this circle');
    expect(circleNotice(undefined, 'demo')).toContain('this circle');
    expect(PERSONAL_NOTICE).toBe('This note will be added to your own notes. Only you can read it.');
  });
});

describe('where a note goes (R-009)', () => {
  const circle = { kind: 'circle', circleId: 'c0123456789abcdef', circleName: 'Club' };
  it('says where a proposal goes, falling back to words when the name is missing', () => {
    expect(scopeLine({ kind: 'personal' })).toBe('Goes to your own notes.');
    expect(scopeLine(undefined)).toBe('Goes to your own notes.');
    expect(scopeLine(circle)).toBe('Goes to the circle "Club".');
    expect(scopeLine({ kind: 'circle', circleId: circle.circleId })).toBe('Goes to the circle "this circle".');
    expect(scopeLine({ ...circle, circleName: '' })).toBe('Goes to the circle "this circle".');
  });
  it('gives each scope its own notice', () => {
    expect(scopeNotice({ kind: 'personal' }, 'anthropic')).toBe(PERSONAL_NOTICE);
    expect(scopeNotice(undefined, 'demo')).toBe(PERSONAL_NOTICE);
    expect(scopeNotice(circle, 'demo')).toBe(circleNotice('Club', 'demo'));
    expect(scopeNotice(circle, 'anthropic')).toBe(circleNotice('Club', 'anthropic'));
  });
  it('names the circles that can only be read, and says nothing when there are none', () => {
    const rows = [
      { scope: { kind: 'personal' }, label: 'My own notes', canCapture: true },
      { scope: circle, label: 'Club', canCapture: true },
      { scope: { kind: 'circle', circleId: 'cabcdefghij012345' }, label: 'Read', canCapture: false },
      { scope: { kind: 'circle', circleId: 'cabcdefghij012346' }, label: 'Other', canCapture: false },
    ];
    expect(readOnlyLine(rows)).toBe('You can read, but not add notes to: "Read", "Other".');
    expect(readOnlyLine(rows.slice(0, 2))).toBe('');
    expect(readOnlyLine([])).toBe('');
    expect(readOnlyLine([{ scope: { kind: 'personal' }, label: 'My own notes', canCapture: false }])).toBe('');
    expect(readOnlyLine([{ scope: circle, label: 'Club', canCapture: undefined }])).toBe('');
  });
  it('adds the circle to a written outcome and nothing for the own notes', () => {
    const summary = { newItems: ['a'], updatedItems: [], newCategories: [], updatedCategories: [], reusedCategories: [], newLinks: [] };
    expect(outcomeText({ kind: 'written', applied: 1, summary, scope: circle })).toBe('Written: 1 operation (1 new item). Added to the circle "Club".');
    expect(outcomeText({ kind: 'written', applied: 1, summary, scope: { kind: 'personal' } })).toBe('Written: 1 operation (1 new item).');
    expect(outcomeText({ kind: 'written', applied: 1, summary })).toBe('Written: 1 operation (1 new item).');
    expect(outcomeText({ kind: 'written', applied: 1, summary, scope: { kind: 'circle', circleId: circle.circleId } })).toContain('"this circle"');
  });
});

describe('replacing and removing (R-014)', () => {
  it('opText names a removal', () => {
    expect(opText({ op: 'deleteNode', partition: 'item', id: 'note-0' })).toBe('Remove note note-0');
    expect(opText({ op: 'deleteNode', partition: 'category', id: 'old' })).toBe('Remove category old');
  });
  it('replaceLines says what is replaced, with the title, else the id, and nothing when nothing is', () => {
    expect(replaceLines(SUMMARY())).toEqual([]);
    expect(replaceLines(SUMMARY({ removed: [] }))).toEqual([]);
    expect(replaceLines(SUMMARY({ removed: [{ id: 'n0', title: 'Tablet A', summary: '2 x daily' }, { id: 'n1', title: '', summary: '' }] }))).toEqual([
      'This note replaces: Tablet A (2 x daily). The old note will be removed when you approve.',
      'This note replaces: n1. The old note will be removed when you approve.',
    ]);
  });
  it('writtenText adds what was removed', () => {
    const removed = [{ id: 'a', title: 'A', summary: '' }];
    expect(writtenText({ applied: 4, summary: SUMMARY({ newItems: ['n'], removed }), tidied: [{ id: 'c' }] })).toBe('Written: 4 operations (1 new item, removed 1 old note and 1 empty category).');
    expect(writtenText({ applied: 2, summary: SUMMARY({ removed }) })).toBe('Written: 2 operations (removed 1 old note).');
    expect(writtenText({ applied: 3, summary: SUMMARY({ removed: [...removed, ...removed] }), tidied: [{ id: 'c' }, { id: 'd' }] })).toBe('Written: 3 operations (removed 2 old notes and 2 empty categories).');
    expect(writtenText({ applied: 1, summary: SUMMARY(), tidied: [{ id: 'c' }] })).toBe('Written: 1 operation (removed 1 empty category).');
    expect(writtenText({ applied: 1, summary: SUMMARY() })).toBe('Written: 1 operation.');
  });
});
