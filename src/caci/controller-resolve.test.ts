import { describe, expect, it } from 'vitest';
import { query, write } from '../graph_store/index.js';
import { createMemoryResolutionStore, MAX_RESOLUTIONS_PER_USER, type Resolution, type ResolutionStore } from '../resolutions/index.js';
import { ownErrorOf, world, type World } from './controller.test-util.js';

const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
const PEOPLE = ['ann', 'bob', 'cat', 'dan', 'eve'];
const setup = async (extra: Parameters<typeof world>[0] = {}) => world({ people: PEOPLE, ...extra });
const circleScope = (circleId: string) => ({ kind: 'circle', circleId });
const NO_CIRCLE = { source: 'caci', error: { code: 'NOT_FOUND', message: 'no such circle' } };
const NO_FACT = { source: 'caci', error: { code: 'NOT_FOUND', message: 'no such fact' } };

/** Puts one fact (an item) into a graph. */
const fact = async (w: World, graphId: string, id: string, title = 'Pay for this week\'s yoga class'): Promise<void> => {
  must(await write(w.graphs, { version: 1, kind: 'mutation', graphId, ops: [{ op: 'upsertNode', partition: 'item', id, data: { title, summary: title } }] } as never));
};
const graphOf = (circleId: string): string => `circle-${circleId}`;
/** A world with a circle owned by ann, with bob a member, cat an observer, and one fact. */
const yoga = async (extra: Parameters<typeof world>[0] = {}) => {
  const w = await setup(extra);
  const c = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'observer'], ['dan', 'manager']]);
  await fact(w, graphOf(c), 'yoga-1');
  return { w, c };
};
const snapshot = async (w: World, graphId: string): Promise<string> => JSON.stringify(must(await query(w.graphs, { version: 1, graphId, from: { all: true }, return: { shape: 'nodes', includeData: true }, page: { limit: 100 } } as never)));

describe('resolving a circle fact (R-025 VR-FR-02, VR-FR-03, VR-AC-01)', () => {
  it('records the verb for this person only and changes no graph', async () => {
    const { w, c } = await yoga();
    const before = await snapshot(w, graphOf(c));
    const done = must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1', verb: 'pay' }));
    expect(done).toEqual({ fact: { scope: { kind: 'circle', circleId: c }, id: 'yoga-1' }, verb: 'pay', effect: 'clear', result: 'hidden' });
    expect(await snapshot(w, graphOf(c))).toBe(before);
    const mine = await w.resolutions.get(w.graphIds.bob?.slice('user-'.length) as string, { kind: 'circle', circleId: c }, 'yoga-1');
    expect(mine).toMatchObject({ verb: 'pay', factId: 'yoga-1' });
    expect(await w.resolutions.count(w.graphIds.ann?.slice('user-'.length) as string)).toBe(0);
  });

  it('every role that may read can resolve for themselves: owner, manager, member and observer', async () => {
    const { w, c } = await yoga();
    for (const who of ['ann', 'dan', 'bob', 'cat']) {
      expect(must(await w.caci.resolveFact(w.tokens[who], { scope: circleScope(c), id: 'yoga-1', verb: 'clear' })).result, who).toBe('hidden');
    }
  });

  it('a second verb replaces the first and keeps one record', async () => {
    const { w, c } = await yoga();
    const uid = w.graphIds.bob?.slice('user-'.length) as string;
    must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1', verb: 'clear' }));
    w.now.value += 5000;
    must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1', verb: 'pay' }));
    expect(await w.resolutions.count(uid)).toBe(1);
    expect(await w.resolutions.get(uid, { kind: 'circle', circleId: c }, 'yoga-1')).toMatchObject({ verb: 'pay', at: w.now.value });
  });

  it('a stranger, a non-member and a made-up circle get byte-identical answers (VR-AC-04)', async () => {
    const { w } = await yoga();
    const other = await w.circle(2, 'eve');
    await fact(w, graphOf(other), 'yoga-1');
    const made = 'c9999999999999999';
    const answers = [
      await w.caci.resolveFact(w.tokens.eve, { scope: circleScope('c0000000000000001'), id: 'yoga-1', verb: 'pay' }),
      await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(other), id: 'yoga-1', verb: 'pay' }),
      await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(made), id: 'yoga-1', verb: 'pay' }),
    ];
    for (const a of answers) expect(a).toEqual({ ok: false, error: NO_CIRCLE });
    expect(JSON.stringify(answers[0])).toBe(JSON.stringify(answers[2]));
    expect(await w.resolutions.count(w.graphIds.eve?.slice('user-'.length) as string)).toBe(0);
  });

  it('a made-up fact id in a readable circle is not found, and nothing is stored', async () => {
    const { w, c } = await yoga();
    for (const id of ['nope', 'a'.repeat(300), 'yoga-2']) {
      expect(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id, verb: 'pay' })).toEqual({ ok: false, error: NO_FACT });
    }
    expect(await w.resolutions.count(w.graphIds.bob?.slice('user-'.length) as string)).toBe(0);
  });

  it('a fact in another circle or in your own brain is not a fact of this circle', async () => {
    const { w, c } = await yoga();
    await fact(w, w.graphIds.bob as string, 'personal-only');
    expect(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'personal-only', verb: 'pay' })).toEqual({ ok: false, error: NO_FACT });
  });

  it('refuses unknown fields by name, bad shapes, and an unknown verb listing the known ones', async () => {
    const { w, c } = await yoga();
    const bad = async (input: unknown): Promise<{ code: string; field?: string } | undefined> => ownErrorOf(await w.caci.resolveFact(w.tokens.bob, input));
    expect(await bad({ scope: circleScope(c), id: 'yoga-1', verb: 'pay', extra: 1 })).toMatchObject({ code: 'INVALID_INPUT', field: 'extra' });
    expect(await bad(null)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await bad([])).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await bad({ scope: circleScope(c), verb: 'pay' })).toMatchObject({ code: 'INVALID_INPUT', field: 'id' });
    expect(await bad({ scope: circleScope(c), id: 5, verb: 'pay' })).toMatchObject({ code: 'INVALID_INPUT', field: 'id' });
    expect(await bad({ scope: circleScope(c), id: '', verb: 'pay' })).toMatchObject({ code: 'INVALID_INPUT', field: 'id' });
    expect(await bad({ scope: circleScope(c), id: 'yoga-1' })).toMatchObject({ code: 'INVALID_INPUT', field: 'verb' });
    expect(await bad({ scope: { kind: 'circle' }, id: 'yoga-1', verb: 'pay' })).toMatchObject({ code: 'INVALID_INPUT' });
    const unknown = await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1', verb: 'dance' });
    expect(ownErrorOf(unknown)).toMatchObject({ code: 'INVALID_INPUT', field: 'verb' });
    expect(JSON.stringify(unknown)).toContain('clear, pay, remove');
  });

  it('needs a session, and says verbs are unavailable when none were given', async () => {
    const { w, c } = await yoga();
    expect(ownErrorOf(await w.caci.resolveFact('not-a-token', { scope: circleScope(c), id: 'yoga-1', verb: 'pay' }))).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(ownErrorOf(await w.caci.unresolveFact('not-a-token', { scope: circleScope(c), id: 'yoga-1' }))).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(ownErrorOf(await w.caci.resolutions('not-a-token'))).toMatchObject({ code: 'UNAUTHENTICATED' });
    const none = await yoga({ noVerbs: true });
    for (const r of [await none.w.caci.resolveFact(none.w.tokens.bob, { scope: circleScope(none.c), id: 'yoga-1', verb: 'pay' }), await none.w.caci.unresolveFact(none.w.tokens.bob, { scope: circleScope(none.c), id: 'yoga-1' }), await none.w.caci.resolutions(none.w.tokens.bob)]) {
      expect(ownErrorOf(r)).toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('a removed member can no longer resolve in that circle', async () => {
    const { w, c } = await yoga();
    const uid = w.graphIds.bob?.slice('user-'.length) as string;
    await w.circleStore.removeMember(c, uid);
    expect(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1', verb: 'pay' })).toEqual({ ok: false, error: NO_CIRCLE });
  });

  it('LIMIT_REACHED at 2,000 and a store failure is a storage error, with nothing written', async () => {
    const store = createMemoryResolutionStore();
    const { w, c } = await yoga({ resolutions: store });
    const uid = w.graphIds.bob?.slice('user-'.length) as string;
    for (let i = 0; i < MAX_RESOLUTIONS_PER_USER; i++) await store.set({ userId: uid, scope: { kind: 'circle', circleId: c }, factId: `old-${i}`, verb: 'clear', at: 1 });
    expect(ownErrorOf(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1', verb: 'pay' }))).toMatchObject({ code: 'LIMIT_REACHED' });
    const broken: ResolutionStore = { ...store, set: async () => ({ ok: false, error: { code: 'STORAGE_ERROR', message: 'SECRET sql' } }) };
    const w2 = await yoga({ resolutions: broken });
    const r = await w2.w.caci.resolveFact(w2.w.tokens.bob, { scope: circleScope(w2.c), id: 'yoga-1', verb: 'pay' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
});

describe('taking a resolution back (VR-FR-05, VR-AC-05)', () => {
  it('removes only the caller\'s own record, and with none answers the same way', async () => {
    const { w, c } = await yoga();
    const ref = { scope: circleScope(c), id: 'yoga-1' };
    must(await w.caci.resolveFact(w.tokens.bob, { ...ref, verb: 'pay' }));
    must(await w.caci.resolveFact(w.tokens.cat, { ...ref, verb: 'clear' }));
    const first = await w.caci.unresolveFact(w.tokens.bob, ref);
    const again = await w.caci.unresolveFact(w.tokens.bob, ref);
    expect(first).toEqual(again);
    expect(first).toEqual({ ok: true, value: { fact: { scope: { kind: 'circle', circleId: c }, id: 'yoga-1' } } });
    expect(await w.resolutions.count(w.graphIds.bob?.slice('user-'.length) as string)).toBe(0);
    expect(await w.resolutions.count(w.graphIds.cat?.slice('user-'.length) as string)).toBe(1);
  });

  it('a stranger, a non-member and a made-up circle get the same answer as each other, and nothing of theirs changes', async () => {
    const { w, c } = await yoga();
    must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1', verb: 'pay' }));
    const answers = [await w.caci.unresolveFact(w.tokens.eve, { scope: circleScope(c), id: 'yoga-1' }), await w.caci.unresolveFact(w.tokens.eve, { scope: circleScope('c9999999999999999'), id: 'yoga-1' })];
    for (const a of answers) expect(a).toEqual({ ok: false, error: NO_CIRCLE });
    expect(await w.resolutions.count(w.graphIds.bob?.slice('user-'.length) as string)).toBe(1);
  });

  it('refuses unknown fields and a missing id', async () => {
    const { w, c } = await yoga();
    expect(ownErrorOf(await w.caci.unresolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1', verb: 'pay' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'verb' });
    expect(ownErrorOf(await w.caci.unresolveFact(w.tokens.bob, { scope: circleScope(c) }))).toMatchObject({ code: 'INVALID_INPUT', field: 'id' });
  });

  it('works for a fact that has since been deleted', async () => {
    const { w, c } = await yoga();
    must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1', verb: 'pay' }));
    must(await write(w.graphs, { version: 1, kind: 'mutation', graphId: graphOf(c), ops: [{ op: 'deleteNode', partition: 'item', id: 'yoga-1' }] } as never));
    must(await w.caci.unresolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1' }));
    expect(await w.resolutions.count(w.graphIds.bob?.slice('user-'.length) as string)).toBe(0);
  });
});

describe('listing my resolutions (VR-FR-07, VR-FR-09)', () => {
  it('lists only the caller\'s own, in order, in pages, with ids and verbs and no words', async () => {
    const { w, c } = await yoga();
    for (const id of ['b', 'a', 'c']) await fact(w, graphOf(c), id);
    for (const id of ['b', 'a', 'c']) must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id, verb: 'pay' }));
    must(await w.caci.resolveFact(w.tokens.cat, { scope: circleScope(c), id: 'a', verb: 'clear' }));
    const first = must(await w.caci.resolutions(w.tokens.bob, { limit: 2 }));
    expect(first.items.map((r) => r.fact.id)).toEqual(['a', 'b']);
    expect(first.next).toEqual({ scope: { kind: 'circle', circleId: c }, id: 'b' });
    const second = must(await w.caci.resolutions(w.tokens.bob, { limit: 2, after: first.next }));
    expect(second.items.map((r) => r.fact.id)).toEqual(['c']);
    expect(second.next).toBeNull();
    expect(JSON.stringify(first)).not.toContain('yoga');
    expect(Object.keys(first.items[0] as object).sort()).toEqual(['at', 'fact', 'verb']);
    expect(must(await w.caci.resolutions(w.tokens.eve)).items).toEqual([]);
    expect(must(await w.caci.resolutions(w.tokens.cat)).items.map((r) => r.verb)).toEqual(['clear']);
  });

  it('refuses a bad limit, a bad cursor and unknown fields by name', async () => {
    const { w } = await yoga();
    for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '5' }]) expect(ownErrorOf(await w.caci.resolutions(w.tokens.bob, input))).toMatchObject({ code: 'INVALID_INPUT', field: 'limit' });
    expect(ownErrorOf(await w.caci.resolutions(w.tokens.bob, { after: 'x' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'after' });
    expect(ownErrorOf(await w.caci.resolutions(w.tokens.bob, { after: { scope: { kind: 'circle' }, id: 'a' } }))).toMatchObject({ code: 'INVALID_INPUT', field: 'after' });
    expect(ownErrorOf(await w.caci.resolutions(w.tokens.bob, { after: { scope: { kind: 'personal' }, id: 'a', x: 1 } }))).toMatchObject({ code: 'INVALID_INPUT', field: 'after.x' });
    expect(ownErrorOf(await w.caci.resolutions(w.tokens.bob, { other: 1 }))).toMatchObject({ code: 'INVALID_INPUT', field: 'other' });
    expect(ownErrorOf(await w.caci.resolutions(w.tokens.bob, 'x'))).toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('the verb operations never touch another person or a graph', () => {
  it('a resolution record holds no text from the fact', async () => {
    const { w, c } = await yoga();
    must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: 'yoga-1', verb: 'pay' }));
    const rows: Resolution[] = (await w.resolutions.list(w.graphIds.bob?.slice('user-'.length) as string, { limit: 10 })).items as Resolution[];
    expect(JSON.stringify(rows)).not.toMatch(/yoga class|Pay for/);
    expect(Object.keys(rows[0] as object).sort()).toEqual(['at', 'factId', 'scope', 'userId', 'verb']);
  });
});

describe('the vocabulary (R-025 D9)', () => {
  it('a signed-in person gets the verbs with their effects and help lines, and nothing else', async () => {
    const { w } = await yoga();
    const r = must(await w.caci.verbs(w.tokens.bob));
    expect(r.items).toEqual([
      { name: 'clear', effect: 'clear', help: 'Clear this for me.' },
      { name: 'pay', effect: 'clear', help: 'Mark this as paid.' },
      { name: 'remove', effect: 'remove', help: 'Remove this fact for everyone.' },
    ]);
    expect(Object.isFrozen(r.items[0])).toBe(true);
  });
  it('needs a session, and is not available without verbs', async () => {
    const { w } = await yoga();
    expect(ownErrorOf(await w.caci.verbs('nope'))).toMatchObject({ code: 'UNAUTHENTICATED' });
    const none = await yoga({ noVerbs: true });
    expect(ownErrorOf(await none.w.caci.verbs(none.w.tokens.bob))).toMatchObject({ code: 'NOT_FOUND' });
  });
});
