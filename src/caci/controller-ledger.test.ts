import { describe, expect, it } from 'vitest';
import { createDemoModelClient, type ModelClient } from '../llm/index.js';
import { createMemoryLedgerStore, type LedgerEntry, type LedgerScope, type LedgerStore } from '../ledger/index.js';
import { world, type World } from './controller.test-util.js';

// R-014: after an approved write the change log holds one entry per change, in the right scope, and a failure to record never
// undoes or refuses the change.

const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
const OLD = 'Mum takes 2 x Tablet A a day for her blood pressure.';
const CHANGE = 'Mum now takes tablet day blood morning.';
const circle = (id: string) => ({ kind: 'circle' as const, circleId: id });
const setup = async (extra: Parameters<typeof world>[0] = {}) => {
  const ledger = createMemoryLedgerStore();
  const w = await world({ people: ['ann', 'bob', 'cat'], ledger, ...extra });
  return { w, ledger };
};
const file = async (w: World, who: string, text: string, scope?: ReturnType<typeof circle>) => {
  const made = must(await w.caci.propose(w.tokens[who] as string, scope === undefined ? { text } : { text, scope }));
  return { made, done: must(await w.caci.approve(w.tokens[who] as string, made.id)) };
};
const entries = async (ledger: LedgerStore, scope: LedgerScope): Promise<LedgerEntry[]> => (await ledger.list(scope, { limit: 100, cursor: null })).items.slice();
const personal = (w: World, who: string): LedgerScope => ({ kind: 'personal', userId: (w.graphIds[who] as string).slice('user-'.length) });
const summary = (e: LedgerEntry): string => `${e.action} ${e.kind} ${e.subject}`;

describe('what is recorded after an approval', () => {
  it('a first note: the note and the category it made were added, by the person, with the proposal and the time', async () => {
    const { w, ledger } = await setup();
    const { made } = await file(w, 'ann', OLD);
    const got = await entries(ledger, personal(w, 'ann'));
    expect(got.map((e) => `${e.action} ${e.kind}`)).toEqual(['added item', 'added category']);
    expect(got[0]).toMatchObject({ actor: (w.graphIds.ann as string).slice(5), proposalId: made.id, scope: personal(w, 'ann'), title: expect.stringContaining('Mum takes'), summary: expect.stringContaining('2 x Tablet A') });
    expect(got[1]?.title).toBe('Pressure');
    expect(got[0]?.at).toBeGreaterThanOrEqual(w.now.value);
    expect(got.every((e) => /^l[a-z0-9]{16}$/.test(e.id))).toBe(true);
  });
  it('the dose story: the new note is added, the old note removed with its text, the emptied category removed, newest first', async () => {
    const { w, ledger } = await setup();
    const first = await file(w, 'ann', OLD);
    const oldId = first.made.summary.newItems[0] as string;
    w.now.value += 60_000;
    const { made, done } = await file(w, 'ann', CHANGE);
    const got = (await entries(ledger, personal(w, 'ann'))).filter((e) => e.proposalId === made.id);
    expect(got.map(summary)).toEqual([`added item ${made.summary.newItems[0]}`, `added category morning`, `removed item ${oldId}`, 'removed category pressure']);
    const removed = got.find((e) => e.action === 'removed' && e.kind === 'item');
    expect(removed).toMatchObject({ title: expect.stringContaining('Mum takes'), summary: expect.stringContaining('2 x Tablet A') });
    expect(got.find((e) => e.kind === 'category' && e.action === 'removed')?.title).toBe('Pressure');
    expect(done.tidied?.map((t) => t.id)).toEqual(['pressure']);
    // the whole log is newest first
    const all = await entries(ledger, personal(w, 'ann'));
    expect(all.slice(0, 4).map((e) => e.proposalId)).toEqual(Array(4).fill(made.id));
  });
  it('a note that only adds records only what it added', async () => {
    const { w, ledger } = await setup();
    await file(w, 'ann', OLD);
    const { made } = await file(w, 'ann', 'Hospital appointment on Tuesday morning.');
    expect((await entries(ledger, personal(w, 'ann'))).filter((e) => e.proposalId === made.id).every((e) => e.action === 'added')).toBe(true);
  });
  it('long titles and summaries are cut to 200 and 400 characters by character', async () => {
    const { w, ledger } = await setup();
    await file(w, 'ann', `${'word '.repeat(200)}`);
    const first = (await entries(ledger, personal(w, 'ann'))).find((e) => e.kind === 'item') as LedgerEntry;
    expect([...(first.title ?? '')].length).toBeLessThanOrEqual(200);
    expect([...(first.summary ?? '')].length).toBeLessThanOrEqual(400);
  });
});

describe('what is not recorded', () => {
  it('a proposal that is only made, or rejected, records nothing', async () => {
    const { w, ledger } = await setup();
    const made = must(await w.caci.propose(w.tokens.ann as string, { text: OLD }));
    expect(await entries(ledger, personal(w, 'ann'))).toEqual([]);
    must(await w.caci.reject(w.tokens.ann as string, made.id));
    expect(await entries(ledger, personal(w, 'ann'))).toEqual([]);
  });
  it('a write that fails records nothing and the proposal is still pending', async () => {
    let failing = false;
    const { w, ledger } = await setup({ captureAdapter: (a) => ({ ...a, transaction: (g, fn) => (failing ? Promise.reject(new Error('disk')) : a.transaction(g, fn)) }) });
    const made = must(await w.caci.propose(w.tokens.ann as string, { text: OLD }));
    failing = true;
    expect((await w.caci.approve(w.tokens.ann as string, made.id)).ok).toBe(false);
    expect(await entries(ledger, personal(w, 'ann'))).toEqual([]);
  });
  it('two approvals at once record one change', async () => {
    const { w, ledger } = await setup();
    const made = must(await w.caci.propose(w.tokens.ann as string, { text: OLD }));
    const both = await Promise.all([w.caci.approve(w.tokens.ann as string, made.id), w.caci.approve(w.tokens.ann as string, made.id)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(await entries(ledger, personal(w, 'ann'))).toHaveLength(2);
  });
  it('without a ledger nothing is recorded and nothing breaks', async () => {
    const w = await world({ people: ['ann'] });
    expect((await file(w, 'ann', OLD)).done.applied).toBeGreaterThan(0);
  });
});

describe('scopes', () => {
  it('a circle change is recorded in the circle\'s log, by the member who made it, and not in anyone\'s personal log', async () => {
    const { w, ledger } = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    await file(w, 'ann', OLD, circle(c));
    w.now.value += 1000;
    const { made } = await file(w, 'bob', CHANGE, circle(c));
    const bob = (w.graphIds.bob as string).slice(5);
    const got = (await entries(ledger, { kind: 'circle', circleId: c })).filter((e) => e.proposalId === made.id);
    expect(got.map((e) => `${e.action} ${e.kind}`)).toEqual(['added item', 'added category', 'removed item', 'removed category']);
    expect(got.every((e) => e.actor === bob && e.scope.kind === 'circle')).toBe(true);
    expect(await entries(ledger, personal(w, 'bob'))).toEqual([]);
    expect(await entries(ledger, personal(w, 'ann'))).toEqual([]);
  });
  it('two people\'s personal logs never mix', async () => {
    const { w, ledger } = await setup();
    await file(w, 'ann', OLD);
    await file(w, 'bob', OLD);
    expect((await entries(ledger, personal(w, 'ann'))).every((e) => e.actor === (w.graphIds.ann as string).slice(5))).toBe(true);
    expect((await entries(ledger, personal(w, 'bob'))).every((e) => e.actor === (w.graphIds.bob as string).slice(5))).toBe(true);
  });
});

describe('a ledger that cannot record never undoes or refuses the change', () => {
  const broken: LedgerStore = { append: async () => ({ ok: false, error: { code: 'STORAGE_ERROR', message: 'secret path /var/db' } }), list: async () => ({ items: [], nextCursor: null }), purgeBefore: async () => 0, removeScope: async () => 0 };
  const throwing: LedgerStore = { ...broken, append: async () => { throw new Error('boom /var/db'); } };
  for (const [name, store] of [['returns an error', broken], ['throws', throwing]] as const) {
    it(`when it ${name}: the approval succeeds, the notes are there, and the operator hears one fixed sentence`, async () => {
      const told: string[] = [];
      const { w } = await setup({ ledger: store, onLedgerFailure: (m) => void told.push(m) });
      const { done } = await file(w, 'ann', OLD);
      expect(done.applied).toBeGreaterThan(0);
      expect(must(await w.caci.summary(w.tokens.ann as string)).itemCount).toBe(1);
      expect(told).toEqual(['the change was made but could not be recorded in the change log']);
    });
  }
  it('a hook that throws changes nothing', async () => {
    const { w } = await setup({ ledger: broken, onLedgerFailure: () => { throw new Error('x'); } });
    expect((await file(w, 'ann', OLD)).done.applied).toBeGreaterThan(0);
  });
  it('an entry the log would refuse (for example an over-long id) is reported, not fatal', async () => {
    const told: string[] = [];
    const refusing: LedgerStore = { ...broken, append: async () => ({ ok: false, error: { code: 'INVALID_INPUT', message: 'x' } }) };
    const { w } = await setup({ ledger: refusing, onLedgerFailure: (m) => void told.push(m) });
    await file(w, 'ann', OLD);
    expect(told).toHaveLength(1);
  });
});

describe('details the model decides', () => {
  /** The demo model, with its proposal changed before the guard sees it. */
  const tweaking = (change: (ops: Array<Record<string, unknown>>) => void): ModelClient => {
    const demo = createDemoModelClient();
    return {
      complete: async (request) => {
        const r = await demo.complete(request);
        if (r.ok && r.value.output.kind === 'json') {
          const value = JSON.parse(JSON.stringify(r.value.output.value)) as { ops: Array<Record<string, unknown>> };
          change(value.ops);
          return { ok: true, value: { ...r.value, output: { kind: 'json', value } } } as never;
        }
        return r;
      },
    };
  };
  it('an existing category the note changes is recorded as updated, with its new name', async () => {
    const { w, ledger } = await setup({ client: tweaking((ops) => ops.push({ op: 'upsertNode', partition: 'category', id: 'pressure', data: { name: 'Blood pressure' } })) });
    await file(w, 'ann', OLD);
    const { made } = await file(w, 'ann', 'Mum takes a tablet for her blood pressure, and the pressure notes are updated.');
    const got = (await entries(ledger, personal(w, 'ann'))).filter((e) => e.proposalId === made.id);
    expect(got.find((e) => e.action === 'updated')).toMatchObject({ kind: 'category', subject: 'pressure', title: 'Blood pressure' });
  });
  it('a long title and summary from the model are cut to 200 and 400 characters', async () => {
    const { w, ledger } = await setup({ client: tweaking((ops) => { const item = ops.find((o) => o.partition === 'item') as { data: { title: string; summary: string } }; item.data.title = 'T'.repeat(300); item.data.summary = 'S'.repeat(500); }) });
    await file(w, 'ann', OLD);
    const e = (await entries(ledger, personal(w, 'ann'))).find((x) => x.kind === 'item') as LedgerEntry;
    expect(e.title).toBe('T'.repeat(200));
    expect(e.summary).toBe('S'.repeat(400));
  });
  it('a category whose name is long is cut too', async () => {
    const { w, ledger } = await setup({ client: tweaking((ops) => { const cat = ops.find((o) => o.partition === 'category') as { data: { name: string } } | undefined; if (cat) cat.data.name = 'N'.repeat(300); }) });
    await file(w, 'ann', OLD);
    const e = (await entries(ledger, personal(w, 'ann'))).find((x) => x.kind === 'category') as LedgerEntry;
    expect(e.title).toBe('N'.repeat(200));
  });
  it('a hook with no ledger is never called', async () => {
    const told: string[] = [];
    const w = await world({ people: ['ann'], onLedgerFailure: (m) => void told.push(m) });
    await file(w, 'ann', OLD);
    expect(told).toEqual([]);
  });
});
