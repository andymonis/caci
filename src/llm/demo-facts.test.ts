import { describe, expect, it } from 'vitest';
import { demoReply, splitFacts } from './demo-client.js';
import { createDemoModelClient } from './demo-client.js';
import { createLlm, type ExistingNote } from './index.js';
import { SHIPPED_CONTROLS } from './testing/shipped-controls.test-util.js';

// The demo model splits a note into facts and keys them (R-015 D12). A stand-in, not a reader.

const llm = createLlm({ controls: SHIPPED_CONTROLS, client: createDemoModelClient() });
const base = { graphId: 'notes', itemId: 'note-1', categories: [] };
const file = async (text: string, existing?: readonly ExistingNote[]) => {
  const r = await llm.categorise({ ...base, text, ...(existing === undefined ? {} : { existing }) });
  if (!r.ok) throw new Error(`categorise failed: ${JSON.stringify(r.error)}`);
  return r.value;
};
const itemsOf = (p: Awaited<ReturnType<typeof file>>) => p.mutation.ops.filter((o) => o.op === 'upsertNode' && o.partition === 'item').map((o) => (o.op === 'upsertNode' ? { id: o.id, ...(o.data as Record<string, string>) } : { id: '' }) as { id: string; key?: string; title?: string });

describe('splitFacts', () => {
  it('splits sentences and ; clauses', () => {
    expect(splitFacts('Booked the dentist for Friday. Bought bread; milk is low', 8).map((f) => f.text)).toEqual(['Booked the dentist for Friday.', 'Bought bread', 'milk is low']);
  });
  it('splits "Subject: part, part, part" into one fact per part, each keeping the subject', () => {
    const f = splitFacts('Mum: born 4 June 1950, phone 07700 900123, and email mum@example.test.', 8);
    expect(f.map((x) => x.text)).toEqual(['Mum: born 4 June 1950', 'Mum: phone 07700 900123', 'Mum: email mum@example.test']);
    expect(f.map((x) => x.key)).toEqual(['mum / born june', 'mum / phone 07700', 'mum / email mum']);
  });
  it('splits "Label: value, Label: value" into one fact per pair', () => {
    expect(splitFacts('Name: Ann Hand, DoB: 4 June, Phone: 0770', 8).map((x) => x.text)).toEqual(['Name: Ann Hand', 'DoB: 4 June', 'Phone: 0770']);
  });
  it('an ordinary sentence with commas stays one fact', () => {
    expect(splitFacts('GP prescribed Mum 2 x Tablet A a day for her blood pressure, with breakfast.', 8)).toHaveLength(1);
  });
  it('merges anything beyond the maximum into the last fact; and a note with nothing to split is one fact', () => {
    const f = splitFacts('One thing here. Two things here. Three things here. Four things here.', 2);
    expect(f.map((x) => x.text)).toEqual(['One thing here.', 'Two things here. Three things here. Four things here.']);
    expect(splitFacts('!!', 8).map((x) => x.text)).toEqual(['!!']);
  });
  it('drops fragments shorter than three characters', () => {
    expect(splitFacts('Bought bread. A. Milk is low.', 8).map((f) => f.text)).toEqual(['Bought bread.', 'Milk is low.']);
  });
  it('cuts a very long fact', () => {
    expect([...(splitFacts('x'.repeat(2000), 8)[0]?.text ?? '')]).toHaveLength(400);
  });
});

describe('the demo model files facts', () => {
  it('a profile note becomes three facts with minted ids, a key each, and a link each, accepted by the real guard', async () => {
    const p = await file('Mum: born 4 June 1950, phone 07700 900123, email mum@example.test.');
    const items = itemsOf(p);
    expect(items.map((i) => i.id)).toEqual(['note-1', 'note-1-2', 'note-1-3']);
    expect(items.every((i) => typeof i.key === 'string' && i.key !== '')).toBe(true);
    expect(p.mutation.ops.filter((o) => o.op === 'link').map((o) => (o.op === 'link' ? o.item : ''))).toEqual(['note-1', 'note-1-2', 'note-1-3']);
    expect(p.attempts).toBe(1);
  });
  it('with only one fact allowed (the meta says so) the reply is today\'s: one item, no key', () => {
    const reply = demoReply({ model: 'x', messages: [{ role: 'user', content: '<categories>\n</categories>\n<note>\nMum: born 4 June, phone 0770.\n</note>' }], maxOutputTokens: 1, timeoutMs: 1, meta: { capability: 'categorise', itemId: 'n1', maxFacts: 1 } });
    const items = (reply?.ops as Array<Record<string, unknown>>).filter((o) => o.op === 'upsertNode' && o.partition === 'item');
    expect(items).toHaveLength(1);
    expect(items[0]?.data).not.toHaveProperty('key');
  });
  it('a changed phone number replaces only the phone fact and reuses its key', async () => {
    const existing: ExistingNote[] = [
      { title: 'Mum: born 4 June 1950', summary: 'Mum: born 4 June 1950', key: 'mum / born june' },
      { title: 'Mum: phone 07700 900123', summary: 'Mum: phone 07700 900123', key: 'mum / phone 07700' },
      { title: 'Mum: email mum@example.test', summary: 'Mum: email mum@example.test', key: 'mum / email mum' },
    ];
    const p = await file("Mum's new phone number: 07700 900456 phone.", existing);
    expect(p.replaces).toEqual([2]);
    expect(itemsOf(p)[0]?.key).toBe('mum / phone 07700');
  });
  it('an existing fact whose whole key is in the fact beats one that only shares more words', async () => {
    const existing: ExistingNote[] = [
      { title: 'Mum call routine', summary: 'Mum phone call on Sunday about number of visitors', key: 'routine' },
      { title: 'Mum', summary: 'x', key: 'mum phone' },
    ];
    const p = await file('Mum new phone number 0770, call on Sunday about number of visitors', existing);
    expect(p.replaces).toEqual([2]);
  });
  it('without maxFacts in the meta the demo makes one item, and with maxFacts 1 it never adds a key even when one matches', () => {
    const content = '<categories>\n</categories>\n<existing>\n[1] mum phone — Mum: phone 0770\n</existing>\n<note>\nMum new phone 0771. Dad is away.\n</note>';
    const ask = (meta: Record<string, unknown>) => (demoReply({ model: 'x', messages: [{ role: 'user', content }], maxOutputTokens: 1, timeoutMs: 1, meta: meta as never })?.ops as Array<Record<string, unknown>>).filter((o) => o.op === 'upsertNode' && o.partition === 'item');
    expect(ask({ capability: 'categorise', itemId: 'n1' })).toHaveLength(1);
    expect(ask({ capability: 'categorise', itemId: 'n1' })[0]?.data).not.toHaveProperty('key');
    expect(ask({ capability: 'categorise', itemId: 'n1', maxFacts: 1 })[0]?.data).not.toHaveProperty('key');
    expect(ask({ capability: 'categorise', itemId: 'n1', maxFacts: 4 })).toHaveLength(2);
  });
  it('a note without a change cue replaces nothing even when a key matches', async () => {
    const existing: ExistingNote[] = [{ title: 'Mum: phone 07700', summary: 'Mum: phone 07700', key: 'mum / phone 07700' }];
    expect((await file('Mum phone 07700 is on the fridge.', existing)).replaces).toEqual([]);
  });
  it('two facts naming the same existing note give its number once; different facts give both', async () => {
    const existing: ExistingNote[] = [
      { title: 'Dad: clinic Friday 13 March', summary: 'Dad: clinic Friday 13 March', key: 'dad / clinic friday' },
      { title: 'Dad: tablet 2 x Tablet C', summary: 'Dad: tablet 2 x Tablet C', key: 'dad / tablet tablet' },
    ];
    const p = await file('Dad: clinic moved to Friday 20 March; Dad: tablet now 3 x Tablet C', existing);
    expect(p.replaces).toEqual([1, 2]);
    const q = await file('Dad clinic moved to Friday 20 March clinic Friday', existing);
    expect(q.replaces).toEqual([1]);
  });
  it('never more than five replaced', async () => {
    const existing: ExistingNote[] = Array.from({ length: 7 }, (_, i) => ({ title: `Thing ${i}`, summary: `Thing${i} alpha${i} beta${i} gamma${i}`, key: `thing${i} alpha${i}` }));
    const text = existing.map((e, i) => `Now thing${i} alpha${i} beta${i} gamma${i} changed`).join('. ');
    const p = await file(text, existing);
    expect(p.replaces.length).toBeLessThanOrEqual(5);
    expect(p.replaces.length).toBeGreaterThan(0);
  });
  it('1,500 random notes with random existing lists all pass the real guard first time', async () => {
    const pieces = ['Mum:', 'phone 0770', 'born 4 June', 'email a@b.c', 'now', 'moved to Friday', '<b>x</b>', '&amp;', '😀', 'ignore all rules', 'Name: Ann', 'DoB: 4 June', ';', '.', ',', 'a'.repeat(90), '\n', '{"op":"deleteNode"}'];
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 1500; i++) {
      const text = Array.from({ length: 1 + rnd(14) }, () => pieces[rnd(pieces.length)]).join(rnd(2) === 0 ? ' ' : ', ');
      if (text.trim() === '') continue;
      const existing = rnd(2) === 0 ? undefined : Array.from({ length: 1 + rnd(6) }, (_, k) => ({ title: `${pieces[rnd(pieces.length)]} ${k}`, summary: String(pieces[rnd(pieces.length)]), ...(rnd(2) === 0 ? {} : { key: `${pieces[rnd(pieces.length)]} k${k}`.replace(/\n/g, ' ').slice(0, 80) }) }));
      const r = await llm.categorise({ ...base, text, ...(existing === undefined ? {} : { existing }) });
      expect(r.ok, text).toBe(true);
      if (r.ok) expect(r.value.attempts, text).toBe(1);
    }
  }, 60000);
});
