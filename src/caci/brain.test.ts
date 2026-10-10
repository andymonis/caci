import { describe, expect, it } from 'vitest';
import { write, type StorageAdapter } from '../graph_store/index.js';
import { createCaciController } from './index.js';
import { createController } from '../app/index.js';
import { createDemoModelClient, createLlm } from '../llm/index.js';
import { ownErrorOf, world, type World } from './controller.test-util.js';

const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
const uid = (w: World, name: string) => (w.graphIds[name] as string).slice(5);
const PERSON = { kind: 'personal' };
const circ = (id: string, name: string) => ({ kind: 'circle', circleId: id, circleName: name });

async function fill(w: World, graphId: string, ids: string[], label: string) {
  const ops: unknown[] = [];
  for (const id of ids) {
    ops.push({ op: 'upsertNode', partition: 'category', id, data: { name: `${id} of ${label}` } });
    ops.push({ op: 'upsertNode', partition: 'item', id: `item-${id}`, data: { title: `${label} ${id}` } }, { op: 'link', item: `item-${id}`, category: id });
  }
  must(await write(w.graphs, { version: 1, kind: 'mutation', graphId, ops } as never));
}
const extraLink = async (w: World, graphId: string) => must(await write(w.graphs, { version: 1, kind: 'mutation', graphId, ops: [{ op: 'link', item: 'item-shared', category: 'p-only' }] } as never));
/** Reads recorded by graph id. */
const spy = () => {
  const seen: string[] = [];
  const wrap = (inner: StorageAdapter): StorageAdapter => ({ ...inner, transaction: (graphId: string, body: never) => (seen.push(graphId), inner.transaction(graphId, body)) }) as never;
  return { seen, wrap };
};
/** ann: personal, circle 1 (member), circle 2 (observer), circle 3 (owner); every graph holds `shared` and one more. */
async function setup(extra: Parameters<typeof world>[0] = {}) {
  const w = await world({ people: ['root', 'ann', 'bob', 'cat'], ...extra });
  const c1 = await w.circle(1, 'bob', [['ann', 'member']]);
  const c2 = await w.circle(2, 'bob', [['ann', 'observer']]);
  const c3 = await w.circle(3, 'ann');
  await w.circle(4, 'bob'); // ann is not in it
  await fill(w, w.graphIds.ann as string, ['shared', 'p-only'], 'PERSONAL');
  await fill(w, `circle-${c1}`, ['shared', 'a-only'], 'C1');
  await fill(w, `circle-${c2}`, ['shared'], 'C2');
  await fill(w, `circle-${c3}`, ['shared', 'z-only'], 'C3');
  await fill(w, `circle-c0000000000000004`, ['secret'], 'C4-SECRET');
  await extraLink(w, w.graphIds.ann as string); // so that links and items are counted differently
  return { w, c1, c2, c3 };
}

describe('the scopes a person may use', () => {
  it('their own brain first, then each circle they are in with their role and whether they may capture; circles they are not in are absent', async () => {
    const { w, c1, c2, c3 } = await setup();
    const got = must(await w.caci.brainScopes(w.tokens.ann));
    expect(got.items).toEqual([
      { scope: PERSON, canCapture: true },
      { scope: circ(c1, 'Circle 1'), role: 'member', canCapture: true },
      { scope: circ(c2, 'Circle 2'), role: 'observer', canCapture: false },
      { scope: circ(c3, 'Circle 3'), role: 'owner', canCapture: true },
    ]);
    expect(JSON.stringify(got)).not.toContain('Circle 4');
    expect(Object.isFrozen(got) && Object.isFrozen(got.items) && Object.isFrozen(got.items[1])).toBe(true);
    expect(must(await w.caci.brainScopes(w.tokens.cat)).items).toEqual([{ scope: PERSON, canCapture: true }]);
  });

  it('a signed-out caller is unauthenticated, and too many circles is refused naming scope', async () => {
    const { w } = await setup({ maxScopes: 3 });
    expect(ownErrorOf(await w.caci.brainScopes('nope'))).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(ownErrorOf(await w.caci.brainScopes(w.tokens.ann))).toMatchObject({ code: 'INVALID_INPUT', field: 'scope' });
    expect(ownErrorOf(await w.caci.mineSummary(w.tokens.ann))).toMatchObject({ code: 'INVALID_INPUT', field: 'scope' });
    expect(ownErrorOf(await w.caci.mineCategories(w.tokens.ann))).toMatchObject({ code: 'INVALID_INPUT', field: 'scope' });
  });

  it('without a resolver there is only the personal brain', async () => {
    const { w } = await setup();
    const capture = createController({ adapter: w.graphs, llm: createLlm({ client: createDemoModelClient() }) });
    const bare = createCaciController({ users: w.users, capture, graphAdapter: w.graphs });
    expect(must(await bare.brainScopes(w.tokens.ann)).items).toEqual([{ scope: PERSON, canCapture: true }]);
    expect(must(await bare.mineCategories(w.tokens.ann)).items.every((c) => c.scope.kind === 'personal')).toBe(true);
    expect(ownErrorOf(await bare.mineSummary('nope'))).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('My Brain, counts', () => {
  it('totals over every readable scope and the counts of each, tagged; identical ids are not merged', async () => {
    const { w, c1, c2, c3 } = await setup();
    const s = must(await w.caci.mineSummary(w.tokens.ann));
    expect(s.scopes).toEqual([
      { itemCount: 2, categoryCount: 2, edgeCount: 3, scope: PERSON },
      { itemCount: 2, categoryCount: 2, edgeCount: 2, scope: circ(c1, 'Circle 1') },
      { itemCount: 1, categoryCount: 1, edgeCount: 1, scope: circ(c2, 'Circle 2') },
      { itemCount: 2, categoryCount: 2, edgeCount: 2, scope: circ(c3, 'Circle 3') },
    ]);
    expect([s.itemCount, s.categoryCount, s.edgeCount]).toEqual([7, 7, 8]);
    expect(JSON.stringify(s)).not.toContain('C4-SECRET');
    expect(Object.isFrozen(s) && Object.isFrozen(s.scopes) && Object.isFrozen(s.scopes[0])).toBe(true);
  });

  it('a person in no circle reads only their own graph, and no circle graph is touched (SC-AC-13)', async () => {
    const reads = spy();
    const { w } = await setup({ browseAdapter: reads.wrap });
    const s = must(await w.caci.mineSummary(w.tokens.cat));
    expect(s.scopes).toHaveLength(1);
    must(await w.caci.mineCategories(w.tokens.cat));
    must(await w.caci.brainScopes(w.tokens.cat));
    expect([...new Set(reads.seen)]).toEqual([w.graphIds.cat]);
  });

  it('a circle graph that does not exist counts as empty; a missing personal graph is an error', async () => {
    const { w } = await setup();
    const c9 = await w.circle(9, 'ann');
    await w.graphs.graphs.drop(`circle-${c9}`);
    const s = must(await w.caci.mineSummary(w.tokens.ann));
    expect(s.scopes.find((x) => x.scope.kind === 'circle' && x.scope.circleId === c9)).toMatchObject({ itemCount: 0, categoryCount: 0, edgeCount: 0 });
    await w.graphs.graphs.drop(w.graphIds.ann as string);
    expect(await w.caci.mineSummary(w.tokens.ann)).toMatchObject({ ok: false, error: { source: 'graph' } });
    expect(await w.caci.mineCategories(w.tokens.ann)).toMatchObject({ ok: false, error: { source: 'graph' } });
  });

  it('works with one read at a time, and the limit on reads must be a positive whole number', async () => {
    const { w, c1 } = await setup({ limits: { maxConcurrentReads: 1 } });
    const s = must(await w.caci.mineSummary(w.tokens.ann));
    expect(s.scopes.map((x) => x.scope.kind === 'circle' ? x.scope.circleId : 'personal')).toEqual(['personal', c1, 'c0000000000000002', 'c0000000000000003']);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(setup({ limits: { maxConcurrentReads: bad } })).rejects.toThrow(TypeError);
    }
  });

  it('a removal shows on the next request', async () => {
    const { w, c1 } = await setup();
    expect(must(await w.caci.mineSummary(w.tokens.ann)).scopes).toHaveLength(4);
    must(await w.circleStore.removeMember(c1, uid(w, 'ann')));
    expect(must(await w.caci.mineSummary(w.tokens.ann)).scopes).toHaveLength(3);
    expect(JSON.stringify(must(await w.caci.mineCategories(w.tokens.ann, { limit: 100 })))).not.toContain('of C1');
  });
});

describe('My Brain, categories', () => {
  const all = async (w: World, token: string, limit?: number) => {
    const out: Array<{ id: string; name?: string; scope: { kind: string; circleId?: string } }> = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page: { items: typeof out; nextCursor: string | null } = must(await w.caci.mineCategories(token, { ...(limit === undefined ? {} : { limit }), ...(cursor === null ? {} : { cursor }) })) as never;
      if (limit !== undefined) expect(page.items.length).toBeLessThanOrEqual(limit);
      out.push(...page.items);
      if (page.nextCursor === null) return out;
      cursor = page.nextCursor;
    }
    throw new Error('paging did not end');
  };

  it('every scope\'s categories, each tagged, in a fixed order (own brain, then circles by id, then by category id), the same id kept apart (SC-AC-02, SC-AC-03)', async () => {
    const { w, c1, c2, c3 } = await setup();
    const rows = (await all(w, w.tokens.ann as string)).map((c) => [c.scope.kind === 'personal' ? 'personal' : c.scope.circleId, c.id]);
    expect(rows).toEqual([
      ['personal', 'p-only'], ['personal', 'shared'],
      [c1, 'a-only'], [c1, 'shared'],
      [c2, 'shared'],
      [c3, 'shared'], [c3, 'z-only'],
    ]);
    const page = must(await w.caci.mineCategories(w.tokens.ann, { limit: 100 }));
    const shared = page.items.filter((c) => c.id === 'shared');
    expect(shared.map((c) => c.name)).toEqual(['shared of PERSONAL', 'shared of C1', 'shared of C2', 'shared of C3']);
    expect(shared.every((c) => c.itemCount === 1)).toBe(true);
    expect(page.items[2]?.scope).toEqual(circ(c1, 'Circle 1'));
    expect(JSON.stringify(page)).not.toContain('SECRET');
    expect(page.nextCursor).toBeNull();
    expect(Object.isFrozen(page) && Object.isFrozen(page.items) && Object.isFrozen(page.items[0])).toBe(true);
  });

  it('the order is the same for any page size, with no gaps and no repeats, including a page that exactly fills', async () => {
    const { w } = await setup();
    const whole = (await all(w, w.tokens.ann as string, 100)).map((c) => JSON.stringify([c.scope, c.id]));
    for (const limit of [1, 2, 3, 4, 7, 8]) {
      expect((await all(w, w.tokens.ann as string, limit)).map((c) => JSON.stringify([c.scope, c.id])), `limit ${limit}`).toEqual(whole);
    }
    expect(must(await w.caci.mineCategories(w.tokens.ann, { limit: 7 })).nextCursor).toBeNull();
  });

  it('the same request twice gives the same results and the same cursors (SC-AC-10)', async () => {
    const { w } = await setup();
    const a = must(await w.caci.mineCategories(w.tokens.ann, { limit: 3 }));
    const b = must(await w.caci.mineCategories(w.tokens.ann, { limit: 3 }));
    expect(a).toEqual(b);
    const a2 = must(await w.caci.mineCategories(w.tokens.ann, { limit: 3, cursor: a.nextCursor }));
    const b2 = must(await w.caci.mineCategories(w.tokens.ann, { limit: 3, cursor: b.nextCursor }));
    expect(a2).toEqual(b2);
  });

  it('a cursor is refused for another person, after the readable scopes change, when it is not one we gave, and in its non-canonical spellings', async () => {
    const { w, c1 } = await setup();
    const first = must(await w.caci.mineCategories(w.tokens.ann, { limit: 3 }));
    const cursor = first.nextCursor as string;
    expect(cursor).toBeTruthy();
    const refused = async (token: string, c: unknown) => ownErrorOf(await w.caci.mineCategories(token, { limit: 3, cursor: c } as never));
    expect(await refused(w.tokens.bob as string, cursor)).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
    for (const bad of ['', 'x', 'not base64!', 'e30', cursor + 'A', cursor.slice(0, -1), cursor.replace(/./, (ch) => (ch === 'A' ? 'B' : 'A')), 5, {}]) {
      expect(await refused(w.tokens.ann as string, bad), String(bad)).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
    }
    const body = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    const forge = (patch: Record<string, unknown>) => Buffer.from(JSON.stringify({ ...body, ...patch }), 'utf8').toString('base64url');
    for (const patch of [{ w: 'summary' }, { f: 'x'.repeat(32) }, { i: 99 }, { i: -1 }, { i: 1.5 }, { c: 5 }, { v: 2 }]) {
      expect(await refused(w.tokens.ann as string, forge(patch)), JSON.stringify(patch)).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
    }
    expect(await refused(w.tokens.ann as string, ` ${cursor}`)).toMatchObject({ field: 'cursor' });
    // a change in what is readable makes every earlier cursor refused
    must(await w.circleStore.removeMember(c1, uid(w, 'ann')));
    expect(await refused(w.tokens.ann as string, cursor)).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
  });

  it('a cursor is bound to the person even when two people can read the same circles', async () => {
    const w = await world({ people: ['root', 'cat', 'dan'] });
    const c = await w.circle(1, 'cat', [['dan', 'member']]);
    for (const who of ['cat', 'dan']) await fill(w, w.graphIds[who] as string, ['a', 'b'], who.toUpperCase()); // the first page exactly fills with the own brain, so the cursor is at the start of the next scope
    await fill(w, `circle-${c}`, ['x'], 'C');
    const first = must(await w.caci.mineCategories(w.tokens.cat, { limit: 2 }));
    expect(ownErrorOf(await w.caci.mineCategories(w.tokens.dan, { limit: 2, cursor: first.nextCursor } as never))).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
    expect(must(await w.caci.mineCategories(w.tokens.cat, { limit: 2, cursor: first.nextCursor })).items.length).toBeGreaterThan(0);
  });

  it('a cursor taken at the start of a scope is refused when the list of scopes has changed under it', async () => {
    const { w, c1 } = await setup();
    const first = must(await w.caci.mineCategories(w.tokens.ann, { limit: 2 })); // the personal brain exactly fills the page: the next position is the start of the next scope
    expect(JSON.parse(Buffer.from(first.nextCursor as string, 'base64url').toString('utf8'))).toMatchObject({ i: 1, c: null });
    const early = await w.circle(0, 'bob', [['ann', 'member']]); // sorts before every other circle: the scope at place 1 would change
    expect(early < c1).toBe(true);
    expect(ownErrorOf(await w.caci.mineCategories(w.tokens.ann, { limit: 2, cursor: first.nextCursor } as never))).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
  });

  it('a bad limit is refused naming limit; a signed-out caller is unauthenticated', async () => {
    const { w } = await setup();
    for (const limit of [0, 101, 1.5, 'x', Number.NaN]) expect(ownErrorOf(await w.caci.mineCategories(w.tokens.ann, { limit } as never)), String(limit)).toMatchObject({ code: 'INVALID_INPUT', field: 'limit' });
    expect(ownErrorOf(await w.caci.mineCategories('nope'))).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('pages inside one large scope too, and then carries on into the next', async () => {
    const { w, c1 } = await setup();
    await fill(w, `circle-${c1}`, Array.from({ length: 12 }, (_, i) => `many-${String(i).padStart(2, '0')}`), 'BIG');
    const rows = await all(w, w.tokens.ann as string, 5);
    expect(rows.filter((r) => r.scope.circleId === c1)).toHaveLength(14);
    expect(rows.length).toBe(19);
    expect(new Set(rows.map((r) => JSON.stringify([r.scope, r.id]))).size).toBe(19);
  });

  it('an administrator who is not a member sees only their own brain', async () => {
    const { w } = await setup();
    const rows = await all(w, w.tokens.root as string);
    expect(rows.every((r) => r.scope.kind === 'personal')).toBe(true);
    expect(must(await w.caci.brainScopes(w.tokens.root)).items).toHaveLength(1);
  });

  it('a circle without its graph contributes nothing and is skipped, not an error', async () => {
    const { w, c1 } = await setup();
    await w.graphs.graphs.drop(`circle-${c1}`);
    const rows = await all(w, w.tokens.ann as string, 2);
    expect(rows.some((r) => r.scope.circleId === c1)).toBe(false);
    expect(rows.length).toBe(5);
  });

  it('a store failure is the fixed storage error', async () => {
    const { w } = await setup();
    w.circleStore.listCirclesOf = async () => {
      throw new Error('disk /secret');
    };
    const r = await w.caci.mineCategories(w.tokens.ann);
    expect(r).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'STORAGE_ERROR' } } });
    expect(JSON.stringify(r)).not.toContain('secret');
  });
});

describe('My Brain, a category\'s items and one item', () => {
  const ref = (scope: unknown, id: unknown) => ({ scope, id });
  const circleScope = (circleId: string) => ({ kind: 'circle', circleId });

  it('a category is its scope and its id: the same id in four scopes gives four lists, each item tagged with its own scope (SC-AC-02)', async () => {
    const { w, c1, c2, c3 } = await setup();
    const expected: Array<[unknown, Record<string, unknown>, string]> = [
      [PERSON, PERSON, 'PERSONAL shared'],
      [circleScope(c1), circ(c1, 'Circle 1'), 'C1 shared'],
      [circleScope(c2), circ(c2, 'Circle 2'), 'C2 shared'],
      [circleScope(c3), circ(c3, 'Circle 3'), 'C3 shared'],
    ];
    for (const [scope, provenance, title] of expected) {
      const page = must(await w.caci.mineCategoryItems(w.tokens.ann, ref(scope, 'shared')));
      expect(page.scope).toEqual(provenance);
      expect(page.category).toMatchObject({ id: 'shared' });
      expect(page.items.map((i) => [i.id, (i.data as { title: string }).title, i.scope])).toEqual([['item-shared', title, provenance]]);
      expect(Object.isFrozen(page) && Object.isFrozen(page.items) && Object.isFrozen(page.items[0])).toBe(true);
    }
  });

  it('one item is its scope and its id: the same id in four scopes gives four items, with their categories tagged', async () => {
    const { w, c1, c2, c3 } = await setup();
    for (const [scope, provenance, title] of [[PERSON, PERSON, 'PERSONAL shared'], [circleScope(c1), circ(c1, 'Circle 1'), 'C1 shared'], [circleScope(c2), circ(c2, 'Circle 2'), 'C2 shared'], [circleScope(c3), circ(c3, 'Circle 3'), 'C3 shared']] as const) {
      const d = must(await w.caci.mineItem(w.tokens.ann, ref(scope, 'item-shared')));
      expect(d.scope).toEqual(provenance);
      expect((d.item.data as { title: string }).title).toBe(title);
      expect(d.item.scope).toEqual(provenance);
      expect(d.categories.length).toBeGreaterThan(0);
      expect(d.categories.every((c) => JSON.stringify(c.scope) === JSON.stringify(provenance))).toBe(true);
      expect(d.categories.map((c) => c.name).join()).toContain(title.split(' ')[0] as string);
    }
  });

  it('an id that exists only in another scope is not found; a scope the person cannot read is the one not-found', async () => {
    const { w, c1 } = await setup();
    expect(ownErrorOf(await w.caci.mineItem(w.tokens.ann, ref(PERSON, 'item-a-only')))).toMatchObject({ code: 'NOT_FOUND' });
    expect(must(await w.caci.mineItem(w.tokens.ann, ref(circleScope(c1), 'item-a-only'))).item.id).toBe('item-a-only');
    const NO_CIRCLE = { ok: false, error: { source: 'caci', error: { code: 'NOT_FOUND', message: 'no such circle' } } };
    for (const who of ['ann', 'cat', 'root']) {
      expect(await w.caci.mineItem(w.tokens[who], ref(circleScope('c0000000000000004'), 'item-secret')), who).toEqual(NO_CIRCLE);
      expect(await w.caci.mineCategoryItems(w.tokens[who], ref(circleScope('c0000000000000004'), 'secret')), who).toEqual(NO_CIRCLE);
    }
    expect(await w.caci.mineItem(w.tokens.cat, ref(circleScope(c1), 'item-shared'))).toEqual(NO_CIRCLE);
  });

  it('the scope is required, the reference has only scope and id, and the id must be text', async () => {
    const { w } = await setup();
    const err = async (r: unknown) => ownErrorOf((await w.caci.mineItem(w.tokens.ann, r)) as never);
    expect(await err(undefined)).toMatchObject({ code: 'INVALID_INPUT', field: 'ref' });
    for (const bad of [null, 'x', 5, [], ['personal']]) expect(await err(bad), String(bad)).toMatchObject({ code: 'INVALID_INPUT', field: 'ref' });
    expect(await err({ id: 'item-shared' })).toMatchObject({ code: 'INVALID_INPUT', field: 'scope' });
    expect(await err({ scope: 'circle', id: 'x' })).toMatchObject({ code: 'INVALID_INPUT', field: 'scope' });
    expect(await err({ scope: { kind: 'circle', circleId: 'x' }, id: 'x' })).toMatchObject({ code: 'INVALID_INPUT', field: 'scope.circleId' });
    expect(await err({ scope: PERSON, id: 'x', graphId: 'user-u1' })).toMatchObject({ code: 'INVALID_INPUT', field: 'graphId' });
    for (const id of [undefined, 5, null, '']) expect(await err({ scope: PERSON, id }), String(id)).toMatchObject({ code: 'INVALID_INPUT', field: 'id' });
    expect(ownErrorOf((await w.caci.mineCategoryItems(w.tokens.ann, { id: 'shared' })) as never)).toMatchObject({ code: 'INVALID_INPUT', field: 'scope' });
    expect(ownErrorOf((await w.caci.mineItem('nope', ref(PERSON, 'x'))) as never)).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('without a resolver a circle is not found and the personal brain works', async () => {
    const { w, c1 } = await setup();
    const capture = createController({ adapter: w.graphs, llm: createLlm({ client: createDemoModelClient() }) });
    const bare = createCaciController({ users: w.users, capture, graphAdapter: w.graphs });
    expect(await bare.mineItem(w.tokens.ann, ref(circleScope(c1), 'item-shared'))).toMatchObject({ ok: false, error: { error: { code: 'NOT_FOUND' } } });
    expect(must(await bare.mineItem(w.tokens.ann, ref(PERSON, 'item-shared'))).scope).toEqual(PERSON);
  });

  it('an item filed under more categories than are listed says so', async () => {
    const { w, c1 } = await setup();
    const ops: unknown[] = [{ op: 'upsertNode', partition: 'item', id: 'wide', data: { title: 'wide' } }];
    for (let i = 0; i < 201; i++) ops.push({ op: 'upsertNode', partition: 'category', id: `k${String(i).padStart(3, '0')}`, data: { name: `K${i}` } }, { op: 'link', item: 'wide', category: `k${String(i).padStart(3, '0')}` });
    must(await write(w.graphs, { version: 1, kind: 'mutation', graphId: `circle-${c1}`, ops } as never));
    const d = must(await w.caci.mineItem(w.tokens.ann, { scope: circleScope(c1), id: 'wide' }));
    expect(d.categories).toHaveLength(200);
    expect(d.moreCategories).toBe(true);
    expect(must(await w.caci.mineItem(w.tokens.ann, { scope: circleScope(c1), id: 'item-shared' })).moreCategories).toBeUndefined();
  });

  it('awkward ids work', async () => {
    const { w, c1 } = await setup();
    const odd = ['a b', 'A/B?c=d&e#f', '100%', '<b>x</b>', '😀', '..'];
    await fill(w, `circle-${c1}`, odd, 'ODD');
    for (const id of odd) {
      expect(must(await w.caci.mineItem(w.tokens.ann, ref(circleScope(c1), `item-${id}`))).item.id).toBe(`item-${id}`);
      expect(must(await w.caci.mineCategoryItems(w.tokens.ann, ref(circleScope(c1), id))).items).toHaveLength(1);
    }
  });

  describe('paging', () => {
    const many = async () => {
      const s = await setup();
      const ops: unknown[] = [];
      for (let i = 0; i < 9; i++) ops.push({ op: 'upsertNode', partition: 'item', id: `m${i}`, data: { title: `M${i}` } }, { op: 'link', item: `m${i}`, category: 'shared' });
      must(await write(s.w.graphs, { version: 1, kind: 'mutation', graphId: `circle-${s.c1}`, ops } as never));
      return s;
    };
    const walk = async (w: World, token: string, r: unknown, limit: number) => {
      const out: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 30; guard++) {
        const page: { items: Array<{ id: string }>; nextCursor: string | null } = must(await w.caci.mineCategoryItems(token, r, { limit, ...(cursor === null ? {} : { cursor }) })) as never;
        expect(page.items.length).toBeLessThanOrEqual(limit);
        out.push(...page.items.map((i) => i.id));
        if (page.nextCursor === null) return out;
        cursor = page.nextCursor;
      }
      throw new Error('paging did not end');
    };

    it('any page size gives the same items in the same order, and the same request twice is deep-equal (SC-AC-10)', async () => {
      const { w, c1 } = await many();
      const r = ref(circleScope(c1), 'shared');
      const whole = await walk(w, w.tokens.ann as string, r, 100);
      expect(whole).toHaveLength(10);
      for (const limit of [1, 3, 4, 10]) expect(await walk(w, w.tokens.ann as string, r, limit), `limit ${limit}`).toEqual(whole);
      const a = must(await w.caci.mineCategoryItems(w.tokens.ann, r, { limit: 4 }));
      expect(a.items).toHaveLength(4);
      expect(must(await w.caci.mineCategoryItems(w.tokens.ann, r, { limit: 4 }))).toEqual(a);
    });

    it('a cursor is bound to the person, the scope, the category and the view', async () => {
      const { w, c1, c3 } = await many();
      const r = ref(circleScope(c1), 'shared');
      const first = must(await w.caci.mineCategoryItems(w.tokens.ann, r, { limit: 4 }));
      const cursor = first.nextCursor as string;
      const refused = async (token: string, rr: unknown, c: unknown) => ownErrorOf((await w.caci.mineCategoryItems(token, rr, { limit: 4, cursor: c } as never)) as never);
      expect(await refused(w.tokens.bob as string, r, cursor)).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' }); // bob reads the same circle
      expect(await refused(w.tokens.ann as string, ref(circleScope(c3), 'shared'), cursor)).toMatchObject({ field: 'cursor' });
      expect(await refused(w.tokens.ann as string, ref(circleScope(c1), 'a-only'), cursor)).toMatchObject({ field: 'cursor' });
      expect(await refused(w.tokens.ann as string, ref(PERSON, 'shared'), cursor)).toMatchObject({ field: 'cursor' });
      const categoriesCursor = must(await w.caci.mineCategories(w.tokens.ann, { limit: 1 })).nextCursor;
      expect(await refused(w.tokens.ann as string, r, categoriesCursor)).toMatchObject({ field: 'cursor' });
      for (const bad of ['', 'x', cursor + 'A', ` ${cursor}`, 5, {}]) expect(await refused(w.tokens.ann as string, r, bad), String(bad)).toMatchObject({ field: 'cursor' });
      expect(must(await w.caci.mineCategoryItems(w.tokens.ann, r, { limit: 4, cursor })).items.length).toBeGreaterThan(0);
    });

    it('a bad limit is refused naming limit', async () => {
      const { w } = await setup();
      for (const limit of [0, 101, 1.5, 'x']) expect(ownErrorOf((await w.caci.mineCategoryItems(w.tokens.ann, ref(PERSON, 'shared'), { limit } as never)) as never), String(limit)).toMatchObject({ code: 'INVALID_INPUT', field: 'limit' });
    });
  });
});
