import { describe, expect, it } from 'vitest';
import { categoryRow, dataEntries, EMPTY_BRAIN, emptyText, itemCategoryRow, itemRow, MORE_CATEGORIES, NO_CIRCLE_WAYS, scopeHint, SHORTENED, whereText } from './brain-view.js';

describe('a category row', () => {
  it('shows its name and how many items, singular and plural', () => {
    expect(categoryRow({ id: 'c1', name: 'Health', itemCount: 3 })).toEqual({ name: 'Health', count: '3 items', where: '', label: 'Open the category Health, 3 items' });
    expect(categoryRow({ id: 'c1', name: 'Health', itemCount: 1 }).count).toBe('1 item');
    expect(categoryRow({ id: 'c1', name: 'Health', itemCount: 0 }).count).toBe('0 items');
    expect(categoryRow({ id: 'c1', name: 'Health', itemCount: 12345 }).count).toBe('12,345 items');
  });
  it('says "at least" when the count was capped', () => {
    expect(categoryRow({ id: 'c1', itemCount: 9999, itemCountCapped: true })).toMatchObject({ count: 'at least 9,999 items' });
    expect(categoryRow({ id: 'c1', itemCount: 9999, itemCountCapped: false }).count).toBe('9,999 items');
  });
  it('uses the id when there is no name, and keeps markup as text', () => {
    expect(categoryRow({ id: 'a/b?c', itemCount: 1 }).name).toBe('a/b?c');
    expect(categoryRow({ id: 'c', name: '', itemCount: 1 }).name).toBe('c');
    expect(categoryRow({ id: 'c', name: 5, itemCount: 1 }).name).toBe('c');
    expect(categoryRow({ id: 'c', name: '<b>x</b>', itemCount: 1 }).name).toBe('<b>x</b>');
  });
});

describe('an item row', () => {
  it('shows the title and summary, falling back to the name and then the id', () => {
    expect(itemRow({ id: 'i', data: { title: 'T', summary: 'S' } })).toEqual({ title: 'T', summary: 'S', shortened: '', where: '', label: 'Open the item T' });
    expect(itemRow({ id: 'i', data: { name: 'N' } }).title).toBe('N');
    expect(itemRow({ id: 'i', data: { title: '', name: 'N' } }).title).toBe('N');
    expect(itemRow({ id: 'i', data: {} }).title).toBe('i');
    expect(itemRow({ id: 'i', data: { title: 5, summary: 5 } })).toMatchObject({ title: 'i', summary: '' });
    expect(itemRow({ id: 'i' })).toMatchObject({ title: 'i', summary: '' });
    expect(itemRow({ id: 'i', data: null }).title).toBe('i');
  });
  it('marks shortened data', () => {
    expect(itemRow({ id: 'i', data: {}, dataTruncated: true }).shortened).toBe(SHORTENED);
    expect(itemRow({ id: 'i', data: {}, dataTruncated: false }).shortened).toBe('');
    expect(SHORTENED).toBe('Some of this was shortened because it was long.');
  });
});

describe('the data of one item', () => {
  it('is key and value in order, text as it is and anything else as JSON', () => {
    expect(dataEntries({ title: 'T', n: 5, list: [1, 'a'], nested: { a: 1 }, no: null, yes: true })).toEqual([
      { key: 'title', value: 'T' }, { key: 'n', value: '5' }, { key: 'list', value: '[1,"a"]' }, { key: 'nested', value: '{"a":1}' }, { key: 'no', value: 'null' }, { key: 'yes', value: 'true' },
    ]);
    expect(dataEntries({ x: '<img src=x onerror=alert(1)>' })).toEqual([{ key: 'x', value: '<img src=x onerror=alert(1)>' }]);
  });
  it('is nothing for no data', () => {
    for (const bad of [undefined, null, 5, 'x']) expect(dataEntries(bad)).toEqual([]);
    expect(dataEntries({})).toEqual([]);
  });
  it('entries are frozen', () => {
    expect(Object.isFrozen(dataEntries({ a: 1 })[0])).toBe(true);
  });
});

describe('a category an item is filed under', () => {
  it('shows the name (or id) and the weight', () => {
    expect(itemCategoryRow({ id: 'c', name: 'Health', weight: 0.9 })).toEqual({ name: 'Health', weight: 'weight 0.9', where: '', label: 'Open the category Health' });
    expect(itemCategoryRow({ id: 'c', weight: 1 }).name).toBe('c');
    expect(itemCategoryRow({ id: 'c', name: '', weight: 1 }).name).toBe('c');
  });
});

describe('fixed words', () => {
  it('say what they should', () => {
    expect(EMPTY_BRAIN).toContain('Capture a note and approve it');
    expect(MORE_CATEGORIES).toBe('This item is filed under more categories than are shown here.');
  });
});

describe('where a result is (R-009)', () => {
  it('names the own notes or the circle, and an unnamed circle as unnamed', () => {
    expect(whereText({ kind: 'personal' })).toBe('My own notes');
    expect(whereText(undefined)).toBe('My own notes');
    expect(whereText({ kind: 'circle', circleId: 'c0123456789abcdef', circleName: 'Club' })).toBe('Circle "Club"');
    expect(whereText({ kind: 'circle', circleId: 'c0123456789abcdef' })).toBe('Circle "unnamed"');
    expect(whereText({ kind: 'circle', circleId: 'c0123456789abcdef', circleName: '' })).toBe('Circle "unnamed"');
  });
  it('puts where a result is into the label of each row, and nothing when it is not known', () => {
    expect(categoryRow({ id: 'c', name: 'N', itemCount: 1 }, 'Circle "Club"')).toMatchObject({ where: 'Circle "Club"', label: 'Open the category N, 1 item, from Circle "Club"' });
    expect(itemRow({ id: 'i', data: { title: 'T' } }, 'Circle "Club"')).toMatchObject({ where: 'Circle "Club"', label: 'Open the item T, from Circle "Club"' });
    expect(itemCategoryRow({ id: 'c', name: 'N', weight: 1 }, 'Circle "Club"')).toMatchObject({ where: 'Circle "Club"', label: 'Open the category N, from Circle "Club"' });
    expect(categoryRow({ id: 'c', name: 'N', itemCount: 1 }, '').label).toBe('Open the category N, 1 item');
    expect(itemRow({ id: 'i', data: { title: 'T' } }, '').label).toBe('Open the item T');
  });
  it('does not tell a reader to capture into a circle she cannot add to', () => {
    const scopes = [
      { key: 'circle:c1', label: 'Club', scope: { kind: 'circle', circleId: 'c1' }, canCapture: true },
      { key: 'circle:c2', label: 'Read', scope: { kind: 'circle', circleId: 'c2' }, canCapture: false },
    ];
    expect(emptyText('circle:c2', scopes)).toBe('Nothing has been filed in this circle yet.');
    expect(emptyText('circle:c1', scopes)).toBe(EMPTY_BRAIN);
    expect(emptyText('personal', scopes)).toBe(EMPTY_BRAIN);
    expect(emptyText('mine', scopes)).toBe(EMPTY_BRAIN);
  });
  it('says what is being shown, and that a circle cannot be added to when it cannot', () => {
    const scopes = [
      { key: 'personal', label: 'My own notes', scope: { kind: 'personal' }, canCapture: true },
      { key: 'circle:c1', label: 'Club', scope: { kind: 'circle', circleId: 'c1' }, canCapture: true },
      { key: 'circle:c2', label: 'Read', scope: { kind: 'circle', circleId: 'c2' }, canCapture: false },
    ];
    expect(scopeHint('personal', scopes)).toBe('Showing only your own notes.');
    expect(scopeHint('mine', scopes)).toBe('My Brain shows your own notes and the notes of every circle you are in. Each one says where it is.');
    expect(scopeHint('circle:c1', scopes)).toBe('Showing the circle "Club": the notes added by its members.');
    expect(scopeHint('circle:c2', scopes)).toBe('Showing the circle "Read": the notes added by its members. You can read it, but not add notes to it.');
    expect(scopeHint('circle:gone', scopes)).toBe('Showing only your own notes.');
    expect(NO_CIRCLE_WAYS).toBe('You can go back to your own notes.');
  });
});
