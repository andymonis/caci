import { describe, expect, it } from 'vitest';
import { write } from '../graph_store/index.js';
import { createMemoryLedgerStore, type LedgerEntry, type LedgerStore } from '../ledger/index.js';
import { world, type World } from './controller.test-util.js';
import { SOURCE_NOT_KEPT, type SourceView } from './index.js';

// R-017 D15 to D19: where one fact came from.

const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
const OLD = 'Mum takes 2 x Tablet A a day for her blood pressure.';
const CHANGE = 'Mum now takes tablet day blood morning.';
const circle = (id: string) => ({ kind: 'circle' as const, circleId: id });
const personal = { kind: 'personal' as const };
const setup = async (extra: Parameters<typeof world>[0] = {}) => {
  const ledger = createMemoryLedgerStore();
  const w = await world({ people: ['ann', 'bob', 'cat', 'dan'], ledger, directory: true, ...extra });
  return { w, ledger };
};
const file = async (w: World, who: string, text: string, scope?: ReturnType<typeof circle>) => {
  const made = must(await w.caci.propose(w.tokens[who] as string, scope === undefined ? { text } : { text, scope }));
  must(await w.caci.approve(w.tokens[who] as string, made.id));
  return { id: made.summary.newItems[0] as string, made };
};
const source = (w: World, who: string, ref: unknown) => w.caci.source(w.tokens[who] as string, ref);
const errorOf = (r: { ok: boolean; error?: unknown }): { source: string; error: { code: string; field?: string; message?: string } } => r.error as never;
const NO_CIRCLE = { source: 'caci', error: { code: 'NOT_FOUND', message: 'no such circle' } };

describe('the source of a fact', () => {
  it('says who entered it, when, and the exact words, for a fact in the brain now', async () => {
    const { w } = await setup();
    const words = `  ${OLD} 😀 <b>x</b>\nsecond line  `;
    w.now.value += 5000;
    const { id } = await file(w, 'ann', words);
    const s = must<SourceView>(await source(w, 'ann', { scope: personal, id }));
    expect(s).toMatchObject({ current: true, replacedLater: false, recorded: true, words, enteredBy: { username: 'ann', displayName: 'ann' }, at: expect.any(Number) });
    expect(s.fact.title).toContain('Mum takes');
    expect(s.note).toBeUndefined();
    expect(s.scope).toBeUndefined();
    expect(Object.isFrozen(s) && Object.isFrozen(s.fact) && Object.isFrozen(s.enteredBy)).toBe(true);
  });

  it('an omitted scope means the own brain', async () => {
    const { w } = await setup();
    const { id } = await file(w, 'ann', OLD);
    expect(must<SourceView>(await source(w, 'ann', { id })).words).toBe(OLD);
  });

  it('a replaced fact says it was replaced, with what it said and the words that made it, and the new fact has its own words', async () => {
    const { w } = await setup();
    const first = await file(w, 'ann', OLD);
    w.now.value += 60_000;
    const second = await file(w, 'ann', CHANGE);
    const old = must<SourceView>(await source(w, 'ann', { scope: personal, id: first.id }));
    expect(old).toMatchObject({ current: false, replacedLater: true, recorded: true, words: OLD });
    expect(old.fact.title).toContain('Mum takes');
    expect(old.fact.summary).toContain('2 x Tablet A');
    const now = must<SourceView>(await source(w, 'ann', { scope: personal, id: second.id }));
    expect(now).toMatchObject({ current: true, replacedLater: false, words: CHANGE });
  });

  it('a circle fact entered by another member traces to that member, for every role that can read the circle', async () => {
    const { w } = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'observer']]);
    const { id } = await file(w, 'bob', 'Dentist appointment on Friday morning', circle(c));
    for (const who of ['ann', 'bob', 'cat']) {
      const s = must<SourceView>(await source(w, who, { scope: circle(c), id }));
      expect(s, who).toMatchObject({ current: true, recorded: true, words: 'Dentist appointment on Friday morning', enteredBy: { username: 'bob' }, scope: { kind: 'circle', circleId: c, circleName: 'Circle 1' } });
    }
  });

  it('a stranger, a person in other circles only, the administrator-like non-member and a made-up circle get the one not-found, and an id in another brain is not found', async () => {
    const { w } = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    const other = await w.circle(2, 'ann', []);
    const club = await file(w, 'bob', 'Dentist appointment on Friday morning', circle(c));
    const mine = await file(w, 'ann', 'Garden fence needs painting this week');
    for (const [who, scope] of [['dan', c], ['cat', c], ['bob', other], ['ann', 'c0000000000000999']] as const) expect((await source(w, who, { scope: circle(scope), id: club.id })).ok ? 'ok' : errorOf(await source(w, who, { scope: circle(scope), id: club.id })), `${who} ${scope}`).toEqual(who === 'ann' || who === 'bob' ? NO_CIRCLE : NO_CIRCLE);
    // right circle, but an id from another brain
    expect(errorOf(await source(w, 'ann', { scope: circle(c), id: mine.id })).error).toEqual({ code: 'NOT_FOUND', message: 'no such item' });
    expect(errorOf(await source(w, 'ann', { scope: personal, id: club.id })).error).toEqual({ code: 'NOT_FOUND', message: 'no such item' });
    expect(errorOf(await source(w, 'bob', { scope: personal, id: mine.id })).error).toEqual({ code: 'NOT_FOUND', message: 'no such item' });
    expect(errorOf(await source(w, 'ann', { scope: personal, id: 'never-existed' })).error.message).toBe('no such item');
  });

  it('when the words are gone it still says who and when, and says plainly that the words are not kept', async () => {
    const { w, ledger } = await setup();
    w.now.value += 5000;
    const { id } = await file(w, 'ann', OLD);
    const entries = (await ledger.list({ kind: 'personal', userId: (w.graphIds.ann as string).slice(5) }, { limit: 50, cursor: null })).items;
    const input = entries.find((e) => e.kind === 'input') as LedgerEntry;
    await ledger.purgeBefore(input.at + 1); // only the words go: the facts are one millisecond newer
    const s = must<SourceView>(await source(w, 'ann', { scope: personal, id }));
    expect(s).toMatchObject({ current: true, recorded: false, note: SOURCE_NOT_KEPT, enteredBy: { username: 'ann' }, at: expect.any(Number) });
    expect(s.words).toBeUndefined();
  });

  it('a fact from before the words were recorded, or with nothing left in the log, is still found in the brain and says so plainly', async () => {
    const { w, ledger } = await setup();
    const { id } = await file(w, 'ann', OLD);
    await ledger.purgeBefore(Number.MAX_SAFE_INTEGER);
    const s = must<SourceView>(await source(w, 'ann', { scope: personal, id }));
    expect(s).toMatchObject({ current: true, recorded: false, replacedLater: false, note: SOURCE_NOT_KEPT });
    expect(s.enteredBy).toBeUndefined();
    expect(s.at).toBeUndefined();
  });

  it('a removed fact whose entries are gone is not found', async () => {
    const { w, ledger } = await setup();
    const first = await file(w, 'ann', OLD);
    w.now.value += 60_000;
    await file(w, 'ann', CHANGE);
    await ledger.purgeBefore(Number.MAX_SAFE_INTEGER);
    expect(errorOf(await source(w, 'ann', { scope: personal, id: first.id })).error.message).toBe('no such item');
  });

  it('an author whose account is gone, or a directory that fails or is missing, leaves the name out and nothing else', async () => {
    const gone = await setup({ directory: { get: async () => undefined } });
    const a = await file(gone.w, 'ann', OLD);
    expect(must<SourceView>(await source(gone.w, 'ann', { id: a.id }))).toMatchObject({ words: OLD, recorded: true });
    expect(must<SourceView>(await source(gone.w, 'ann', { id: a.id })).enteredBy).toBeUndefined();
    const failing = await setup({ directory: { get: async () => { throw new Error('secret /var/db'); } } });
    const b = await file(failing.w, 'ann', OLD);
    const s = must<SourceView>(await source(failing.w, 'ann', { id: b.id }));
    expect(s.words).toBe(OLD);
    expect(s.enteredBy).toBeUndefined();
    const none = await setup({ directory: false });
    const c = await file(none.w, 'ann', OLD);
    expect(must<SourceView>(await source(none.w, 'ann', { id: c.id })).enteredBy).toBeUndefined();
  });

  it('finds odd ids exactly, with the words of the approval that added them', async () => {
    const { w, ledger } = await setup();
    const uid = (w.graphIds.ann as string).slice(5);
    const subject = 'a/b?c=d&e#f %é😀<b>..';
    const added = await write(w.graphs, { version: 1, kind: 'mutation', graphId: w.graphIds.ann as string, ops: [{ op: 'upsertNode', partition: 'item', id: subject, data: { title: 'Odd', summary: 's' } }] } as never);
    expect(added.ok).toBe(true);
    const common = { scope: { kind: 'personal' as const, userId: uid }, actor: uid, proposalId: 'prop-odd', at: 1000 };
    must(await ledger.append([{ ...common, id: 'lodd000000000001', action: 'added', kind: 'input', subject: 'prop-odd', text: 'odd words 😀' }, { ...common, id: 'lodd000000000002', at: 1001, action: 'added', kind: 'item', subject }]));
    expect(must<SourceView>(await source(w, 'ann', { id: subject }))).toMatchObject({ words: 'odd words 😀', fact: { title: 'Odd' } });
  });

  it('refuses a missing, empty, non-text or over-long id, an unknown key and a malformed scope, naming the field', async () => {
    const { w } = await setup();
    const c = await w.circle(1, 'ann', []);
    for (const id of [undefined, '', 5, null, {}, 'x'.repeat(257), '😀'.repeat(257)]) expect(errorOf(await source(w, 'ann', { scope: personal, id })).error, String(id)).toMatchObject({ code: 'INVALID_INPUT', field: 'id' });
    expect(errorOf(await source(w, 'ann', { id: 'x', graphId: 'user-x' })).error).toMatchObject({ code: 'INVALID_INPUT', field: 'graphId' });
    expect(errorOf(await source(w, 'ann', { scope: { kind: 'circle', circleId: 'nope' }, id: 'x' })).error.field).toBe('scope.circleId');
    expect(errorOf(await source(w, 'ann', { scope: 'mine', id: 'x' })).error.code).toBe('INVALID_INPUT');
    for (const ref of [undefined, null, 'x', ['x']]) expect(errorOf(await source(w, 'ann', ref)).error.code).toBe('INVALID_INPUT');
    expect(errorOf(await source(w, 'ann', { scope: { ...circle(c), graphId: 'x' }, id: 'x' })).error.field).toBe('scope.graphId');
    expect((await source(w, 'ann', { scope: personal, id: 'x'.repeat(256) })).ok).toBe(false); // exactly 256 is allowed and simply not found
    expect(errorOf(await source(w, 'ann', { scope: personal, id: 'x'.repeat(256) })).error.message).toBe('no such item');
  });

  it('needs a session, and says so plainly when there is no change log', async () => {
    const { w } = await setup();
    expect(errorOf(await w.caci.source('not a token', { id: 'x' })).error.code).toBe('UNAUTHENTICATED');
    const none = await world({ people: ['ann'] });
    expect(errorOf(await none.caci.source(none.tokens.ann as string, { id: 'x' })).error).toEqual({ code: 'NOT_FOUND', message: 'the change log is not available' });
  });

  it('a failing store is the fixed storage error, never its message', async () => {
    const real = createMemoryLedgerStore();
    const bad: LedgerStore = { ...real, sourceOf: async () => { throw new Error('secret /var/db'); } };
    const { w } = await setup({ ledger: bad });
    const e = errorOf(await source(w, 'ann', { id: 'x' }));
    expect(JSON.stringify(e)).not.toContain('secret');
    expect(e.error.code).toBe('STORAGE_ERROR');
  });

  it('shows nothing of the plumbing: no graph id, user id or proposal id', async () => {
    const { w } = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    const a = await file(w, 'ann', OLD);
    const b = await file(w, 'bob', 'Dentist appointment on Friday morning', circle(c));
    const json = JSON.stringify([must(await source(w, 'ann', { id: a.id })), must(await source(w, 'bob', { scope: circle(c), id: b.id }))]);
    for (const leak of ['user-u', 'circle-c', 'prop-', 'proposalId', (w.graphIds.ann as string).slice(5)]) expect(json, leak).not.toContain(leak);
  });

  it('reads nothing and writes nothing', async () => {
    const { w, ledger } = await setup();
    const { id } = await file(w, 'ann', OLD);
    const before = JSON.stringify([(await ledger.list({ kind: 'personal', userId: (w.graphIds.ann as string).slice(5) }, { limit: 100, cursor: null })).items, await w.caci.mineSummary(w.tokens.ann as string)]);
    await source(w, 'ann', { id });
    await source(w, 'ann', { id: 'nope' });
    expect(JSON.stringify([(await ledger.list({ kind: 'personal', userId: (w.graphIds.ann as string).slice(5) }, { limit: 100, cursor: null })).items, await w.caci.mineSummary(w.tokens.ann as string)])).toBe(before);
  });
});
