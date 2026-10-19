import { describe, expect, it } from 'vitest';
import { entryText, ledgerScopeHint, NO_ONE } from './ledger-view.js';

const AT = Date.UTC(2026, 9, 14, 9, 30);
const base = { at: AT, action: 'removed', kind: 'item', subject: 's1', by: { username: 'a', displayName: 'Ann' } };

describe('the words on the change-log screen', () => {
  it('writes an entry on one line: time, who, what happened, and what it said', () => {
    expect(entryText({ ...base, title: 'Tablet A', summary: '2 x daily' })).toBe('2026-10-14 09:30 UTC · Ann · removed note · "Tablet A" — 2 x daily');
    expect(entryText({ ...base, action: 'added', kind: 'category', title: 'Health' })).toBe('2026-10-14 09:30 UTC · Ann · added category · "Health"');
  });
  it('falls back to the id when there is no title, and keeps a summary without one', () => {
    expect(entryText(base)).toBe('2026-10-14 09:30 UTC · Ann · removed note · "s1"');
    expect(entryText({ ...base, summary: 'only this' })).toBe('2026-10-14 09:30 UTC · Ann · removed note · "s1" — only this');
  });
  it('names nobody who cannot be named, and says so when the time is not one', () => {
    expect(entryText({ ...base, by: undefined })).toContain(`· ${NO_ONE} ·`);
    expect(entryText({ ...base, by: { username: 'x', displayName: '' } })).toContain(`· ${NO_ONE} ·`);
    expect(entryText({ ...base, at: Number.NaN })).toMatch(/^Unknown time · /);
  });
  it('an unknown kind reads as an item, and nothing odd throws', () => {
    expect(entryText({ ...base, kind: 'toString' })).toContain('removed item');
    expect(entryText({ at: 'x', action: 5 })).toBe('Unknown time · someone who has since left ·  item · ""');
  });
  it('says whose log it is', () => {
    const scopes = [{ key: 'personal', label: 'My own notes', scope: { kind: 'personal' } }, { key: 'circle:c1', label: 'Club', scope: { kind: 'circle', circleId: 'c1' } }];
    expect(ledgerScopeHint('personal', scopes)).toBe('Showing the changes to your own notes.');
    expect(ledgerScopeHint('circle:c1', scopes)).toBe('Showing the changes to the circle "Club", made by its members.');
    expect(ledgerScopeHint('circle:zz', scopes)).toBe('Showing the changes to your own notes.');
  });
});
