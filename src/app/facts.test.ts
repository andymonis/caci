import { describe, expect, it } from 'vitest';
import { query, type Op } from '../graph_store/index.js';
import { reply, setup } from './controller-fixture.test-util.js';

// A note that states several facts becomes several items (R-015); a later change replaces only its own fact.

const PROFILE_NOTE = { kind: 'text', text: 'Mum: born 4 June 1950, phone 07700 900123, email mum@example.test.' };
const fact = (k: number, title: string, summary: string, key?: string, extra: Record<string, unknown> = {}) => ({
  op: 'upsertNode', partition: 'item', id: k === 1 ? 'note-1' : `note-1-${k}`, data: { title, summary, ...(key === undefined ? {} : { key }), ...extra },
});
const link = (k: number, category: string, weight = 0.8) => ({ op: 'link', item: k === 1 ? 'note-1' : `note-1-${k}`, category, weight });
const PROFILE = {
  ops: [
    fact(1, 'Mum: date of birth', 'Mum was born on 4 June 1950.', 'mum / date of birth'),
    fact(2, 'Mum: phone number', "Mum's phone number is 07700 900123.", 'mum / phone number'),
    fact(3, 'Mum: email', "Mum's email is mum@example.test.", 'mum / email'),
    { op: 'upsertNode', partition: 'category', id: 'mum', data: { name: 'Mum' } },
    { op: 'upsertNode', partition: 'category', id: 'contact', data: { name: 'Contact details' } },
    link(1, 'mum'), link(2, 'mum'), link(2, 'contact'), link(3, 'mum'), link(3, 'contact'),
  ],
  rationale: 'Three facts about Mum.',
};
const SEEDED: Op[] = [
  { op: 'upsertNode', partition: 'category', id: 'mum', mode: 'merge', data: { name: 'Mum' } },
  { op: 'upsertNode', partition: 'category', id: 'contact', mode: 'merge', data: { name: 'Contact details' } },
  { op: 'upsertNode', partition: 'item', id: 'f-dob', mode: 'merge', data: { title: 'Mum: date of birth', summary: 'Mum was born on 4 June 1950.', key: 'mum / date of birth' } },
  { op: 'upsertNode', partition: 'item', id: 'f-phone', mode: 'merge', data: { title: 'Mum: phone number', summary: "Mum's phone number is 07700 900123.", key: 'mum / phone number' } },
  { op: 'upsertNode', partition: 'item', id: 'f-email', mode: 'merge', data: { title: 'Mum: email', summary: "Mum's email is mum@example.test.", key: 'mum / email' } },
  { op: 'link', item: 'f-dob', category: 'mum', ensureNodes: false }, { op: 'link', item: 'f-phone', category: 'mum', ensureNodes: false },
  { op: 'link', item: 'f-phone', category: 'contact', ensureNodes: false }, { op: 'link', item: 'f-email', category: 'mum', ensureNodes: false },
  { op: 'link', item: 'f-email', category: 'contact', ensureNodes: false },
];
const CHANGE_NOTE = { kind: 'text', text: "Mum's new phone number is 07700 900456." };
const CHANGE = {
  ops: [fact(1, 'Mum: phone number', "Mum's phone number is 07700 900456.", 'mum / phone number'), link(1, 'mum'), link(1, 'contact')],
  replaces: [1],
};
const items = async (adapter: Parameters<typeof query>[0]): Promise<string[]> => {
  const r = await query(adapter, { version: 1, graphId: 'notes', from: { all: true }, filter: { partition: 'item' }, return: { shape: 'ids' } });
  if (!r.ok || !('ids' in r.value)) throw new Error('could not list');
  return r.value.ids.map((x) => x.id).sort();
};
const must = async <T>(p: Promise<{ ok: boolean; value?: T; error?: unknown }>): Promise<T> => {
  const r = await p;
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value as T;
};

describe('a note with several facts becomes several items', () => {
  it('previews each fact, writes them all in one step, with their links', async () => {
    const s = await setup({ script: [reply(PROFILE)] });
    const p = await must(s.controller.propose('notes', PROFILE_NOTE));
    expect(p.summary.newItems).toEqual(['note-1', 'note-1-2', 'note-1-3']);
    expect(p.summary.facts.map((f) => f.title)).toEqual(['Mum: date of birth', 'Mum: phone number', 'Mum: email']);
    expect(p.text).toContain('This note adds 3 facts:\n  - Mum: date of birth: Mum was born on 4 June 1950.\n  - Mum: phone number');
    expect(p.summary.problems).toEqual([]);
    expect(s.recording.writes).toEqual([]);
    const done = await must(s.controller.approve(p.id));
    expect(done.written.applied).toBe(10);
    expect(await items(s.inner)).toEqual(['note-1', 'note-1-2', 'note-1-3']);
    const sub = await query(s.inner, { version: 1, graphId: 'notes', from: { all: true }, return: { shape: 'subgraph', includeData: true } });
    expect(sub.ok && 'edges' in sub.value ? sub.value.edges.length : 0).toBe(5);
  });

  it('one fact still previews as before, without the facts heading', async () => {
    const s = await setup();
    const p = await must(s.controller.propose('notes', { kind: 'text', text: 'Saw Dr X on Tuesday.' }));
    expect(p.summary.facts).toHaveLength(1);
    expect(p.text).not.toContain('This note adds');
  });

  it('a link to a category that does not exist is a problem in the preview, and approving writes none of the facts', async () => {
    const bad = { ops: [fact(1, 'A', 'a'), fact(2, 'B', 'b'), link(1, 'ghost'), link(2, 'ghost')] };
    const s = await setup({ script: [reply(bad)] });
    const p = await must(s.controller.propose('notes', PROFILE_NOTE));
    expect(p.summary.problems.length).toBeGreaterThan(0);
    const done = await s.controller.approve(p.id);
    expect(done.ok).toBe(false);
    expect(await items(s.inner)).toEqual([]);
  });

  it('every new fact is stamped with who and when, and a forged stamp is removed', async () => {
    const forged = { ...PROFILE, ops: PROFILE.ops.map((o, i) => (i === 1 ? fact(2, 'Mum: phone number', 'x', 'k', { contributedBy: 'u-forged', contributedAt: 1 }) : o)) };
    const s = await setup({ script: [reply(forged)] });
    const p = await must(s.controller.propose('notes', PROFILE_NOTE, { stamp: { contributedBy: 'u1' } }));
    const stamps = p.mutation.ops.filter((o) => o.op === 'upsertNode' && o.partition === 'item').map((o) => (o.op === 'upsertNode' ? (o.data as Record<string, unknown>) : {}));
    expect(stamps).toHaveLength(3);
    for (const d of stamps) expect(d).toMatchObject({ contributedBy: 'u1', contributedAt: 1_000_000 });
    for (const o of p.mutation.ops) if (o.op === 'upsertNode' && o.partition === 'category') expect(o.data).not.toHaveProperty('contributedBy');
  });
});

describe('a change replaces only its own fact', () => {
  it('shows the model the facts with their keys, and the phone number comes first', async () => {
    const s = await setup({ existing: SEEDED, script: [reply(CHANGE)] });
    await must(s.controller.propose('notes', CHANGE_NOTE));
    const sent = s.client.requests[0]?.messages[0]?.content ?? '';
    expect(sent).toContain('[1] mum / phone number — Mum: phone number: Mum&apos;s phone number is 07700 900123.'.replace('&apos;', "'"));
    expect(sent).toContain('mum / email');
  });

  it('removes only the phone fact; the date of birth, the email and their links stay, and the new number is there', async () => {
    const s = await setup({ existing: SEEDED, script: [reply(CHANGE)] });
    const p = await must(s.controller.propose('notes', CHANGE_NOTE));
    expect(p.summary.removed.map((r) => r.id)).toEqual(['f-phone']);
    expect(p.mutation.ops.filter((o) => o.op === 'deleteNode')).toEqual([{ op: 'deleteNode', partition: 'item', id: 'f-phone' }]);
    await must(s.controller.approve(p.id));
    expect(await items(s.inner)).toEqual(['f-dob', 'f-email', 'note-1']);
    const sub = await query(s.inner, { version: 1, graphId: 'notes', from: { all: true }, return: { shape: 'subgraph', includeData: true } });
    const edges = sub.ok && 'edges' in sub.value ? sub.value.edges.map((e) => `${e.item}>${e.category}`).sort() : [];
    expect(edges).toEqual(['f-dob>mum', 'f-email>contact', 'f-email>mum', 'note-1>contact', 'note-1>mum']);
  });

  it('a fact the model did not list in replaces stays, even if it was shown', async () => {
    const s = await setup({ existing: SEEDED, script: [reply({ ...CHANGE, replaces: undefined })] });
    const p = await must(s.controller.propose('notes', CHANGE_NOTE));
    expect(p.summary.removed).toEqual([]);
    await must(s.controller.approve(p.id));
    expect(await items(s.inner)).toEqual(['f-dob', 'f-email', 'f-phone', 'note-1']);
  });

  it('items stored before facts existed (no key) are still candidates by words and replaced whole', async () => {
    const OLD: Op[] = [...SEEDED.slice(0, 2), { op: 'upsertNode', partition: 'item', id: 'old-note', mode: 'merge', data: { title: 'Mum details', summary: "Mum's phone number is 07700 900123 and she was born 4 June." } }, { op: 'link', item: 'old-note', category: 'mum', ensureNodes: false }];
    const s = await setup({ existing: OLD, script: [reply(CHANGE)] });
    const p = await must(s.controller.propose('notes', CHANGE_NOTE));
    expect(p.summary.removed.map((r) => r.id)).toEqual(['old-note']);
  });
});
