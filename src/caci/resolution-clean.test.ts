import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createGraph, write, type StorageAdapter } from '../graph_store/index.js';
import { createMemoryResolutionStore, type Resolution, type ResolutionStore } from '../resolutions/index.js';
import { createResolutionCleaner } from './index.js';

// R-025 D16 and VR-AC-10: records for facts that no longer exist are removed, in bounded runs, and nothing is removed on a doubt.

const U1 = 'u0000000000000001';
const U2 = 'u0000000000000002';
const C1 = 'c0000000000000001';
const C2 = 'c0000000000000002';
const graphOf = (c: string): string => `circle-${c}`;
const circle = (circleId: string) => ({ kind: 'circle' as const, circleId });
const res = (extra: Partial<Resolution>): Resolution => ({ userId: U1, scope: circle(C1), factId: 'f1', verb: 'pay', at: 1, ...extra });
const item = async (adapter: StorageAdapter, graphId: string, id: string): Promise<void> => {
  const r = await write(adapter, { version: 1, kind: 'mutation', graphId, ops: [{ op: 'upsertNode', partition: 'item', id, data: { title: id } }] } as never);
  if (!r.ok) throw new Error('could not write');
};
const drop = async (adapter: StorageAdapter, graphId: string, id: string): Promise<void> => {
  const r = await write(adapter, { version: 1, kind: 'mutation', graphId, ops: [{ op: 'deleteNode', partition: 'item', id }] } as never);
  if (!r.ok) throw new Error('could not delete');
};
async function setup() {
  const graphs = createMemoryAdapter();
  await createGraph(graphs, graphOf(C1));
  await createGraph(graphs, graphOf(C2));
  return { graphs, store: createMemoryResolutionStore() };
}
const ids = async (store: ResolutionStore, userId: string): Promise<string[]> => (await store.list(userId, { limit: 100 })).items.map((r) => `${r.scope.kind === 'circle' ? r.scope.circleId.slice(-1) : 'p'}:${r.factId}`);

describe('cleaning resolutions', () => {
  it('removes every person\'s record of a fact that is gone and keeps the rest', async () => {
    const { graphs, store } = await setup();
    for (const id of ['keep', 'gone']) await item(graphs, graphOf(C1), id);
    await item(graphs, graphOf(C2), 'other');
    for (const r of [res({ factId: 'keep' }), res({ factId: 'gone' }), res({ factId: 'gone', userId: U2 }), res({ factId: 'other', scope: circle(C2) })]) await store.set(r);
    await drop(graphs, graphOf(C1), 'gone');
    const report = await createResolutionCleaner({ resolutions: store, graphAdapter: graphs }).run();
    expect(report).toEqual({ checked: 3, removed: 2, complete: true });
    expect(await ids(store, U1)).toEqual(['1:keep', '2:other']);
    expect(await ids(store, U2)).toEqual([]);
  });

  it('removes the records of a circle whose graph is gone', async () => {
    const { graphs, store } = await setup();
    await item(graphs, graphOf(C2), 'a');
    await store.set(res({ factId: 'a', scope: circle(C2) }));
    await store.set(res({ factId: 'b', scope: circle('c0000000000000009') })); // a circle with no graph at all
    const report = await createResolutionCleaner({ resolutions: store, graphAdapter: graphs }).run();
    expect(report.removed).toBe(1);
    expect(await ids(store, U1)).toEqual(['2:a']);
  });

  it('a replaced fact (a new id for the same words) loses its records: only the new id is a fact', async () => {
    const { graphs, store } = await setup();
    await item(graphs, graphOf(C1), 'old');
    await store.set(res({ factId: 'old' }));
    await drop(graphs, graphOf(C1), 'old');
    await item(graphs, graphOf(C1), 'new');
    await createResolutionCleaner({ resolutions: store, graphAdapter: graphs }).run();
    expect(await ids(store, U1)).toEqual([]);
  });

  it('leaves personal records alone: no controller makes one and an account takes its own', async () => {
    const { graphs, store } = await setup();
    await store.set(res({ scope: { kind: 'personal' }, factId: 'p' }));
    expect(await createResolutionCleaner({ resolutions: store, graphAdapter: graphs }).run()).toEqual({ checked: 1, removed: 0, complete: true });
    expect(await ids(store, U1)).toEqual(['p:p']);
  });

  it('an empty table is a complete run of nothing', async () => {
    const { graphs, store } = await setup();
    expect(await createResolutionCleaner({ resolutions: store, graphAdapter: graphs }).run()).toEqual({ checked: 0, removed: 0, complete: true });
  });

  it('is bounded, and the next run carries on where the last stopped, so every fact is reached', async () => {
    const { graphs, store } = await setup();
    for (let i = 0; i < 7; i++) {
      const id = `f${i}`;
      await store.set(res({ factId: id })); // none of them exists
    }
    const cleaner = createResolutionCleaner({ resolutions: store, graphAdapter: graphs, maxFacts: 3 });
    expect(await cleaner.run()).toEqual({ checked: 3, removed: 3, complete: false });
    expect(await ids(store, U1)).toHaveLength(4);
    expect(await cleaner.run()).toEqual({ checked: 3, removed: 3, complete: false });
    expect(await cleaner.run()).toEqual({ checked: 1, removed: 1, complete: true });
    expect(await ids(store, U1)).toEqual([]);
    // after a complete run the next one starts from the beginning again
    await item(graphs, graphOf(C1), 'live');
    await store.set(res({ factId: 'live' }));
    await store.set(res({ factId: 'dead' }));
    expect(await cleaner.run()).toEqual({ checked: 2, removed: 1, complete: true });
  });

  it('the last fact is reached even when every earlier one is alive: the cursor moves past what stayed', async () => {
    const { graphs, store } = await setup();
    for (let i = 0; i < 4; i++) {
      await item(graphs, graphOf(C1), `f${i}`);
      await store.set(res({ factId: `f${i}` }));
    }
    await store.set(res({ factId: 'f9-dead' }));
    const cleaner = createResolutionCleaner({ resolutions: store, graphAdapter: graphs, maxFacts: 2 });
    expect(await cleaner.run()).toEqual({ checked: 2, removed: 0, complete: false });
    expect(await cleaner.run()).toEqual({ checked: 2, removed: 0, complete: false });
    expect(await cleaner.run()).toEqual({ checked: 1, removed: 1, complete: true });
    expect(await ids(store, U1)).toEqual(['1:f0', '1:f1', '1:f2', '1:f3']);
  });

  it('a bound that exactly fits the table still finishes in one complete run', async () => {
    const { graphs, store } = await setup();
    for (let i = 0; i < 3; i++) await store.set(res({ factId: `f${i}` }));
    expect(await createResolutionCleaner({ resolutions: store, graphAdapter: graphs, maxFacts: 3 }).run()).toMatchObject({ checked: 3, removed: 3 });
  });

  it('removes nothing on a doubt: a graph that cannot be read ends the run with a failure and everything stays', async () => {
    const { graphs, store } = await setup();
    await item(graphs, graphOf(C1), 'a');
    await store.set(res({ factId: 'a' }));
    await store.set(res({ factId: 'b' }));
    const broken: StorageAdapter = { ...graphs, transaction: () => Promise.reject(new Error('disk')) };
    await expect(createResolutionCleaner({ resolutions: store, graphAdapter: broken }).run()).rejects.toThrow('a graph could not be read');
    expect(await ids(store, U1)).toEqual(['1:a', '1:b']);
  });

  it('refuses a bad bound', async () => {
    const { graphs, store } = await setup();
    for (const maxFacts of [0, -1, 1.5, Number.NaN]) expect(() => createResolutionCleaner({ resolutions: store, graphAdapter: graphs, maxFacts })).toThrow(TypeError);
  });
});
