import { afterEach, describe, expect, it } from 'vitest';
import { createCircleController, type CircleController } from '../circles/index.js';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createGraph, describeGraph, listGraphs, write, type StorageAdapter } from '../graph_store/index.js';
import type { UserController } from '../users/index.js';
import { afterAccountDeletion, circleGraphId, reconcileCircleGraphs, withCircleGraphs } from './index.js';
import { world, type World } from './scopes.test-util.js';

const FAILED = { code: 'STORAGE_ERROR', message: 'the circle service could not complete the request' };
const LEFT = { code: 'STORAGE_ERROR', message: 'the circle was deleted, but its notes could not be removed yet; they will be removed at the next clean-up' };
const kept: World[] = [];
afterEach(() => {
  for (const w of kept.splice(0)) w.dispose();
});

function setup(kind: 'memory' | 'sqlite' = 'memory', adapter: StorageAdapter = createMemoryAdapter()) {
  const w = world(kind);
  kept.push(w);
  const base = createCircleController({ users: w.users as never, directory: { get: async () => undefined }, store: w.store, clock: () => 1_700_000_000_000 });
  const lifecycle = withCircleGraphs(base, adapter);
  return { w, base, lifecycle, adapter };
}
const graphsOf = async (adapter: StorageAdapter) => {
  const r = await listGraphs(adapter, { limit: 500 });
  return r.ok ? [...r.value.items].sort() : [];
};
const addNote = async (adapter: StorageAdapter, graphId: string) => {
  const r = await write(adapter, { version: 1, kind: 'mutation', graphId, ops: [{ op: 'upsertNode', partition: 'item', id: 'n1', data: { title: 'note' } }] } as never);
  expect(r.ok).toBe(true);
};
const wrapGraphs = (inner: StorageAdapter, over: Record<string, unknown>): StorageAdapter => ({ ...inner, graphs: { ...inner.graphs, ...over } }) as never;
const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value as T;
};

describe.each(['memory', 'sqlite'] as const)('creating a circle over the %s circle store', (kind) => {
  it('makes the record and its graph together', async () => {
    const { w, lifecycle, adapter } = setup(kind);
    const made = must(await lifecycle.create(w.token('ann'), { name: 'Club' }));
    expect(made).toMatchObject({ name: 'Club', role: 'owner' });
    expect(await graphsOf(adapter)).toEqual([circleGraphId(made.id)]);
    expect(await describeGraph(adapter, circleGraphId(made.id))).toMatchObject({ ok: true, value: { itemCount: 0 } });
    expect(await w.store.getCircle(made.id)).toBeDefined();
  });

  it('a refusal by the circle controller passes through and makes no graph', async () => {
    const { w, lifecycle, adapter } = setup(kind);
    expect(await lifecycle.create(w.token('ann'), { name: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await lifecycle.create('nope', { name: 'x' })).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(await lifecycle.create(w.token('ann'), { name: 'x', graphId: 'y' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await graphsOf(adapter)).toEqual([]);
  });

  it('a graph that cannot be made undoes the circle: neither is left, and the answer is the one fixed failure', async () => {
    const inner = createMemoryAdapter();
    const { w, lifecycle } = setup(kind, wrapGraphs(inner, { create: async () => { throw new Error('disk exploded at /secret/path'); } }));
    const r = await lifecycle.create(w.token('ann'), { name: 'Club' });
    expect(r).toEqual({ ok: false, error: FAILED });
    expect(JSON.stringify(r)).not.toContain('secret');
    const mine = await w.store.listCirclesOf(w.id('ann'), { limit: 10, cursor: null });
    expect(mine.items).toEqual([]);
    expect(await graphsOf(inner)).toEqual([]);
  });

  it('if undoing the circle fails too, the answer is still the fixed failure and the next reconcile makes the graph', async () => {
    const inner = createMemoryAdapter();
    const { w, base } = setup(kind, inner);
    const failing = wrapGraphs(inner, { create: async () => { throw new Error('boom'); } });
    const stuck = withCircleGraphs({ ...base, delete: async () => { throw new Error('cannot delete'); } } as CircleController, failing);
    expect(await stuck.create(w.token('ann'), { name: 'Club' })).toEqual({ ok: false, error: FAILED });
    const left = await w.store.listCirclesOf(w.id('ann'), { limit: 10, cursor: null });
    expect(left.items).toHaveLength(1);
    expect(await graphsOf(inner)).toEqual([]);
    expect(await reconcileCircleGraphs({ circles: w.store, graphAdapter: inner })).toMatchObject({ ok: true, value: { created: [left.items[0]?.circle.id] } });
  });

  it('a graph that already exists is not an error', async () => {
    const inner = createMemoryAdapter();
    const { w, lifecycle } = setup(kind, wrapGraphs(inner, { create: async (id: string) => { await inner.graphs.create(id); return inner.graphs.create(id); } }));
    expect(must(await lifecycle.create(w.token('ann'), { name: 'Club' })).name).toBe('Club');
  });
});

describe.each(['memory', 'sqlite'] as const)('deleting a circle over the %s circle store', (kind) => {
  it('an owner deleting drops the record and the graph with its notes', async () => {
    const { w, lifecycle, adapter } = setup(kind);
    const c = must(await lifecycle.create(w.token('ann'), { name: 'Club' }));
    await addNote(adapter, circleGraphId(c.id));
    expect(await lifecycle.delete(w.token('ann'), c.id)).toEqual({ ok: true, value: true });
    expect(await graphsOf(adapter)).toEqual([]);
    expect(await w.store.getCircle(c.id)).toBeUndefined();
  });

  it('someone who may not delete, and a stranger, change nothing: the graph and its notes stay', async () => {
    const { w, lifecycle, adapter } = setup(kind);
    const c = must(await lifecycle.create(w.token('ann'), { name: 'Club' }));
    await w.store.createInvitation({ id: 'i0000000000000001', circleId: c.id, username: 'bob', role: 'manager', invitedBy: w.id('ann'), createdAt: 1, expiresAt: 9e12 }, { maxOpenInvitationsPerCircle: 50 }, 2);
    await w.store.acceptInvitation('i0000000000000001', w.id('bob'), 'bob', 3, { maxCirclesPerUser: 20, maxMembersPerCircle: 50 });
    await addNote(adapter, circleGraphId(c.id));
    expect(await lifecycle.delete(w.token('bob'), c.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await lifecycle.delete(w.token('cat'), c.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await lifecycle.delete('nope', c.id)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(await lifecycle.delete(w.token('ann'), 'garbage')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await describeGraph(adapter, circleGraphId(c.id))).toMatchObject({ ok: true, value: { itemCount: 1 } });
    expect(await w.store.getCircle(c.id)).toBeDefined();
  });

  it('only that circle\'s graph is dropped', async () => {
    const { w, lifecycle, adapter } = setup(kind);
    const a = must(await lifecycle.create(w.token('ann'), { name: 'A' }));
    const b = must(await lifecycle.create(w.token('ann'), { name: 'B' }));
    await createGraph(adapter, `user-${w.id('ann')}`);
    await lifecycle.delete(w.token('ann'), a.id);
    expect(await graphsOf(adapter)).toEqual([circleGraphId(b.id), `user-${w.id('ann')}`].sort());
  });

  it('a graph that cannot be dropped is tried twice, then reported in fixed words; the circle is gone and the reconcile removes the graph', async () => {
    const inner = createMemoryAdapter();
    let fail = 2;
    const { w, lifecycle } = setup(kind, wrapGraphs(inner, { drop: async (id: string) => { if (fail-- > 0) throw new Error('boom'); return inner.graphs.drop(id); } }));
    const c = must(await lifecycle.create(w.token('ann'), { name: 'Club' }));
    const r = await lifecycle.delete(w.token('ann'), c.id);
    expect(r).toEqual({ ok: false, error: LEFT });
    expect(await w.store.getCircle(c.id)).toBeUndefined();
    expect(await graphsOf(inner)).toEqual([circleGraphId(c.id)]);
    expect(await reconcileCircleGraphs({ circles: w.store, graphAdapter: inner })).toMatchObject({ ok: true, value: { dropped: [c.id] } });
    expect(await graphsOf(inner)).toEqual([]);
  });

  it('a drop that fails once and then works is a success', async () => {
    const inner = createMemoryAdapter();
    let fail = 1;
    const { w, lifecycle } = setup(kind, wrapGraphs(inner, { drop: async (id: string) => { if (fail-- > 0) throw new Error('boom'); return inner.graphs.drop(id); } }));
    const c = must(await lifecycle.create(w.token('ann'), { name: 'Club' }));
    expect(await lifecycle.delete(w.token('ann'), c.id)).toEqual({ ok: true, value: true });
    expect(await graphsOf(inner)).toEqual([]);
  });

  it('a graph already gone is not an error', async () => {
    const { w, lifecycle, adapter } = setup(kind);
    const c = must(await lifecycle.create(w.token('ann'), { name: 'Club' }));
    await adapter.graphs.drop(circleGraphId(c.id));
    expect(await lifecycle.delete(w.token('ann'), c.id)).toEqual({ ok: true, value: true });
  });
});

describe('what it keeps of the controller', () => {
  it('every other method is the controller\'s own, and the result is frozen', () => {
    const { base, lifecycle } = setup();
    for (const name of Object.keys(base) as Array<keyof CircleController>) {
      if (name === 'create' || name === 'delete') expect(lifecycle[name]).not.toBe(base[name]);
      else expect(lifecycle[name], name).toBe(base[name]);
    }
    expect(Object.isFrozen(lifecycle)).toBe(true);
  });

  it('needs a controller and a graph adapter', () => {
    const { base } = setup();
    expect(() => withCircleGraphs(undefined as never, createMemoryAdapter())).toThrow(TypeError);
    expect(() => withCircleGraphs({} as never, createMemoryAdapter())).toThrow(TypeError);
    expect(() => withCircleGraphs(base, undefined as never)).toThrow(TypeError);
  });
});

describe('afterAccountDeletion', () => {
  const users = (outcome: boolean) => {
    const calls: string[] = [];
    const controller = {
      resolve: async () => ({ ok: true }),
      deleteMe: async () => (calls.push('deleteMe'), outcome ? { ok: true, value: true } : { ok: false, error: { code: 'INVALID_INPUT' } }),
      deleteUser: async () => (calls.push('deleteUser'), outcome ? { ok: true, value: true } : { ok: false, error: { code: 'FORBIDDEN' } }),
    };
    return { controller: controller as unknown as UserController, calls };
  };

  it('runs after a successful deleteMe and deleteUser, and not after a refused one', async () => {
    const good = users(true);
    const ran: string[] = [];
    const wrapped = afterAccountDeletion(good.controller, async () => void ran.push('after'));
    expect(await wrapped.deleteMe('t', {} as never, {} as never)).toEqual({ ok: true, value: true });
    expect(await wrapped.deleteUser('t', 'u')).toEqual({ ok: true, value: true });
    expect(ran).toEqual(['after', 'after']);
    const bad = users(false);
    const none: string[] = [];
    const refused = afterAccountDeletion(bad.controller, async () => void none.push('after'));
    expect(await refused.deleteMe('t', {} as never, {} as never)).toMatchObject({ ok: false });
    expect(await refused.deleteUser('t', 'u')).toMatchObject({ ok: false });
    expect(none).toEqual([]);
  });

  it('is finished before the answer comes back, and a failure of it changes nothing', async () => {
    const good = users(true);
    let done = false;
    const slow = afterAccountDeletion(good.controller, async () => { await new Promise((r) => setTimeout(r, 20)); done = true; });
    await slow.deleteMe('t', {} as never, {} as never);
    expect(done).toBe(true);
    const throwing = afterAccountDeletion(good.controller, async () => { throw new Error('x'); });
    expect(await throwing.deleteUser('t', 'u')).toEqual({ ok: true, value: true });
    const syncThrow = afterAccountDeletion(good.controller, (() => { throw new Error('y'); }) as never);
    expect(await syncThrow.deleteUser('t', 'u')).toEqual({ ok: true, value: true });
  });

  it('passes every argument on, keeps the other methods and is frozen', async () => {
    const seen: unknown[][] = [];
    const controller = { resolve: async () => 1, deleteMe: async (...a: unknown[]) => (seen.push(a), { ok: true, value: true }), deleteUser: async (...a: unknown[]) => (seen.push(a), { ok: true, value: true }) } as unknown as UserController;
    const wrapped = afterAccountDeletion(controller, async () => undefined);
    await wrapped.deleteMe('t', { password: 'p' } as never, { clientKey: 'k' } as never);
    await wrapped.deleteUser('t', 'u1');
    expect(seen).toEqual([['t', { password: 'p' }, { clientKey: 'k' }], ['t', 'u1']]);
    expect(wrapped.resolve).toBe(controller.resolve);
    expect(Object.isFrozen(wrapped)).toBe(true);
  });

  it('needs a user controller and a function', () => {
    const { controller } = users(true);
    expect(() => afterAccountDeletion(undefined as never, async () => undefined)).toThrow(TypeError);
    expect(() => afterAccountDeletion({} as never, async () => undefined)).toThrow(TypeError);
    expect(() => afterAccountDeletion(controller, undefined as never)).toThrow(TypeError);
  });
});
