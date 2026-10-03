import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createGraph, write, type Mutation, type Op } from '../graph_store/index.js';
import { describeSummary, summarise, type ExistingNodes, type ProposalSummary } from './summary.js';

const upsertItem = (id: string): Op => ({ op: 'upsertNode', partition: 'item', id, mode: 'merge', data: { title: id } });
const upsertCategory = (id: string): Op => ({ op: 'upsertNode', partition: 'category', id, mode: 'merge', data: { name: id } });
const link = (item: string, category: string): Op => ({ op: 'link', item, category, ensureNodes: false, weight: 0.8 });
const mutation = (...ops: Op[]): Mutation => ({ version: 1, kind: 'mutation', graphId: 'g', createIfMissing: false, ops });
const NOTHING: ExistingNodes = { items: [], categories: [] };
const sum = (m: Mutation, existing: ExistingNodes = NOTHING): ProposalSummary => {
  const r = summarise(m, existing);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe('summarise: ordinary proposals', () => {
  it('into an empty graph: everything is new', () => {
    const s = sum(mutation(upsertItem('n1'), upsertCategory('doctor'), link('n1', 'doctor')));
    expect(s).toEqual({
      newItems: ['n1'],
      updatedItems: [],
      newCategories: ['doctor'],
      updatedCategories: [],
      reusedCategories: [],
      newLinks: [{ item: 'n1', category: 'doctor' }],
      problems: [],
      notes: [],
    });
  });

  it('with only existing categories: they are reused, nothing new but the item and its links', () => {
    const s = sum(mutation(upsertItem('n1'), link('n1', 'doctor'), link('n1', 'appointments')), { items: [], categories: ['doctor', 'appointments', 'unrelated'] });
    expect(s).toMatchObject({ newItems: ['n1'], newCategories: [], reusedCategories: ['doctor', 'appointments'], problems: [], notes: [] });
    expect(s.newLinks).toEqual([{ item: 'n1', category: 'doctor' }, { item: 'n1', category: 'appointments' }]);
  });

  it('a mix of reused and new categories', () => {
    const s = sum(mutation(upsertItem('n1'), upsertCategory('new-one'), link('n1', 'new-one'), link('n1', 'old-one')), { items: [], categories: ['old-one'] });
    expect(s).toMatchObject({ newCategories: ['new-one'], reusedCategories: ['old-one'], problems: [] });
  });

  it('an upsert of something that already exists is an update, not a new node', () => {
    const s = sum(mutation(upsertItem('n1'), upsertCategory('doctor'), link('n1', 'doctor')), { items: ['n1'], categories: ['doctor'] });
    expect(s).toMatchObject({ newItems: [], updatedItems: ['n1'], newCategories: [], updatedCategories: ['doctor'], reusedCategories: ['doctor'] });
  });

  it('a category with the same id as an item is a different node', () => {
    const s = sum(mutation(upsertItem('x'), upsertCategory('x'), link('x', 'x')), { items: [], categories: ['x'] });
    expect(s).toMatchObject({ newItems: ['x'], newCategories: [], updatedCategories: ['x'] });
    const t = sum(mutation(upsertItem('x'), upsertCategory('x'), link('x', 'x')), { items: ['x'], categories: [] });
    expect(t).toMatchObject({ updatedItems: ['x'], newCategories: ['x'] });
  });

  it('lists each id once even when the proposal repeats it, in the order first seen', () => {
    const s = sum(mutation(upsertItem('n1'), upsertCategory('b'), upsertCategory('a'), upsertCategory('b'), upsertItem('n1'), link('n1', 'b'), link('n1', 'a')));
    expect(s.newItems).toEqual(['n1']);
    expect(s.newCategories).toEqual(['b', 'a']);
  });

  it('an empty list of operations summarises to nothing', () => {
    expect(sum(mutation())).toMatchObject({ newItems: [], newCategories: [], newLinks: [], problems: [], notes: [] });
  });

  it('is deterministic, does not change its inputs, and returns a frozen result', () => {
    const m = mutation(upsertItem('n1'), upsertCategory('c'), link('n1', 'c'));
    const existing = { items: ['z'], categories: ['y'] };
    const before = JSON.stringify([m, existing]);
    const a = sum(m, existing);
    expect(sum(m, existing)).toEqual(a);
    expect(JSON.stringify([m, existing])).toBe(before);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe('summarise: problems (the write would fail)', () => {
  it('a link to a category that does not exist and is not created', () => {
    const s = sum(mutation(upsertItem('n1'), link('n1', 'ghost')));
    expect(s.problems).toEqual(['ops[1]: the link to ghost would fail because that category does not exist and is not created before this link']);
  });

  it('a link that comes before the upsert that creates its category', () => {
    const s = sum(mutation(upsertItem('n1'), link('n1', 'late'), upsertCategory('late')));
    expect(s.problems).toHaveLength(1);
    expect(s.problems[0]).toContain('ops[1]');
    expect(s.newCategories).toEqual(['late']);
  });

  it('a link from an item the proposal does not create and the graph does not have', () => {
    const s = sum(mutation(upsertCategory('c'), link('other-note', 'c')));
    expect(s.problems).toEqual(['ops[1]: the link from other-note would fail because that item does not exist and is not created before this link']);
  });

  it('a link from an existing item is fine', () => {
    expect(sum(mutation(upsertCategory('c'), link('old', 'c')), { items: ['old'], categories: [] }).problems).toEqual([]);
  });

  it('reports each problem with its own position', () => {
    const s = sum(mutation(link('a', 'b'), upsertItem('a'), link('a', 'c')));
    expect(s.problems).toHaveLength(3); // item a missing and category b missing at ops[0], category c missing at ops[2]
    expect(s.problems.map((p) => p.slice(0, 6))).toEqual(['ops[0]', 'ops[0]', 'ops[2]']);
  });

  it('shows odd ids quoted and escaped, never raw', () => {
    const s = sum(mutation(upsertItem('n1'), link('n1', 'bad\nid "quoted"')));
    expect(s.problems[0]).toContain('"bad\\nid \\"quoted\\""');
    expect(s.problems[0]).not.toContain('\n');
  });
});

describe('summarise: notes (worth knowing, not fatal)', () => {
  it('a repeated link counts once and is noted', () => {
    const s = sum(mutation(upsertItem('n1'), upsertCategory('c'), link('n1', 'c'), link('n1', 'c')));
    expect(s.newLinks).toEqual([{ item: 'n1', category: 'c' }]);
    expect(s.notes).toEqual(['ops[3]: the link from n1 to c appears more than once; the last one wins']);
    expect(s.problems).toEqual([]);
  });

  it('links from an existing item are noted as possibly replacing links it has', () => {
    const s = sum(mutation(upsertItem('n1'), link('n1', 'c')), { items: ['n1'], categories: ['c'] });
    expect(s.notes).toEqual(['ops[1]: n1 already exists, so this link may replace one it already has']);
  });

  it('links that differ only in item or category are different links', () => {
    const s = sum(mutation(upsertItem('a'), upsertItem('b'), upsertCategory('x'), upsertCategory('y'), link('a', 'x'), link('a', 'y'), link('b', 'x')));
    expect(s.newLinks).toHaveLength(3);
    expect(s.notes).toEqual([]);
  });

  it('ids containing the separator characters do not collide as links', () => {
    const s = sum(mutation(upsertItem('a,b'), upsertItem('a'), upsertCategory('c'), upsertCategory('b,c'), link('a,b', 'c'), link('a', 'b,c')));
    expect(s.newLinks).toHaveLength(2);
    expect(s.notes).toEqual([]);
  });
});

describe('summarise: what it refuses', () => {
  it.each([
    ['deleteNode', { op: 'deleteNode', partition: 'item', id: 'n1' } as Op],
    ['unlink', { op: 'unlink', item: 'n1', category: 'c' } as Op],
  ])('%s cannot be summarised', (name, op) => {
    const r = summarise(mutation(upsertItem('n1'), op), NOTHING);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(!r.ok && r.error.message).toContain(`operation ${name} cannot be summarised`);
  });

  it.each([
    ['no mutation', null],
    ['no operations list', { ...mutation(), ops: 'x' }],
    ['an operation that is not an object', { ...mutation(), ops: ['x'] }],
    ['an operation with no name', { ...mutation(), ops: [{}] }],
    ['an upsert with a bad partition', { ...mutation(), ops: [{ op: 'upsertNode', partition: 'both', id: 'a' }] }],
    ['an upsert with no id', { ...mutation(), ops: [{ op: 'upsertNode', partition: 'item' }] }],
    ['a link with no category', { ...mutation(), ops: [{ op: 'link', item: 'a' }] }],
  ])('%s', (_n, m) => {
    expect(summarise(m as never, NOTHING)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it.each([
    ['existing missing', undefined],
    ['existing without categories', { items: [] }],
    ['items that are not ids', { items: [1], categories: [] }],
    ['categories that is not a list', { items: [], categories: 'a' }],
  ])('%s', (_n, existing) => {
    expect(summarise(mutation(), existing as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('never throws on hostile input', () => {
    const getter = { get ops(): never { throw new Error('boom'); } };
    expect(summarise(getter as never, NOTHING)).toMatchObject({ ok: false });
  });
});

describe('describeSummary', () => {
  it('writes the plain text for a clean proposal', () => {
    const s = sum(mutation(upsertItem('n1'), upsertCategory('doctor-x'), link('n1', 'doctor-x'), link('n1', 'appointments')), { items: [], categories: ['appointments'] });
    expect(describeSummary(s)).toBe(
      ['New items: n1', 'New categories: doctor-x', 'Existing categories used: appointments', 'Links: n1 → doctor-x, n1 → appointments'].join('\n'),
    );
  });

  it('says none for empty lists', () => {
    expect(describeSummary(sum(mutation()))).toBe(['New items: none', 'New categories: none', 'Existing categories used: none', 'Links: none'].join('\n'));
  });

  it('adds updates, problems and notes only when there are some', () => {
    const s = sum(mutation(upsertItem('n1'), upsertCategory('c'), link('n1', 'c'), link('n1', 'c'), link('n1', 'ghost')), { items: ['n1'], categories: ['c'] });
    const text = describeSummary(s);
    expect(text).toContain('Existing items that would change: n1');
    expect(text).toContain('Existing categories that would change: c');
    expect(text).toContain('Problems (this would fail if approved):\n  - ops[4]');
    expect(text).toContain('Notes:\n  - ops[2]');
    expect(text).toContain('  - ops[3]');
    expect(describeSummary(sum(mutation(upsertItem('n1'), upsertCategory('c'), link('n1', 'c'))))).not.toMatch(/Problems|Notes|would change/);
  });

  it('shows odd ids quoted so they cannot add lines or fake entries', () => {
    const s = sum(mutation(upsertItem('n1'), upsertCategory('x\nNew items: fake'), link('n1', 'x\nNew items: fake')));
    const text = describeSummary(s);
    expect(text.split('\n')).toHaveLength(4);
    expect(text).toContain('"x\\nNew items: fake"');
  });

  it('is deterministic', () => {
    const s = sum(mutation(upsertItem('n1'), upsertCategory('c'), link('n1', 'c')));
    expect(describeSummary(s)).toBe(describeSummary(s));
  });
});

describe('summarise agrees with the real graph store', () => {
  // The summary predicts whether a write fails for a missing node. The store has the final word.
  const POOL = ['a', 'b', 'c'];
  async function check(ops: Op[], existingItems: string[], existingCategories: string[]): Promise<void> {
    const adapter = createMemoryAdapter();
    await createGraph(adapter, 'g');
    const seed: Op[] = [...existingItems.map((id) => upsertItem(id)), ...existingCategories.map((id) => upsertCategory(id))];
    if (seed.length > 0) expect((await write(adapter, mutation(...seed))).ok).toBe(true);

    const predicted = sum(mutation(...ops), { items: existingItems, categories: existingCategories });
    const actual = await write(adapter, mutation(...ops));
    if (predicted.problems.length > 0) {
      expect(actual).toMatchObject({ ok: false, error: { code: 'NODE_NOT_FOUND' } });
      if (!actual.ok) {
        // the store stops at the first failing operation: it must be the first one the summary named
        const first = Number(/^ops\[(\d+)\]/.exec(predicted.problems[0] ?? '')?.[1]);
        expect(actual.error.path?.[1]).toBe(first);
      }
    } else {
      expect(actual.ok).toBe(true);
    }
  }

  it('on 400 random proposals, a problem is reported exactly when the real write fails', async () => {
    let seed = 7;
    const rand = (n: number): number => Math.floor(((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * n);
    const pick = (): string => POOL[rand(POOL.length)] as string;
    for (let round = 0; round < 400; round++) {
      const ops: Op[] = Array.from({ length: 1 + rand(6) }, () => {
        const kind = rand(3);
        return kind === 0 ? upsertItem(pick()) : kind === 1 ? upsertCategory(pick()) : link(pick(), pick());
      });
      const existingItems = POOL.filter(() => rand(3) === 0);
      const existingCategories = POOL.filter(() => rand(3) === 0);
      await check(ops, existingItems, existingCategories);
    }
  });

  it('a typical clean proposal writes, and the counts match what the graph then holds', async () => {
    const adapter = createMemoryAdapter();
    await createGraph(adapter, 'g');
    await write(adapter, mutation(upsertCategory('appointments')));
    const ops = [upsertItem('n1'), upsertCategory('doctor-x'), link('n1', 'doctor-x'), link('n1', 'appointments')];
    const s = sum(mutation(...ops), { items: [], categories: ['appointments'] });
    expect(s).toMatchObject({ newItems: ['n1'], newCategories: ['doctor-x'], reusedCategories: ['appointments'], problems: [] });
    expect(await write(adapter, mutation(...ops))).toMatchObject({ ok: true, value: { applied: 4 } });
  });
});
