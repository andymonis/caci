import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createGraph, write, type JsonObject } from '../graph_store/index.js';
import { madeAt, rankCandidates, readCandidates, wordsOf } from './candidates.js';
import { recordAdapter } from './recording-adapter.test-util.js';

const item = (id: string, title: string, summary = ''): { id: string; data: JsonObject } => ({ id, data: { title, summary } });
const ids = (c: ReadonlyArray<{ id: string }>): string[] => c.map((x) => x.id);

describe('wordsOf', () => {
  it('lower-cases, makes numbers digits, drops plurals, common words and single letters', () => {
    expect([...wordsOf('Mum takes TWO times Tablet A a day')].sort()).toEqual(['2', 'day', 'mum', 'tablet', 'take', 'time'].sort());
    expect(wordsOf('The cat and the hat').has('the')).toBe(false);
    expect([...wordsOf('1 x Tablet B')].sort()).toEqual(['1', 'tablet']);
    expect([...wordsOf('Tablets, tablet; TABLET!')]).toEqual(['tablet']);
    expect(wordsOf('boss ass')).toEqual(new Set(['boss', 'ass']));
    expect(wordsOf('')).toEqual(new Set());
    expect(wordsOf('日本語 の ノート')).toContain('日本語');
    expect(wordsOf('2 × 3')).toEqual(new Set(['2', '3']));
  });
  it('a plural is cut only from words of four letters or more', () => {
    expect(wordsOf('bus')).toEqual(new Set(['bus']));
    expect(wordsOf('buses')).toEqual(new Set(['buse']));
    expect(wordsOf('cats')).toEqual(new Set(['cat']));
  });
});

describe('rankCandidates', () => {
  const items = [
    item('note-a', 'Mum: 2 x Tablet A', 'Mum takes 2 x Tablet A a day for her blood pressure.'),
    item('note-b', 'Bought bread', 'Bread and milk from the shop.'),
    item('note-c', 'Dentist', 'Dentist appointment on Friday.'),
    item('note-d', 'Mum: blood pressure', 'Mum has a blood pressure check in March.'),
  ];
  it('finds the old dose for the note that changes it, best match first', () => {
    const found = rankCandidates('Mum now takes 1 x Tablet B a day.', items);
    expect(ids(found)).toEqual(['note-a', 'note-d']);
    expect(found[0]).toEqual({ id: 'note-a', title: 'Mum: 2 x Tablet A', summary: 'Mum takes 2 x Tablet A a day for her blood pressure.' });
  });
  it('never returns an item that shares no word', () => {
    expect(ids(rankCandidates('Plumber coming on Tuesday', items))).toEqual([]);
    expect(rankCandidates('the and of', items)).toEqual([]);
    expect(rankCandidates('', items)).toEqual([]);
    expect(rankCandidates('Mum', [])).toEqual([]);
  });
  it('ties go to the newest, then to the lower id', () => {
    const minted = (ms: number, tail: string): string => `note-${ms.toString(36).padStart(9, '0')}-00-${tail}`;
    const old = minted(Date.UTC(2026, 0, 1), 'aaaaaa');
    const newer = minted(Date.UTC(2026, 5, 1), 'bbbbbb');
    const same1 = minted(Date.UTC(2026, 5, 1), 'aaaaaa');
    const found = rankCandidates('garden', [item(old, 'garden'), item(newer, 'garden'), item(same1, 'garden'), item('zzz', 'garden'), item('aaa', 'garden')]);
    expect(ids(found)).toEqual([same1, newer, old, 'aaa', 'zzz']);
  });
  it('a circle item is dated by contributedAt', () => {
    const a = { id: 'x1', data: { title: 'garden', contributedAt: 5000 } as JsonObject };
    const b = { id: 'x2', data: { title: 'garden', contributedAt: 9000 } as JsonObject };
    expect(ids(rankCandidates('garden', [a, b]))).toEqual(['x2', 'x1']);
    expect(madeAt('x1', { contributedAt: 5000 })).toBe(5000);
    expect(madeAt('plain', undefined)).toBe(0);
    expect(madeAt('note-000000001-00-aaaaaa', undefined)).toBe(0);
    expect(madeAt('note-' + Date.UTC(2026, 0, 1).toString(36).padStart(9, '0') + '-00-aaaaaa', undefined)).toBe(Date.UTC(2026, 0, 1));
    expect(madeAt('x', { contributedAt: -5 })).toBe(0);
  });
  it('more shared words beat newer', () => {
    const found = rankCandidates('garden shed roof', [{ id: 'new', data: { title: 'garden', contributedAt: 9000 } }, { id: 'old', data: { title: 'garden shed roof', contributedAt: 1000 } }]);
    expect(ids(found)).toEqual(['old', 'new']);
  });
  it('returns at most maxCandidates (12 by default)', () => {
    const many = Array.from({ length: 20 }, (_, i) => item(`n${String(i).padStart(2, '0')}`, 'garden'));
    expect(rankCandidates('garden', many)).toHaveLength(12);
    expect(rankCandidates('garden', many, { maxCandidates: 3 })).toHaveLength(3);
    expect(rankCandidates('garden', many, { maxCandidates: 0 })).toEqual([]);
  });
  it('stops at the first that does not fit the character budget, counting title and summary by character', () => {
    const big = [item('a', 'garden', 'x'.repeat(200)), item('b', 'garden', 'y'.repeat(200)), item('c', 'garden', 'z')];
    expect(ids(rankCandidates('garden', big, { maxChars: 450 }))).toEqual(['a', 'b', 'c']);
    expect(ids(rankCandidates('garden', big, { maxChars: 419 }))).toEqual(['a', 'b', 'c']);
    expect(ids(rankCandidates('garden', big, { maxChars: 418 }))).toEqual(['a', 'b']);
    expect(ids(rankCandidates('garden', big, { maxChars: 412 }))).toEqual(['a', 'b']);
    expect(ids(rankCandidates('garden', big, { maxChars: 411 }))).toEqual(['a']);
    expect(ids(rankCandidates('garden', big, { maxChars: 205 }))).toEqual([]);
    expect(rankCandidates('garden', [item('e', '😀'.repeat(60), '😀 garden')], { maxChars: 68 })).toHaveLength(1);
    expect(rankCandidates('garden', [item('e', '😀'.repeat(60), '😀 garden')], { maxChars: 67 })).toHaveLength(0);
  });
  it('cuts title to 100 and summary to 300 characters by character and joins white space', () => {
    const [c] = rankCandidates('garden', [item('a', `garden ${'😀'.repeat(150)}`, `line\n\nbreak ${'😀'.repeat(400)}`)]);
    expect([...(c?.title as string)]).toHaveLength(100);
    expect([...(c?.summary as string)]).toHaveLength(300);
    expect(c?.summary.startsWith('line break ')).toBe(true);
  });
  it('items without text data are never candidates; non-text values are ignored; who made it is not matched', () => {
    const found = rankCandidates('garden', [{ id: 'a' }, { id: 'b', data: { count: 5 } as JsonObject }, { id: 'c', data: { contributedBy: 'garden' } as JsonObject }, { id: 'd', data: { note: 'garden' } as JsonObject }]);
    expect(ids(found)).toEqual(['d']);
    expect(found[0]).toEqual({ id: 'd', title: '', summary: '' });
  });
  it('a number stored as a number is not text and is not matched', () => {
    expect(rankCandidates('5', [{ id: 'a', data: { count: 5 } as JsonObject }])).toEqual([]);
    expect(ids(rankCandidates('5', [{ id: 'a', data: { count: 5, note: 'room 5' } as JsonObject }]))).toEqual(['a']);
  });
  it('a time of 0 in contributedAt is not a time; the minted id is used', () => {
    const minted = `note-${Date.UTC(2026, 3, 1).toString(36).padStart(9, '0')}-00-aaaaaa`;
    expect(madeAt(minted, { contributedAt: 0 })).toBe(Date.UTC(2026, 3, 1));
    expect(madeAt(minted, { contributedAt: 1 })).toBe(1);
  });
  it('awkward ids and text come back exactly', () => {
    const weird = 'a/b?c=d&e#f %é😀<b>..';
    expect(ids(rankCandidates('garden', [item(weird, 'garden <b>shed</b>')]))).toEqual([weird]);
  });
  it('does not change the items it is given', () => {
    const copy = JSON.stringify(items);
    rankCandidates('Mum tablet', items);
    expect(JSON.stringify(items)).toBe(copy);
  });
  it('ranks 5,000 items quickly', () => {
    const many = Array.from({ length: 5000 }, (_, i) => item(`n${i}`, `note ${i} about topic${i % 50}`, 'some words here'));
    const started = Date.now();
    const found = rankCandidates('topic7 note', many);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(found).toHaveLength(12);
  });
});

describe('readCandidates', () => {
  async function graphWith(graphId: string, rows: Array<{ id: string; data: JsonObject }>): Promise<ReturnType<typeof createMemoryAdapter>> {
    const adapter = createMemoryAdapter();
    expect((await createGraph(adapter, graphId)).ok).toBe(true);
    for (let i = 0; i < rows.length; i += 400) {
      const ops = rows.slice(i, i + 400).map((r) => ({ op: 'upsertNode' as const, partition: 'item' as const, id: r.id, data: r.data }));
      const w = await write(adapter, { version: 1, kind: 'mutation', graphId, ops }, { limits: { maxOps: 1000 } });
      expect(w.ok).toBe(true);
    }
    return adapter;
  }

  it('reads one graph and finds the old dose', async () => {
    const adapter = await graphWith('user-u1', [item('n1', 'Mum: 2 x Tablet A', 'a day'), item('n2', 'Bread', 'milk')]);
    const r = await readCandidates(adapter, 'user-u1', 'Mum now takes 1 x Tablet B a day');
    expect(r.ok && ids(r.value)).toEqual(['n1']);
  });
  it('reads only the graph it is given, and calls no write primitive', async () => {
    const a = await graphWith('user-u1', [item('n1', 'garden')]);
    expect((await createGraph(a, 'user-u2')).ok).toBe(true);
    await write(a, { version: 1, kind: 'mutation', graphId: 'user-u2', ops: [{ op: 'upsertNode', partition: 'item', id: 'secret', data: { title: 'garden' } }] });
    const rec = recordAdapter(a);
    const r = await readCandidates(rec.adapter, 'user-u1', 'garden');
    expect(r.ok && ids(r.value)).toEqual(['n1']);
    expect(rec.writes).toEqual([]);
    expect(rec.calls.length).toBeGreaterThan(0);
  });
  it('reads items over several pages, up to maxRead, and categories are never candidates', async () => {
    const rows = Array.from({ length: 1300 }, (_, i) => item(`n${String(i).padStart(4, '0')}`, i === 1250 ? 'zebra crossing' : 'filler'));
    const adapter = await graphWith('user-u1', rows);
    await write(adapter, { version: 1, kind: 'mutation', graphId: 'user-u1', ops: [{ op: 'upsertNode', partition: 'category', id: 'zebra', data: { name: 'zebra' } }] });
    const found = await readCandidates(adapter, 'user-u1', 'zebra');
    expect(found.ok && ids(found.value)).toEqual(['n1250']);
    const limited = await readCandidates(adapter, 'user-u1', 'zebra', { maxRead: 1000 });
    expect(limited.ok && ids(limited.value)).toEqual([]);
    const exact = await readCandidates(adapter, 'user-u1', 'zebra', { maxRead: 1251 });
    expect(exact.ok && ids(exact.value)).toEqual(['n1250']);
  });
  it('a missing graph is the graph store\'s error', async () => {
    const r = await readCandidates(createMemoryAdapter(), 'user-nope', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('GRAPH_NOT_FOUND');
  });
  it('an empty graph has no candidates', async () => {
    const adapter = await graphWith('user-u1', []);
    const r = await readCandidates(adapter, 'user-u1', 'anything here');
    expect(r.ok && r.value).toEqual([]);
  });
});

describe('keys (R-015)', () => {
  const fact = (id: string, key: string | undefined, title: string, summary: string) => ({ id, data: { title, summary, ...(key === undefined ? {} : { key }) } });
  it('a fact whose whole key is in the note comes first, even when another shares more words', () => {
    const items = [
      fact('wordy', undefined, 'Mum phone call routine', 'Mum likes a phone call on Sunday about the number of visitors'),
      fact('phone', 'mum / phone number', 'Mum: phone', '07700 900123'),
    ];
    expect(rankCandidates('Mum has a new phone number 07700 900456, call on Sunday about the number of visitors', items).map((c) => c.id)).toEqual(['phone', 'wordy']);
  });
  it('a key with a word that is not in the note is not a hit (it only ranks by shared words)', () => {
    const items = [fact('dob', 'mum / date of birth', 'Mum: born', '4 June'), fact('other', undefined, 'Mum note', 'phone number mum')];
    expect(rankCandidates('Mum phone number', items).map((c) => c.id)).toEqual(['other', 'dob']);
  });
  it('the candidate carries its key, cut to 80 characters, and an item without one has no key field', () => {
    const [a, b] = rankCandidates('mum phone', [fact('a', 'mum phone', 'T', 'S'), fact('b', undefined, 'mum phone', 'S')]);
    expect(a).toEqual({ id: 'a', title: 'T', summary: 'S', key: 'mum phone' });
    expect(b).toEqual({ id: 'b', title: 'mum phone', summary: 'S' });
    expect('key' in (b ?? {})).toBe(false);
    const long = rankCandidates('kkkk', [fact('c', `kkkk ${'k'.repeat(100)}`, 't', 's')])[0];
    expect([...(long?.key ?? '')]).toHaveLength(80);
  });
  it('the key counts toward the character budget', () => {
    const items = [fact('a', 'aa bb', 'xx', 'yy'), fact('b', 'aa bb', 'xx', 'yy')];
    expect(rankCandidates('aa bb', items, { maxChars: 9 })).toHaveLength(1); // 2 + 2 + 5 each
    expect(rankCandidates('aa bb', items, { maxChars: 18 })).toHaveLength(2);
  });
  it('an item without a stored key is still matched by words, as before', () => {
    expect(rankCandidates('garden party', [fact('old', undefined, 'Garden party', 'on Friday')]).map((c) => c.id)).toEqual(['old']);
  });
});
