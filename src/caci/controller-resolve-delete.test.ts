import { describe, expect, it } from 'vitest';
import { query, write } from '../graph_store/index.js';
import { createMemoryLedgerStore, type LedgerEntry, type LedgerScope, type LedgerStore } from '../ledger/index.js';
import { ownErrorOf, world, type World } from './controller.test-util.js';

// R-025 D5, D6, D10: `clear` in your own brain and `remove` for an owner delete the fact (with the change log's removed entry and a tidy of
// the category left empty); nobody else may remove a fact for everyone.

const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
const circleScope = (circleId: string) => ({ kind: 'circle', circleId });
const NO_CIRCLE = { source: 'caci', error: { code: 'NOT_FOUND', message: 'no such circle' } };
const NO_FACT = { source: 'caci', error: { code: 'NOT_FOUND', message: 'no such fact' } };
const uid = (w: World, who: string): string => (w.graphIds[who] as string).slice('user-'.length);

const setup = async (extra: Parameters<typeof world>[0] = {}) => {
  const ledger = createMemoryLedgerStore();
  const w = await world({ people: ['ann', 'bob', 'cat', 'dan', 'eve'], ledger, ...extra });
  return { w, ledger };
};
/** An item linked to a category (each created if needed). */
const fact = async (w: World, graphId: string, id: string, category: string, title = `Title of ${id}`): Promise<void> => {
  must(await write(w.graphs, { version: 1, kind: 'mutation', graphId, ops: [{ op: 'upsertNode', partition: 'item', id, data: { title, summary: `Summary of ${id}` } }, { op: 'upsertNode', partition: 'category', id: category, data: { name: category.toUpperCase() } }, { op: 'link', item: id, category }] } as never));
};
const nodes = async (w: World, graphId: string): Promise<string[]> => {
  const r = must(await query(w.graphs, { version: 1, graphId, from: { all: true }, return: { shape: 'nodes', includeData: false }, page: { limit: 200 } } as never)) as { nodes: Array<{ partition: string; id: string }> };
  return r.nodes.map((n) => `${n.partition}:${n.id}`).sort();
};
const entries = async (ledger: LedgerStore, scope: LedgerScope): Promise<readonly LedgerEntry[]> => (await ledger.list(scope, { limit: 100, cursor: null })).items;
const personal = (w: World, who: string): LedgerScope => ({ kind: 'personal', userId: uid(w, who) });

describe('clear in your own brain deletes the fact (VR-FR-03, VR-AC-03)', () => {
  it('deletes the fact and the category it leaves empty, and the change log shows both', async () => {
    const { w, ledger } = await setup();
    const graphId = w.graphIds.ann as string;
    await fact(w, graphId, 'pay-rent', 'rent');
    const done = must(await w.caci.resolveFact(w.tokens.ann, { id: 'pay-rent', verb: 'clear' }));
    expect(done).toEqual({ fact: { scope: { kind: 'personal' }, id: 'pay-rent' }, verb: 'clear', effect: 'clear', result: 'deleted' });
    expect(await nodes(w, graphId)).toEqual([]);
    const log = await entries(ledger, personal(w, 'ann'));
    expect(log.map((e) => `${e.action} ${e.kind} ${e.subject}`).sort()).toEqual(['removed category rent', 'removed item pay-rent']);
    expect(log.find((e) => e.kind === 'item')).toMatchObject({ title: 'Title of pay-rent', summary: 'Summary of pay-rent', actor: uid(w, 'ann') });
    expect(log.every((e) => e.proposalId.startsWith('verb-clear-'))).toBe(true);
  });

  it('keeps a category that still holds another fact, and the other fact', async () => {
    const { w } = await setup();
    const graphId = w.graphIds.ann as string;
    await fact(w, graphId, 'one', 'bills');
    await fact(w, graphId, 'two', 'bills');
    must(await w.caci.resolveFact(w.tokens.ann, { scope: { kind: 'personal' }, id: 'one', verb: 'pay' }));
    expect(await nodes(w, graphId)).toEqual(['category:bills', 'item:two']);
  });

  it('works the same through the personal scope as with none, and a missing fact is not found', async () => {
    const { w } = await setup();
    await fact(w, w.graphIds.ann as string, 'a', 'c1');
    expect(must(await w.caci.resolveFact(w.tokens.ann, { scope: { kind: 'personal' }, id: 'a', verb: 'clear' })).result).toBe('deleted');
    expect(await w.caci.resolveFact(w.tokens.ann, { id: 'a', verb: 'clear' })).toEqual({ ok: false, error: NO_FACT });
    expect(await w.caci.resolveFact(w.tokens.ann, { id: 'never', verb: 'clear' })).toEqual({ ok: false, error: NO_FACT });
  });

  it('never reaches another person\'s brain: the same id there is untouched', async () => {
    const { w } = await setup();
    await fact(w, w.graphIds.ann as string, 'same', 'c');
    await fact(w, w.graphIds.bob as string, 'same', 'c');
    must(await w.caci.resolveFact(w.tokens.ann, { id: 'same', verb: 'clear' }));
    expect(await nodes(w, w.graphIds.bob as string)).toEqual(['category:c', 'item:same']);
  });

  it('a failed write changes nothing and records nothing', async () => {
    let failing = true;
    const { w, ledger } = await setup({ captureAdapter: (a) => ({ ...a, transaction: (g, fn) => (failing ? Promise.reject(new Error('disk')) : a.transaction(g, fn)) }) });
    await fact(w, w.graphIds.ann as string, 'x', 'c');
    const r = await w.caci.resolveFact(w.tokens.ann, { id: 'x', verb: 'clear' });
    expect(r).toMatchObject({ ok: false, error: { source: 'graph' } });
    expect(await nodes(w, w.graphIds.ann as string)).toEqual(['category:c', 'item:x']);
    expect(await entries(ledger, personal(w, 'ann'))).toEqual([]);
    failing = false;
    expect(must(await w.caci.resolveFact(w.tokens.ann, { id: 'x', verb: 'clear' })).result).toBe('deleted');
  });

  it('a change log that cannot record does not undo the deletion, and says so through the hook', async () => {
    const said: string[] = [];
    const broken: LedgerStore = { ...createMemoryLedgerStore(), append: async () => { throw new Error('disk full'); } };
    const { w } = await setup({ ledger: broken, onLedgerFailure: (m) => said.push(m) });
    await fact(w, w.graphIds.ann as string, 'x', 'c');
    expect(must(await w.caci.resolveFact(w.tokens.ann, { id: 'x', verb: 'clear' })).result).toBe('deleted');
    expect(await nodes(w, w.graphIds.ann as string)).toEqual([]);
    expect(said).toEqual(['the change was made but could not be recorded in the change log']);
  });
});

describe('remove is the owner\'s alone (VR-FR-04, VR-AC-02)', () => {
  const yoga = async () => {
    const s = await setup();
    const c = await s.w.circle(1, 'ann', [['bob', 'member'], ['cat', 'observer'], ['dan', 'manager']]);
    await fact(s.w, `circle-${c}`, 'yoga-1', 'yoga');
    return { ...s, c };
  };

  it('the owner deletes the fact for everyone; the change log records it and others\' resolutions of it go', async () => {
    const { w, ledger, c } = await yoga();
    must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1', verb: 'pay' }));
    const done = must(await w.caci.resolveFact(w.tokens.ann, { scope: circleScope(c), id: 'yoga-1', verb: 'remove' }));
    expect(done).toEqual({ fact: { scope: { kind: 'circle', circleId: c }, id: 'yoga-1' }, verb: 'remove', effect: 'remove', result: 'deleted' });
    expect(await nodes(w, `circle-${c}`)).toEqual([]);
    const log = await entries(ledger, { kind: 'circle', circleId: c });
    expect(log.map((e) => `${e.action} ${e.kind} ${e.subject}`).sort()).toEqual(['removed category yoga', 'removed item yoga-1']);
    expect(log[0]?.actor).toBe(uid(w, 'ann'));
    expect(await w.resolutions.count(uid(w, 'bob'))).toBe(0);
  });

  it('a manager, a member and an observer are forbidden, and nothing changes', async () => {
    const { w, ledger, c } = await yoga();
    for (const who of ['dan', 'bob', 'cat']) {
      const r = await w.caci.resolveFact(w.tokens[who], { scope: circleScope(c), id: 'yoga-1', verb: 'remove' });
      expect(ownErrorOf(r), who).toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(await nodes(w, `circle-${c}`)).toEqual(['category:yoga', 'item:yoga-1']);
    expect(await entries(ledger, { kind: 'circle', circleId: c })).toEqual([]);
  });

  it('a stranger, a non-member and a made-up circle get the not-found answer, not forbidden', async () => {
    const { w, c } = await yoga();
    const other = await w.circle(2, 'eve');
    for (const [who, scope] of [['eve', c], ['bob', other], ['bob', 'c9999999999999999']] as const) {
      expect(await w.caci.resolveFact(w.tokens[who], { scope: circleScope(scope), id: 'yoga-1', verb: 'remove' })).toEqual({ ok: false, error: NO_CIRCLE });
    }
    expect(await nodes(w, `circle-${c}`)).toEqual(['category:yoga', 'item:yoga-1']);
  });

  it('an owner who removes a fact that is not there gets not-found', async () => {
    const { w, c } = await yoga();
    expect(await w.caci.resolveFact(w.tokens.ann, { scope: circleScope(c), id: 'nope', verb: 'remove' })).toEqual({ ok: false, error: NO_FACT });
  });

  it('a person may remove a fact from their own brain', async () => {
    const { w } = await setup();
    await fact(w, w.graphIds.bob as string, 'mine', 'c');
    expect(must(await w.caci.resolveFact(w.tokens.bob, { id: 'mine', verb: 'remove' })).result).toBe('deleted');
    expect(await nodes(w, w.graphIds.bob as string)).toEqual([]);
  });

  it('a demoted owner is forbidden at once, and a removed one gets not-found', async () => {
    const { w, c } = await yoga();
    must(await w.circleStore.changeRole(c, uid(w, 'bob'), 'owner'));
    expect(must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1', verb: 'clear' })).result).toBe('hidden');
    must(await w.circleStore.changeRole(c, uid(w, 'bob'), 'manager'));
    expect(ownErrorOf(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1', verb: 'remove' }))).toMatchObject({ code: 'FORBIDDEN' });
    must(await w.circleStore.changeRole(c, uid(w, 'bob'), 'owner'));
    must(await w.circleStore.removeMember(c, uid(w, 'bob')));
    expect(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1', verb: 'remove' })).toEqual({ ok: false, error: NO_CIRCLE });
    expect(await nodes(w, `circle-${c}`)).toEqual(['category:yoga', 'item:yoga-1']);
  });
});

describe('clear in a circle only hides, for the caller', () => {
  it('leaves the fact and the change log alone (VR-AC-01)', async () => {
    const { w, ledger } = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    await fact(w, `circle-${c}`, 'f', 'cat');
    const before = await nodes(w, `circle-${c}`);
    expect(must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'f', verb: 'clear' })).result).toBe('hidden');
    expect(await nodes(w, `circle-${c}`)).toEqual(before);
    expect(await entries(ledger, { kind: 'circle', circleId: c })).toEqual([]);
  });
});
