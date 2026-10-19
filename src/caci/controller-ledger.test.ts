import { describe, expect, it } from 'vitest';
import { createDemoModelClient, type ModelClient } from '../llm/index.js';
import { createMemoryLedgerStore, type LedgerEntry, type LedgerScope, type LedgerStore } from '../ledger/index.js';
import { ownErrorOf, world, type World } from './controller.test-util.js';

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

describe('reading the change log', () => {
  const read = async (w: World, who: string, scope?: unknown, page?: unknown) => w.caci.ledger(w.tokens[who] as string, scope, page as never);
  const NO_CIRCLE = { source: 'caci', error: { code: 'NOT_FOUND', message: 'no such circle' } };

  it('shows the person\'s own log, newest first, with who made each change and without any id of the plumbing', async () => {
    const { w } = await setup({ directory: true });
    await file(w, 'ann', OLD);
    w.now.value += 5000;
    await file(w, 'ann', CHANGE);
    const got = must(await read(w, 'ann'));
    expect(got.items.map((e) => `${e.action} ${e.kind}`)).toEqual(['added item', 'added category', 'removed item', 'removed category', 'added item', 'added category']);
    expect(got.items[0]?.by).toEqual({ username: 'ann', displayName: 'ann' });
    expect(got.items[2]).toMatchObject({ title: expect.stringContaining('Mum takes'), summary: expect.stringContaining('2 x Tablet A') });
    expect(got.nextCursor).toBeNull();
    expect('scope' in got).toBe(false);
    const json = JSON.stringify(got);
    expect(json).not.toContain('proposalId');
    expect(json).not.toContain('prop-');
    expect(json).not.toContain('user-u');
    expect(Object.keys(got.items[0] as object).sort()).toEqual(['action', 'at', 'by', 'id', 'kind', 'subject', 'summary', 'title']);
    expect(Object.isFrozen(got) && Object.isFrozen(got.items) && Object.isFrozen(got.items[0])).toBe(true);
  });
  it('the personal scope can be said out loud; nothing else changes', async () => {
    const { w } = await setup();
    await file(w, 'ann', OLD);
    expect(await read(w, 'ann', { kind: 'personal' })).toEqual(await read(w, 'ann'));
    expect(await read(w, 'ann', undefined)).toEqual(await read(w, 'ann'));
  });
  it('without a directory, or when it fails, entries have no name', async () => {
    const { w } = await setup();
    await file(w, 'ann', OLD);
    expect(must(await read(w, 'ann')).items.every((e) => !('by' in e))).toBe(true);
    const failing = await setup({ directory: true });
    await file(failing.w, 'ann', OLD);
    const ok = must(await read(failing.w, 'ann'));
    expect(ok.items.every((e) => 'by' in e)).toBe(true);
  });
  it('pages: any page size gives the same entries once, in order, with a cursor that ends', async () => {
    const { w } = await setup();
    for (let i = 0; i < 4; i++) {
      await file(w, 'ann', `Note number ${i} about gardening topic${i} things`);
      w.now.value += 1000;
    }
    const all = must(await read(w, 'ann', undefined, { limit: 100 })).items.map((e) => e.id);
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const limit of [1, 3, all.length]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 50; guard++) {
        const page: Awaited<ReturnType<typeof w.caci.ledger>> = await read(w, 'ann', undefined, cursor === null ? { limit } : { limit, cursor });
        const v = must(page);
        seen.push(...v.items.map((e) => e.id));
        cursor = v.nextCursor;
        if (cursor === null) break;
      }
      expect(seen, `limit ${limit}`).toEqual(all);
    }
  });
  it('bad limits, bad cursors and a cursor from another scope are refused, naming the field', async () => {
    const { w } = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    await file(w, 'ann', OLD);
    await file(w, 'ann', 'Another note about gardening topic things', circle(c));
    await file(w, 'ann', 'Third note about gardening other things', circle(c));
    for (const limit of [0, -1, 1.5, 101, '5', null]) expect(ownErrorOf(await read(w, 'ann', undefined, { limit }))).toMatchObject({ code: 'INVALID_INPUT', field: 'limit' });
    for (const cursor of ['', 5, 'garbage', 'g', 'x'.repeat(3000)]) expect(ownErrorOf(await read(w, 'ann', undefined, { cursor }))).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
    const mine = must(await read(w, 'ann', circle(c), { limit: 1 })).nextCursor as string;
    expect(mine).toBeTruthy();
    expect(ownErrorOf(await read(w, 'ann', undefined, { cursor: mine }))).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
    expect(ownErrorOf(await read(w, 'bob', undefined, { cursor: mine }))).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
    expect(must(await read(w, 'bob', circle(c), { cursor: mine })).items.length).toBeGreaterThan(0);
  });
  it('a directory that fails, or does not know a user, leaves the name out and nothing else', async () => {
    const throwing = await setup({ directory: { get: async () => { throw new Error('boom'); } } });
    await file(throwing.w, 'ann', OLD);
    const got = must(await read(throwing.w, 'ann'));
    expect(got.items.length).toBeGreaterThan(0);
    expect(got.items.every((e) => !('by' in e))).toBe(true);
    const unknown = await setup({ directory: { get: async () => undefined } });
    await file(unknown.w, 'ann', OLD);
    expect(must(await read(unknown.w, 'ann')).items.every((e) => !('by' in e))).toBe(true);
  });
  it('asks the directory once for each person on a page, however many entries they made, and freezes the name', async () => {
    const asked: string[] = [];
    const { w } = await setup({ directory: { get: async (id) => (asked.push(id), { username: 'u', displayName: 'U' }) } });
    await file(w, 'ann', OLD);
    const got = must(await read(w, 'ann'));
    expect(got.items.length).toBeGreaterThan(1);
    expect(asked).toHaveLength(1);
    expect(Object.isFrozen(got.items[0]?.by)).toBe(true);
  });
  it('an entry leaves out what it does not have: a category has no summary', async () => {
    const { w } = await setup();
    await file(w, 'ann', OLD);
    const category = must(await read(w, 'ann')).items.find((e) => e.kind === 'category') as object;
    expect('summary' in category).toBe(false);
    expect('by' in category).toBe(false);
  });
  it('a circle scope without any circles in play is the made-up-circle answer', async () => {
    const { w } = await setup({ noScopes: true });
    expect(await read(w, 'ann', circle('c0000000000000001'))).toEqual({ ok: false, error: NO_CIRCLE });
  });
  it('a malformed scope names its field', async () => {
    const { w } = await setup();
    for (const [scope, field] of [[{ kind: 'circle' }, 'scope.circleId'], [{ kind: 'nope' }, 'scope'], [{ kind: 'personal', graphId: 'x' }, 'scope.graphId'], ['circle:c1', 'scope']] as const) {
      expect(ownErrorOf(await read(w, 'ann', scope))).toMatchObject({ code: 'INVALID_INPUT', field });
    }
  });

  describe('a circle\'s log', () => {
    it('is readable by every role, names the circle, and is the same for all of them', async () => {
      const { w } = await setup({ directory: true });
      const c = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'observer']]);
      await file(w, 'bob', OLD, circle(c));
      const a = must(await read(w, 'ann', circle(c)));
      expect(a.scope).toEqual({ kind: 'circle', circleId: c, circleName: 'Circle 1' });
      expect(a.items[0]?.by).toEqual({ username: 'bob', displayName: 'bob' });
      expect(must(await read(w, 'bob', circle(c)))).toEqual(a);
      expect(must(await read(w, 'cat', circle(c)))).toEqual(a);
    });
    it('a stranger, a person in another circle only and a made-up circle get exactly the same answer', async () => {
      const { w } = await setup();
      const c = await w.circle(1, 'ann', [['bob', 'member']]);
      await w.circle(2, 'cat');
      await file(w, 'bob', OLD, circle(c));
      const stranger = await read(w, 'cat', circle(c));
      expect(stranger).toEqual({ ok: false, error: NO_CIRCLE });
      expect(await read(w, 'cat', circle('c0000000000000999'))).toEqual(stranger);
      expect(await read(w, 'cat', circle('c0000000000000003'))).toEqual(stranger);
      expect(must(await read(w, 'cat', circle('c0000000000000002'))).items).toEqual([]);
    });
    it('after a member is removed they can no longer read it, and what they did stays in the log', async () => {
      const { w } = await setup();
      const c = await w.circle(1, 'ann', [['bob', 'member']]);
      await file(w, 'bob', OLD, circle(c));
      const uid = (w.graphIds.bob as string).slice(5);
      must(await w.circleStore.removeMember(c, uid));
      expect(ownErrorOf(await read(w, 'bob', circle(c)))).toMatchObject({ code: 'NOT_FOUND' });
      expect(must(await read(w, 'ann', circle(c))).items.length).toBeGreaterThan(0);
    });
    it('a personal log is never shown through a circle, nor a circle\'s through the personal one', async () => {
      const { w } = await setup();
      const c = await w.circle(1, 'ann');
      await file(w, 'ann', OLD);
      expect(must(await read(w, 'ann', circle(c))).items).toEqual([]);
      await file(w, 'ann', 'Dentist appointment on Friday morning here', circle(c));
      expect(must(await read(w, 'ann')).items.every((e) => e.subject !== undefined)).toBe(true);
      expect(must(await read(w, 'ann')).items).toHaveLength(2);
    });
  });

  it('is refused without a session, and says so plainly when there is no change log', async () => {
    const { w } = await setup();
    expect(ownErrorOf(await w.caci.ledger('nonsense'))).toMatchObject({ code: 'UNAUTHENTICATED' });
    const plain = await world({ people: ['ann'] });
    expect(ownErrorOf(await plain.caci.ledger(plain.tokens.ann as string))).toMatchObject({ code: 'NOT_FOUND', message: 'the change log is not available' });
  });
  it('a failing store is the fixed storage error, never its message', async () => {
    const bad: LedgerStore = { append: async () => ({ ok: true, value: undefined }), list: async () => { throw new Error('secret /var/db'); }, purgeBefore: async () => 0, removeScope: async () => 0 };
    const { w } = await setup({ ledger: bad });
    const r = await read(w, 'ann');
    expect(r).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'STORAGE_ERROR' } } });
    expect(JSON.stringify(r)).not.toContain('secret');
  });
});
