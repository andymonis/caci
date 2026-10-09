import { describe, expect, it } from 'vitest';
import { categoryRow, dataEntries, EMPTY_BRAIN, itemCategoryRow, itemRow, MORE_CATEGORIES, SHORTENED } from './brain-view.js';

describe('a category row', () => {
  it('shows its name and how many items, singular and plural', () => {
    expect(categoryRow({ id: 'c1', name: 'Health', itemCount: 3 })).toEqual({ name: 'Health', count: '3 items', label: 'Open the category Health, 3 items' });
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
    expect(itemRow({ id: 'i', data: { title: 'T', summary: 'S' } })).toEqual({ title: 'T', summary: 'S', shortened: '', label: 'Open the item T' });
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
    expect(itemCategoryRow({ id: 'c', name: 'Health', weight: 0.9 })).toEqual({ name: 'Health', weight: 'weight 0.9', label: 'Open the category Health' });
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
