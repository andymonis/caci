import { describe, expect, it } from 'vitest';
import { query } from '../graph_store/index.js';
import { ownErrorOf, world, type World } from './controller.test-util.js';

// R-014 through the CaCi controller: the demo model replaces a note that a new note changes (it reads like a change and shares
// at least three words), in a personal brain and in a circle, by the people who may capture there.

const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
const PEOPLE = ['ann', 'bob', 'cat', 'dan'];
const setup = async () => world({ people: PEOPLE });
const OLD = 'Mum takes 2 x Tablet A a day for her blood pressure.';
const CHANGE = 'Mum now takes 1 x Tablet B a day for her blood pressure.';
const ADD = 'Mum has a hospital appointment on Tuesday morning.';
const circle = (id: string) => ({ kind: 'circle' as const, circleId: id });

async function file(w: World, who: string, text: string, scope?: { kind: 'circle'; circleId: string }) {
  const made = must(await w.caci.propose(w.tokens[who] as string, scope === undefined ? { text } : { text, scope }));
  const done = must(await w.caci.approve(w.tokens[who] as string, made.id));
  return { made, done };
}
async function noteTexts(w: World, graphId: string): Promise<string[]> {
  const r = await query(w.graphs, { version: 1, graphId, from: { all: true }, filter: { partition: 'item' }, return: { shape: 'nodes', includeData: true } });
  if (!r.ok || !('nodes' in r.value)) throw new Error('could not read');
  return r.value.nodes.map((n) => String((n.data as { summary?: string }).summary)).sort();
}

describe('in a personal brain', () => {
  it('the new dose replaces the old note: the preview says so, and after approval only the new note is there', async () => {
    const w = await setup();
    await file(w, 'ann', OLD);
    const made = must(await w.caci.propose(w.tokens.ann as string, { text: CHANGE }));
    expect(made.summary.removed).toHaveLength(1);
    expect(made.summary.removed[0]?.summary).toContain('2 x Tablet A');
    expect(made.text).toContain('This note replaces, and these will be removed when you approve:');
    expect(await noteTexts(w, w.graphIds.ann as string)).toHaveLength(1);
    const done = must(await w.caci.approve(w.tokens.ann as string, made.id));
    expect(done.applied).toBe(made.operations.length);
    const texts = await noteTexts(w, w.graphIds.ann as string);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('1 x Tablet B');
    expect(texts.join(' ')).not.toContain('2 x Tablet A');
  });
  it('a note that only adds keeps the old one, and the view has no removals', async () => {
    const w = await setup();
    await file(w, 'ann', OLD);
    const { made } = await file(w, 'ann', ADD);
    expect(made.summary.removed).toEqual([]);
    expect(await noteTexts(w, w.graphIds.ann as string)).toHaveLength(2);
  });
  it('an emptied category is tidied and the approval says so; nothing about it when nothing was tidied', async () => {
    const w = await setup();
    const first = await file(w, 'ann', OLD);
    expect('tidied' in first.done).toBe(false);
    const { done } = await file(w, 'ann', 'Mum now takes tablet day blood morning.');
    expect(done.tidied?.map((t) => t.id)).toEqual(['pressure']);
    expect(done.tidied?.[0]?.name).toBe('Pressure');
    const cats = must(await w.caci.categories(w.tokens.ann as string));
    expect(cats.items.map((c) => c.id)).toEqual(['morning']);
  });
  it('another person with a similar note is never touched', async () => {
    const w = await setup();
    await file(w, 'bob', OLD);
    await file(w, 'ann', OLD);
    await file(w, 'ann', CHANGE);
    const bob = await noteTexts(w, w.graphIds.bob as string);
    const ann = await noteTexts(w, w.graphIds.ann as string);
    expect(bob).toHaveLength(1);
    expect(bob[0]).toContain('2 x Tablet A');
    expect(ann).toHaveLength(1);
    expect(ann[0]).toContain('1 x Tablet B');
  });
});

describe('in a circle', () => {
  it('a member replaces a note that another member wrote', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'manager']]);
    await file(w, 'bob', OLD, circle(c));
    const { made, done } = await file(w, 'cat', CHANGE, circle(c));
    expect(made.summary.removed).toHaveLength(1);
    expect(done.applied).toBe(made.operations.length);
    const texts = await noteTexts(w, `circle-${c}`);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('1 x Tablet B');
  });
  it('owners and managers may too', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'manager']]);
    await file(w, 'bob', OLD, circle(c));
    await file(w, 'ann', CHANGE, circle(c));
    expect(await noteTexts(w, `circle-${c}`)).toHaveLength(1);
  });
  it('an observer cannot capture at all, so cannot replace: the same answer a stranger gets, and nothing changes', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'observer']]);
    await file(w, 'bob', OLD, circle(c));
    const observer = await w.caci.propose(w.tokens.cat as string, { text: CHANGE, scope: circle(c) });
    const stranger = await w.caci.propose(w.tokens.dan as string, { text: CHANGE, scope: circle(c) });
    expect(observer).toEqual(stranger);
    expect(ownErrorOf(observer)).toMatchObject({ code: 'NOT_FOUND' });
    expect(await noteTexts(w, `circle-${c}`)).toHaveLength(1);
  });
  it('a member demoted to observer after the preview cannot approve it: the old note stays', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    await file(w, 'ann', OLD, circle(c));
    const made = must(await w.caci.propose(w.tokens.bob as string, { text: CHANGE, scope: circle(c) }));
    expect(made.summary.removed).toHaveLength(1);
    const uid = (w.graphIds.bob as string).slice('user-'.length);
    must(await w.circleStore.changeRole(c, uid, 'observer'));
    const refused = await w.caci.approve(w.tokens.bob as string, made.id);
    expect(ownErrorOf(refused)).toMatchObject({ code: 'NOT_FOUND', message: 'no such proposal' });
    expect(await noteTexts(w, `circle-${c}`)).toEqual([expect.stringContaining('2 x Tablet A')]);
  });
  it('a circle never reads or removes the personal brain, nor another circle', async () => {
    const w = await setup();
    const a = await w.circle(1, 'ann', [['bob', 'member']]);
    const b = await w.circle(2, 'ann', [['bob', 'member']]);
    await file(w, 'bob', OLD);
    await file(w, 'bob', OLD, circle(b));
    const { made } = await file(w, 'bob', CHANGE, circle(a));
    expect(made.summary.removed).toEqual([]);
    expect(await noteTexts(w, w.graphIds.bob as string)).toHaveLength(1);
    expect(await noteTexts(w, `circle-${b}`)).toHaveLength(1);
    expect(await noteTexts(w, `circle-${a}`)).toHaveLength(1);
  });
});
