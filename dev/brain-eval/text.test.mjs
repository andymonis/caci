import { describe, expect, it } from 'vitest';
import { containsPhrase, hasPhrase, meetsGroups, normalise, tokens } from './text.mjs';

describe('normalise', () => {
  it('lower-cases, drops punctuation and hyphens, and collapses spaces', () => {
    expect(normalise('  Dr. Patel -- Tuesday!  ')).toBe('dr patel tuesday');
    expect(normalise('well-being\tcheck')).toBe('well being check');
  });
  it('writes numbers as digits and the many ways of saying "times" one way', () => {
    expect(normalise('two Tablet A a day')).toBe('2 tablet a a day');
    for (const text of ['2x Tablet A', '2 x Tablet A', '2 X Tablet A', '2 × Tablet A', 'two times Tablet A', '2 times Tablet A', 'Two x tablet a']) expect(normalise(text), text).toBe('2 x tablet a');
  });
  it('leaves other words alone, including words that contain number words or an x', () => {
    expect(normalise('Someone fixed the box')).toBe('someone fixed the box');
    expect(normalise('bones and stones')).toBe('bones and stones');
    expect(normalise('3 sixes')).toBe('3 sixes');
  });
  it('keeps letters from other scripts and digits', () => {
    expect(normalise('Café Zoë 12:30')).toBe('café zoë 12 30');
  });
  it('is stable on text that is not text', () => {
    expect(normalise(undefined)).toBe('undefined');
    expect(normalise('')).toBe('');
  });
});

describe('tokens', () => {
  it('removes a trailing plural s from longer words only, never from "ss" words', () => {
    expect(tokens('tablets days glass is bus')).toEqual(['tablet', 'day', 'glass', 'is', 'bus']);
  });
  it('an empty text has no tokens', () => expect(tokens('  !! ')).toEqual([]));
});

describe('matching a phrase', () => {
  it('needs the words one after another, on whole words', () => {
    expect(hasPhrase('Mum takes 1 x Tablet B each day', '1 x tablet b')).toBe(true);
    expect(hasPhrase('Mum takes Tablet A and Tablet B', 'tablet a tablet b')).toBe(false);
    expect(hasPhrase('the tablets are on the shelf', 'tablet')).toBe(true);
    expect(hasPhrase('Tablet Bonus pack', 'tablet b')).toBe(false); // "b" is not "bonus"
    expect(hasPhrase('cat', 'at')).toBe(false);
  });
  it('the same fact in different wordings is one phrase', () => {
    for (const text of ['Now 1x Tablet B a day.', 'one times tablet-b daily? no: 1 x Tablet B a day', 'she should take 1 × Tablet B']) expect(hasPhrase(text, '1 x Tablet B'), text).toBe(true);
    expect(hasPhrase('2 x Tablet A', '1 x Tablet B')).toBe(false);
  });
  it('an empty phrase never matches, and a phrase longer than the text does not', () => {
    expect(containsPhrase(['a', 'b'], [])).toBe(false);
    expect(containsPhrase(['a'], ['a', 'b'])).toBe(false);
    expect(containsPhrase([], ['a'])).toBe(false);
  });
  it('finds a phrase at the start, middle and end, and after a partial match', () => {
    expect(containsPhrase(['a', 'b', 'c'], ['a', 'b'])).toBe(true);
    expect(containsPhrase(['a', 'b', 'c'], ['b', 'c'])).toBe(true);
    expect(containsPhrase(['a', 'a', 'b'], ['a', 'b'])).toBe(true);
    expect(containsPhrase(['a', 'b', 'a'], ['a', 'b', 'c'])).toBe(false);
  });
});

describe('meetsGroups', () => {
  it('every group needs one of its alternatives', () => {
    const groups = [['tablet b', 'tablet-b'], ['morning']];
    expect(meetsGroups('Tablet B in the morning', groups)).toBe(true);
    expect(meetsGroups('Tablet B at night', groups)).toBe(false);
    expect(meetsGroups('in the morning', groups)).toBe(false);
    expect(meetsGroups('anything', [])).toBe(true);
    expect(meetsGroups('Tablet B', [['tablet b', 'tablet z']])).toBe(true);
    expect(meetsGroups('Tablet B', [['tablet y', 'tablet z']])).toBe(false);
  });
});
