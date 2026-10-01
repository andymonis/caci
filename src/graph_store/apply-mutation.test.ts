import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from './adapters/memory/index.js';
import type { AdapterTx, EdgeRecord, NodeRecord, StorageAdapter } from './adapter.js';
import { write } from './endpoints.js';

const mutation = (ops: unknown[], extra: object = {}) => ({
  version: 1,
  kind: 'mutation',
  graphId: 'g',
  ops,
  ...extra,
});
const upsert = (partition: 'item' | 'category', id: string, data?: object) => ({
  op: 'upsertNode',
  partition,
  id,
  ...(data === undefined ? {} : { data }),
});
const link = (item: string, category: string, extra: object = {}) => ({ op: 'link', item, category, ...extra });

/** Everything stored in a graph, in a stable order, for before/after comparison. */
async function snapshot(adapter: StorageAdapter, graphId = 'g') {
  return adapter.transaction(graphId, async (tx) => {
    const page = { limit: 1000, cursor: null };
    const items = (await tx.listNodes('item', page)).items;
    const categories = (await tx.listNodes('category', page)).items;
    const edges: EdgeRecord[] = [];
    for (const item of items) edges.push(...(await tx.edgesOf('item', item.id, page)).items);
    return { items, categories, edges };
  });
}

async function seeded(): Promise<StorageAdapter> {
  const adapter = createMemoryAdapter();
  expect((await write(adapter, mutation(
    [
      upsert('item', 'n1', { title: 'one' }),
      upsert('item', 'n2'),
      upsert('category', 'work', { label: 'Work' }),
      upsert('category', 'home'),
      link('n1', 'work', { weight: 2 }),
      link('n2', 'work'),
      link('n1', 'home'),
    ],
    { createIfMissing: true },
  ))).ok).toBe(true);
  return adapter;
}

/** Records graph lifecycle and transaction calls made through an adapter. */
function spied(real = createMemoryAdapter()) {
  const calls = { create: [] as string[], drop: [] as string[], transaction: [] as string[], exists: [] as string[] };
  const adapter: StorageAdapter = {
    ...real,
    transaction: (graphId, fn) => {
      calls.transaction.push(graphId);
      return real.transaction(graphId, fn);
    },
    graphs: {
      ...real.graphs,
      exists: (id) => {
        calls.exists.push(id);
        return real.graphs.exists(id);
      },
      create: (id) => {
        calls.create.push(id);
        return real.graphs.create(id);
      },
      drop: (id) => {
        calls.drop.push(id);
        return real.graphs.drop(id);
      },
    },
  };
  return { adapter, real, calls };
}

describe('write: applying a mutation', () => {
  it("applies the spec's mutation example", async () => {
    const adapter = createMemoryAdapter();
    const r = await write(adapter, {
      version: 1,
      kind: 'mutation',
      graphId: 'user_42',
      requestId: 'b7c1-1',
      createIfMissing: true,
      ops: [
        { op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 'Q3 plan' } },
        { op: 'upsertNode', partition: 'category', id: 'planning' },
        { op: 'link', item: 'note-1', category: 'planning', weight: 0.8 },
        { op: 'unlink', item: 'note-1', category: 'drafts' },
        { op: 'deleteNode', partition: 'item', id: 'note-0' },
      ],
    });
    expect(r).toEqual({ ok: true, value: { graphId: 'user_42', applied: 5, graphCreated: true } });
    expect(await snapshot(adapter, 'user_42')).toEqual({
      items: [{ partition: 'item', id: 'note-1', data: { title: 'Q3 plan' } }],
      categories: [{ partition: 'category', id: 'planning' }],
      edges: [{ item: 'note-1', category: 'planning', weight: 0.8 }],
    });
  });

  it('applies ops in order, and later ops see earlier ones', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    const r = await write(adapter, mutation([
      upsert('item', 'a', { v: 1 }),
      upsert('category', 'c'),
      link('a', 'c'), // endpoints created by the two ops above, so no ensureNodes needed
      upsert('item', 'a', { v: 2 }), // later op wins
    ]));
    expect(r.ok).toBe(true);
    const snap = await snapshot(adapter);
    expect(snap.items).toEqual([{ partition: 'item', id: 'a', data: { v: 2 } }]);
    expect(snap.edges).toEqual([{ item: 'a', category: 'c' }]);
  });

  it('cascades a delete inside the same mutation', async () => {
    const adapter = await seeded();
    const r = await write(adapter, mutation([{ op: 'deleteNode', partition: 'category', id: 'work' }]));
    expect(r.ok).toBe(true);
    const snap = await snapshot(adapter);
    expect(snap.edges).toEqual([{ item: 'n1', category: 'home' }]);
    expect(snap.categories.map((c) => c.id)).toEqual(['home']);
  });

  it('a link to a node deleted earlier in the same mutation fails', async () => {
    const adapter = await seeded();
    const r = await write(adapter, mutation([
      { op: 'deleteNode', partition: 'category', id: 'home' },
      link('n2', 'home'),
    ]));
    expect(r).toMatchObject({ ok: false, error: { code: 'NODE_NOT_FOUND', path: ['ops', 1, 'category'] } });
  });

  it('is idempotent when replayed', async () => {
    const adapter = createMemoryAdapter();
    const m = mutation([upsert('item', 'a', { x: 1 }), upsert('category', 'c'), link('a', 'c', { weight: 3 })], {
      createIfMissing: true,
    });
    await write(adapter, m);
    const once = await snapshot(adapter);
    const again = await write(adapter, m);
    expect(again).toMatchObject({ ok: true, value: { graphCreated: false } });
    expect(await snapshot(adapter)).toEqual(once);
  });

  it('accepts an empty mutation on an existing graph', async () => {
    const adapter = await seeded();
    expect(await write(adapter, mutation([]))).toEqual({ ok: true, value: { graphId: 'g', applied: 0, graphCreated: false } });
  });

  it('commits concurrent mutations to one graph without losing any', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    await write(adapter, mutation([upsert('category', 'c')]));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        write(adapter, mutation([link(`i${String(i).padStart(2, '0')}`, 'c', { ensureNodes: true })])),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await snapshot(adapter)).edges).toHaveLength(20);
  });
});

describe('write: atomicity (FR-08, AC-04)', () => {
  it('leaves the store unchanged when op 4 of 5 fails', async () => {
    const adapter = await seeded();
    const before = await snapshot(adapter);
    const r = await write(adapter, mutation([
      upsert('item', 'n1', { title: 'changed' }), // 1: modifies existing data
      upsert('item', 'brand-new'), // 2: creates
      { op: 'deleteNode', partition: 'category', id: 'work' }, // 3: deletes with cascade
      link('n2', 'nonexistent'), // 4: fails, category missing
      upsert('item', 'never-reached'), // 5
    ]));
    expect(r).toMatchObject({ ok: false, error: { code: 'NODE_NOT_FOUND', path: ['ops', 3, 'category'] } });
    expect(await snapshot(adapter)).toEqual(before);
  });

  it('reports the first failing op, with its index in the path', async () => {
    const adapter = await seeded();
    const r = await write(adapter, mutation([upsert('item', 'x'), link('ghost', 'work'), link('n1', 'ghost')]));
    expect(r).toMatchObject({ ok: false, error: { code: 'NODE_NOT_FOUND', path: ['ops', 1, 'item'] } });
  });

  it('turns a storage failure mid-mutation into STORAGE_ERROR and rolls back', async () => {
    const real = await seeded();
    const before = await snapshot(real);
    const failing: StorageAdapter = {
      ...real,
      transaction: (graphId, fn) =>
        real.transaction(graphId, (tx) => fn({ ...tx, putEdges: async () => { throw new Error('disk full'); } } as AdapterTx)),
    };
    const r = await write(failing, mutation([upsert('item', 'new'), link('n2', 'home')]));
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR', message: expect.stringContaining('disk full') } });
    expect(await snapshot(real)).toEqual(before);
  });

  it('never throws, even when every adapter call throws', async () => {
    const hostile = new Proxy({}, { get() { throw new Error('adapter exploded'); } }) as StorageAdapter;
    const r = await write(hostile, mutation([upsert('item', 'a')]));
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
  });

  it('refuses to run on an adapter without transactions, before touching anything', async () => {
    const { adapter, calls } = spied();
    const noTx: StorageAdapter = { ...adapter, capabilities: { ...adapter.capabilities, transactions: false } };
    const r = await write(noTx, mutation([upsert('item', 'a')], { createIfMissing: true }));
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR', message: expect.stringContaining('transactions') } });
    expect(calls).toEqual({ create: [], drop: [], transaction: [], exists: [] });
  });
});

describe('write: graph resolution (FR-02, AC-02)', () => {
  it('fails with GRAPH_NOT_FOUND and writes nothing for a missing graph', async () => {
    const { adapter, calls } = spied();
    const r = await write(adapter, mutation([upsert('item', 'a')], { graphId: 'C' }));
    expect(r).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND' } });
    expect(calls).toEqual({ create: [], drop: [], transaction: [], exists: ['C'] });
    expect(await adapter.graphs.exists('C')).toBe(false);
  });

  it('creates the graph when createIfMissing is set', async () => {
    const adapter = createMemoryAdapter();
    const r = await write(adapter, mutation([upsert('item', 'a')], { graphId: 'C', createIfMissing: true }));
    expect(r).toEqual({ ok: true, value: { graphId: 'C', applied: 1, graphCreated: true } });
    expect(await adapter.graphs.exists('C')).toBe(true);
  });

  it('removes a graph it created when the mutation fails', async () => {
    const { adapter, calls } = spied();
    const r = await write(adapter, mutation([upsert('item', 'a'), link('a', 'missing')], { graphId: 'C', createIfMissing: true }));
    expect(r).toMatchObject({ ok: false, error: { code: 'NODE_NOT_FOUND', path: ['ops', 1, 'category'] } });
    expect(calls.create).toEqual(['C']);
    expect(calls.drop).toEqual(['C']);
    expect(await adapter.graphs.exists('C')).toBe(false);
    expect((await adapter.graphs.list({ limit: 10, cursor: null })).items).toEqual([]);
  });

  it('keeps an existing graph when a mutation fails, and never drops it', async () => {
    const real = await seeded();
    const { adapter, calls } = spied(real);
    const r = await write(adapter, mutation([link('n1', 'ghost')], { createIfMissing: true }));
    expect(r.ok).toBe(false);
    expect(calls.drop).toEqual([]);
    expect(await adapter.graphs.exists('g')).toBe(true);
  });

  it('keeps a created graph if a concurrent writer has put data in it', async () => {
    const real = createMemoryAdapter();
    const { adapter, calls } = spied(real);
    const racy: StorageAdapter = {
      ...adapter,
      graphs: {
        ...adapter.graphs,
        create: async (id) => {
          await adapter.graphs.create(id);
          await real.transaction(id, (tx) => tx.putNodes([{ partition: 'item', id: 'from-other-writer' } as NodeRecord]));
        },
      },
    };
    const r = await write(racy, mutation([link('a', 'missing')], { graphId: 'C', createIfMissing: true }));
    expect(r.ok).toBe(false);
    expect(calls.drop).toEqual([]);
    expect((await snapshot(real, 'C')).items.map((n) => n.id)).toEqual(['from-other-writer']);
  });

  it('reports both problems when the cleanup of a created graph also fails', async () => {
    const { adapter } = spied();
    const brokenDrop: StorageAdapter = {
      ...adapter,
      graphs: { ...adapter.graphs, drop: async () => { throw new Error('cannot drop'); } },
    };
    const r = await write(brokenDrop, mutation([link('a', 'missing')], { graphId: 'C', createIfMissing: true }));
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: expect.stringMatching(/does not exist.*cannot drop/s) },
    });
  });
});

describe('write: validation never reaches the adapter (AC-03, AC-10, AC-14)', () => {
  const untouchable = new Proxy({}, { get() { throw new Error('adapter was touched'); } }) as StorageAdapter;

  it.each([
    ['an item-item link (items list)', { op: 'link', items: ['a', 'b'] }],
    ['a category-category link (from/to)', { op: 'link', from: { partition: 'category', id: 'a' }, to: { partition: 'category', id: 'b' } }],
    ['a link with a second item key', { op: 'link', item: 'a', item2: 'b' }],
  ])('rejects %s with VALIDATION_ERROR and an ops path, adapter untouched', async (_name, bad) => {
    const r = await write(untouchable, mutation([upsert('item', 'ok'), bad]));
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    if (!r.ok) expect(r.error.path?.slice(0, 2)).toEqual(['ops', 1]);
  });

  it('rejects an unknown version and malformed input without any adapter call', async () => {
    expect(await write(untouchable, { ...mutation([]), version: 9 })).toMatchObject({ error: { code: 'UNSUPPORTED_VERSION' } });
    expect((await write(untouchable, null)).ok).toBe(false);
  });
});
