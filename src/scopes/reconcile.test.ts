import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryCircleStore, type CircleStore } from '../circles/index.js';
import { createSqliteCircleStore } from '../circles/sqlite/index.js';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createGraph, describeGraph, listGraphs, write, type StorageAdapter } from '../graph_store/index.js';
import { createSqliteUserStore } from '../users/sqlite/index.js';
import { circleGraphId, planReconcile, reconcileCircleGraphs } from './index.js';
import { cid, LIMITS, T0 } from './scopes.test-util.js';

const BIG = { ...LIMITS, maxCirclesPerUser: 100_000 };
const FIXED = { code: 'STORAGE_ERROR', message: 'the scopes service could not complete the request' };
const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const allGraphs = async (adapter: StorageAdapter): Promise<string[]> => {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const r = await listGraphs(adapter, { limit: 500, cursor });
    if (!r.ok) throw new Error('list failed');
    out.push(...r.value.items);
    cursor = r.value.nextCursor;
  } while (cursor !== null);
  return out.sort();
};
const circleGraphs = async (adapter: StorageAdapter) => (await allGraphs(adapter)).filter((g) => g.startsWith('circle-'));
const dropOne = async (adapter: StorageAdapter) => void (await adapter.graphs.drop(circleGraphId(cid(1))));
const addNote = async (adapter: StorageAdapter, graphId: string, id: string) => {
  const r = await write(adapter, { version: 1, kind: 'mutation', graphId, ops: [{ op: 'upsertNode', partition: 'item', id, data: { title: id } }] } as never);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
};
const makeCircle = (store: CircleStore, n: number, owner = 'u0000000000000001') => store.createCircle({ id: cid(n), name: `Circle ${n}`, createdAt: T0 }, owner, BIG);

describe('planReconcile (pure)', () => {
  const C = (n: number) => cid(n);
  const G = (n: number) => `circle-${cid(n)}`;
  it('creates what is missing, drops what is gone, and leaves what matches', () => {
    expect(planReconcile([C(1), C(2), C(3)], [G(2), G(3), G(4)])).toEqual({ create: [C(1)], drop: [C(4)] });
    expect(planReconcile([], [])).toEqual({ create: [], drop: [] });
    expect(planReconcile([C(1)], [G(1)])).toEqual({ create: [], drop: [] });
  });

  it('is sorted and has no duplicates, whatever the input order', () => {
    expect(planReconcile([C(3), C(1), C(3), C(2)], [])).toEqual({ create: [C(1), C(2), C(3)], drop: [] });
    expect(planReconcile([], [G(9), G(2), G(9)])).toEqual({ create: [], drop: [C(2), C(9)] });
  });

  it('never plans anything for a graph that is not a circle graph: user graphs, look-alikes and made-up names', () => {
    const others = ['user-u0000000000000001', 'circle-', 'circle-x', `circle-${C(1).toUpperCase()}`, `circles-${C(1)}`, `xcircle-${C(1)}`, `circle-${C(1)}-copy`, '', 'default', `circle_${C(1)}`];
    expect(planReconcile([C(1)], others)).toEqual({ create: [C(1)], drop: [] });
    expect(planReconcile([], others)).toEqual({ create: [], drop: [] });
  });
});

describe.each(['memory', 'sqlite'] as const)('reconciling over the %s circle store', (kind) => {
  const stores = (): CircleStore => {
    if (kind === 'memory') return createMemoryCircleStore();
    const s = createSqliteCircleStore();
    closers.push(() => s.close());
    return s;
  };

  it('creates the graph of a circle that has none, drops the graph of a circle that is gone, and touches nothing else', async () => {
    const circles = stores();
    const graphs = createMemoryAdapter();
    await makeCircle(circles, 1);
    await makeCircle(circles, 2);
    await createGraph(graphs, circleGraphId(cid(2)));
    await addNote(graphs, circleGraphId(cid(2)), 'keep-me');
    await createGraph(graphs, circleGraphId(cid(3))); // its circle is gone
    await addNote(graphs, circleGraphId(cid(3)), 'orphan-note');
    await createGraph(graphs, 'user-u0000000000000001');
    await addNote(graphs, 'user-u0000000000000001', 'personal');
    await createGraph(graphs, 'circle-not-an-id');
    await createGraph(graphs, 'other');

    const r = await reconcileCircleGraphs({ circles, graphAdapter: graphs });
    expect(r).toEqual({ ok: true, value: { created: [cid(1)], dropped: [cid(3)], skipped: [] } });
    expect(await allGraphs(graphs)).toEqual(['circle-not-an-id', circleGraphId(cid(1)), circleGraphId(cid(2)), 'other', 'user-u0000000000000001'].sort());
    expect(await describeGraph(graphs, circleGraphId(cid(2)))).toMatchObject({ ok: true, value: { itemCount: 1 } });
    expect(await describeGraph(graphs, 'user-u0000000000000001')).toMatchObject({ ok: true, value: { itemCount: 1 } });
    expect(await describeGraph(graphs, circleGraphId(cid(1)))).toMatchObject({ ok: true, value: { itemCount: 0 } });
  });

  it('is idempotent: a second run changes nothing and reports nothing', async () => {
    const circles = stores();
    const graphs = createMemoryAdapter();
    await makeCircle(circles, 1);
    await createGraph(graphs, circleGraphId(cid(7)));
    await reconcileCircleGraphs({ circles, graphAdapter: graphs });
    const before = await allGraphs(graphs);
    const again = await reconcileCircleGraphs({ circles, graphAdapter: graphs });
    expect(again).toEqual({ ok: true, value: { created: [], dropped: [], skipped: [] } });
    expect(await allGraphs(graphs)).toEqual(before);
  });

  it('reports are frozen', async () => {
    const r = await reconcileCircleGraphs({ circles: stores(), graphAdapter: createMemoryAdapter() });
    const v = (r as { value: { created: object; dropped: object; skipped: object } }).value;
    expect(Object.isFrozen(v) && Object.isFrozen(v.created) && Object.isFrozen(v.dropped) && Object.isFrozen(v.skipped)).toBe(true);
  });

  it('pages: more circles and graphs than one page of each', async () => {
    const circles = stores();
    const graphs = createMemoryAdapter();
    for (let n = 1; n <= 450; n++) await makeCircle(circles, n);
    for (let n = 1001; n <= 1450; n++) await createGraph(graphs, circleGraphId(cid(n)));
    let circlePages = 0;
    const counting: Pick<CircleStore, 'listCircleIds'> = { listCircleIds: (p) => (circlePages++, circles.listCircleIds(p)) };
    const refused = await reconcileCircleGraphs({ circles: counting, graphAdapter: graphs });
    expect(circlePages).toBe(3); // 200, 200 and 50
    expect(refused).toMatchObject({ ok: true, value: { created: expect.any(Array), dropped: [], skipped: expect.any(Array) } });
    const value = (refused as unknown as { value: { created: string[]; skipped: string[] } }).value;
    expect(value.created).toHaveLength(450);
    expect(value.skipped).toHaveLength(450);
    expect((await circleGraphs(graphs)).length).toBe(900);
    const done = await reconcileCircleGraphs({ circles, graphAdapter: graphs, maxDrops: 1000 });
    expect((done as unknown as { value: { dropped: string[] } }).value.dropped).toHaveLength(450);
    expect(await circleGraphs(graphs)).toEqual(Array.from({ length: 450 }, (_, i) => circleGraphId(cid(i + 1))).sort());
  }, 60_000);

  it('random worlds always end with exactly the circle graphs the circles need, and other graphs and their data untouched', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const circles = stores();
      const graphs = createMemoryAdapter();
      let state = seed * 7919;
      const rnd = (n: number) => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state % n;
      };
      const exist = new Set<number>();
      for (let n = 1; n <= 12; n++) {
        if (rnd(2) === 0) {
          exist.add(n);
          await makeCircle(circles, n);
        }
        if (rnd(2) === 0) {
          await createGraph(graphs, circleGraphId(cid(n)));
          await addNote(graphs, circleGraphId(cid(n)), `n${n}`);
        }
        if (rnd(4) === 0) {
          await createGraph(graphs, `user-u${String(n).padStart(16, '0')}`);
          await addNote(graphs, `user-u${String(n).padStart(16, '0')}`, `p${n}`);
        }
      }
      const personalBefore = (await allGraphs(graphs)).filter((g) => !g.startsWith('circle-'));
      const had = new Set((await circleGraphs(graphs)).map((g) => g));
      const r = await reconcileCircleGraphs({ circles, graphAdapter: graphs });
      expect(r.ok, `seed ${seed}`).toBe(true);
      expect(await circleGraphs(graphs), `seed ${seed}`).toEqual([...exist].map((n) => circleGraphId(cid(n))).sort());
      expect((await allGraphs(graphs)).filter((g) => !g.startsWith('circle-')), `seed ${seed}`).toEqual(personalBefore);
      for (const g of personalBefore) expect(await describeGraph(graphs, g), g).toMatchObject({ value: { itemCount: 1 } });
      for (const n of exist) {
        const g = circleGraphId(cid(n));
        expect(await describeGraph(graphs, g), `${g} seed ${seed}`).toMatchObject({ value: { itemCount: had.has(g) ? 1 : 0 } });
      }
    }
  }, 60_000);

  it('a circle created while the run is going keeps its graph (graphs are listed first, circles second)', async () => {
    const circles = stores();
    const graphs = createMemoryAdapter();
    await makeCircle(circles, 1);
    let injected = false;
    const hooked: Pick<CircleStore, 'listCircleIds'> = {
      listCircleIds: async (p) => {
        if (!injected) {
          injected = true;
          await makeCircle(circles, 2); // the record first, then its graph, as the lifecycle does
          await createGraph(graphs, circleGraphId(cid(2)));
          await addNote(graphs, circleGraphId(cid(2)), 'fresh');
        }
        return circles.listCircleIds(p);
      },
    };
    const r = await reconcileCircleGraphs({ circles: hooked, graphAdapter: graphs });
    expect(r).toMatchObject({ ok: true, value: { dropped: [], skipped: [] } });
    expect(await describeGraph(graphs, circleGraphId(cid(2)))).toMatchObject({ ok: true, value: { itemCount: 1 } });
  });

  it('a graph that appears between planning and creating is not an error', async () => {
    const circles = stores();
    await makeCircle(circles, 1);
    const inner = createMemoryAdapter();
    const graphs: StorageAdapter = { ...inner, graphs: { ...inner.graphs, create: async (id: string) => { await inner.graphs.create(id); return inner.graphs.create(id); } } } as never;
    expect(await reconcileCircleGraphs({ circles, graphAdapter: graphs })).toMatchObject({ ok: true });
  });
});

describe('failures change nothing and are one fixed message', () => {
  const orphan = async () => {
    const circles = createMemoryCircleStore();
    const graphs = createMemoryAdapter();
    await makeCircle(circles, 1);
    await createGraph(graphs, circleGraphId(cid(9)));
    return { circles, graphs };
  };

  it('a circle listing that throws: no graph is created or dropped, and the thrown text is not repeated', async () => {
    const { graphs } = await orphan();
    const before = await allGraphs(graphs);
    const r = await reconcileCircleGraphs({ circles: { listCircleIds: async () => { throw new Error('disk exploded at /secret/path'); } }, graphAdapter: graphs });
    expect(r).toEqual({ ok: false, error: FIXED });
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(await allGraphs(graphs)).toEqual(before);
  });

  it('a circle listing whose cursor never moves on, or goes back, is a failure and not a loop', async () => {
    const { graphs } = await orphan();
    const before = await allGraphs(graphs);
    let calls = 0;
    const stuck = await reconcileCircleGraphs({ circles: { listCircleIds: async () => (calls++, { items: [cid(1)], nextCursor: 'same' }) }, graphAdapter: graphs });
    expect(stuck).toEqual({ ok: false, error: FIXED });
    expect(calls).toBe(2);
    let n = 0;
    const cycle = await reconcileCircleGraphs({ circles: { listCircleIds: async () => ({ items: [], nextCursor: ['a', 'b'][n++ % 2] as string }) }, graphAdapter: graphs });
    expect(cycle).toEqual({ ok: false, error: FIXED });
    expect(n).toBe(3);
    expect(await allGraphs(graphs)).toEqual(before);
  });

  it('a graph listing that fails: nothing is done', async () => {
    const { circles, graphs } = await orphan();
    const before = await allGraphs(graphs);
    const broken: StorageAdapter = { ...graphs, graphs: { ...graphs.graphs, list: async () => { throw new Error('nope'); } } } as never;
    let asked = 0;
    const counting: Pick<CircleStore, 'listCircleIds'> = { listCircleIds: (p) => (asked++, circles.listCircleIds(p)) };
    expect(await reconcileCircleGraphs({ circles: counting, graphAdapter: broken })).toEqual({ ok: false, error: FIXED });
    expect(asked).toBe(0);
    expect(await allGraphs(graphs)).toEqual(before);
  });

  it('a graph that cannot be created is a failure, and what was created before stays', async () => {
    const circles = createMemoryCircleStore();
    for (let n = 1; n <= 3; n++) await makeCircle(circles, n);
    const inner = createMemoryAdapter();
    let calls = 0;
    const graphs: StorageAdapter = { ...inner, graphs: { ...inner.graphs, create: async (id: string) => { if (++calls === 2) throw new Error('boom'); return inner.graphs.create(id); } } } as never;
    expect(await reconcileCircleGraphs({ circles, graphAdapter: graphs })).toEqual({ ok: false, error: FIXED });
    expect(await circleGraphs(inner)).toEqual([circleGraphId(cid(1))]);
    calls = 100;
    const next = await reconcileCircleGraphs({ circles, graphAdapter: graphs });
    expect(next).toMatchObject({ ok: true, value: { created: [cid(2), cid(3)] } });
  });

  it('a graph that cannot be dropped is a failure', async () => {
    const circles = createMemoryCircleStore();
    const inner = createMemoryAdapter();
    await createGraph(inner, circleGraphId(cid(5)));
    const graphs: StorageAdapter = { ...inner, graphs: { ...inner.graphs, drop: async () => { throw new Error('boom'); } } } as never;
    expect(await reconcileCircleGraphs({ circles, graphAdapter: graphs })).toEqual({ ok: false, error: FIXED });
    expect(await circleGraphs(inner)).toEqual([circleGraphId(cid(5))]);
  });

  it('the cap on drops: over the cap nothing is dropped and the circles are named; exactly the cap is dropped; 0 drops nothing', async () => {
    const circles = createMemoryCircleStore();
    const graphs = createMemoryAdapter();
    for (let n = 1; n <= 3; n++) await createGraph(graphs, circleGraphId(cid(n)));
    expect(await reconcileCircleGraphs({ circles, graphAdapter: graphs, maxDrops: 2 })).toMatchObject({ ok: true, value: { dropped: [], skipped: [cid(1), cid(2), cid(3)] } });
    expect((await circleGraphs(graphs)).length).toBe(3);
    expect(await reconcileCircleGraphs({ circles, graphAdapter: graphs, maxDrops: 3 })).toMatchObject({ ok: true, value: { dropped: [cid(1), cid(2), cid(3)], skipped: [] } });
    await createGraph(graphs, circleGraphId(cid(4)));
    expect(await reconcileCircleGraphs({ circles, graphAdapter: graphs, maxDrops: 0 })).toMatchObject({ ok: true, value: { dropped: [], skipped: [cid(4)] } });
  });

  it('a graph that is already gone when it is dropped is not an error, and is not reported as dropped', async () => {
    const circles = createMemoryCircleStore();
    const inner = createMemoryAdapter();
    await createGraph(inner, circleGraphId(cid(5)));
    const graphs: StorageAdapter = { ...inner, graphs: { ...inner.graphs, exists: async () => false } } as never;
    expect(await reconcileCircleGraphs({ circles, graphAdapter: graphs })).toEqual({ ok: true, value: { created: [], dropped: [], skipped: [] } });
  });

  it('by default up to 100 graphs are dropped and 101 are refused', async () => {
    const circles = createMemoryCircleStore();
    const graphs = createMemoryAdapter();
    for (let n = 1; n <= 101; n++) await createGraph(graphs, circleGraphId(cid(n)));
    const refused = await reconcileCircleGraphs({ circles, graphAdapter: graphs });
    expect((refused as unknown as { value: { dropped: string[]; skipped: string[] } }).value).toMatchObject({ dropped: [], skipped: expect.any(Array) });
    expect((await circleGraphs(graphs)).length).toBe(101);
    await dropOne(graphs);
    const done = await reconcileCircleGraphs({ circles, graphAdapter: graphs });
    expect((done as unknown as { value: { dropped: string[] } }).value.dropped).toHaveLength(100);
  });

  it('bad settings are a coding mistake', () => {
    const circles = createMemoryCircleStore();
    const graphAdapter = createMemoryAdapter();
    for (const maxDrops of [-1, 1.5, Number.NaN]) expect(() => reconcileCircleGraphs({ circles, graphAdapter, maxDrops })).toThrow(TypeError);
    expect(() => reconcileCircleGraphs({} as never)).toThrow(TypeError);
    expect(() => reconcileCircleGraphs({ circles } as never)).toThrow(TypeError);
  });
});

describe('with the real SQLite stack', () => {
  it('a circle dissolved by deleting its only owner (the account-deletion trigger) loses its graph at the next reconcile, and a circle with a surviving member keeps it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caci-reconcile-'));
    dirs.push(dir);
    const file = join(dir, 'users.db');
    const users = createSqliteUserStore({ path: file });
    const circles = createSqliteCircleStore({ path: file });
    closers.push(() => circles.close(), () => users.close());
    const rec = (n: number) => ({ id: `u${String(n).padStart(16, '0')}`, username: `user${n}`, displayName: `User ${n}`, role: 'user' as const, passwordHash: 'scrypt$16$1$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', createdAt: 1000 + n });
    for (const n of [1, 2, 3]) expect((await users.create(rec(n), { adminIfFirst: n === 1 })).ok).toBe(true);
    await makeCircle(circles, 1, rec(2).id); // user 2 alone
    await makeCircle(circles, 2, rec(2).id);
    await circles.createInvitation({ id: 'i0000000000000001', circleId: cid(2), username: 'user3', role: 'member', invitedBy: rec(2).id, createdAt: T0, expiresAt: T0 + 1e9 }, BIG, T0);
    await circles.acceptInvitation('i0000000000000001', rec(3).id, 'user3', T0 + 1, BIG);
    const graphs = createMemoryAdapter();
    expect(await reconcileCircleGraphs({ circles, graphAdapter: graphs })).toMatchObject({ ok: true, value: { created: [cid(1), cid(2)] } });
    await addNote(graphs, circleGraphId(cid(2)), 'shared-note');

    expect(await users.delete(rec(2).id)).toMatchObject({ ok: true });
    expect(await circles.getCircle(cid(1))).toBeUndefined(); // dissolved
    expect((await circles.getCircle(cid(2)))?.name).toBe('Circle 2'); // handed to user 3
    expect(await reconcileCircleGraphs({ circles, graphAdapter: graphs })).toEqual({ ok: true, value: { created: [], dropped: [cid(1)], skipped: [] } });
    expect(await circleGraphs(graphs)).toEqual([circleGraphId(cid(2))]);
    expect(await describeGraph(graphs, circleGraphId(cid(2)))).toMatchObject({ ok: true, value: { itemCount: 1 } });
  });
});
