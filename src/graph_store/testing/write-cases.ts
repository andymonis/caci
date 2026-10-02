import assert from 'node:assert/strict';
import type { EdgeRecord, NodeRecord, StorageAdapter } from '../adapter.js';
import { write } from '../endpoints.js';
import type { ConformanceCase, ConformanceGroup } from './types.js';

const mutation = (ops: unknown[], extra: object = {}) => ({ version: 1, kind: 'mutation', graphId: 'g', ops, ...extra });
const upsert = (partition: 'item' | 'category', id: string, data?: object) => ({
  op: 'upsertNode',
  partition,
  id,
  ...(data === undefined ? {} : { data }),
});
const link = (item: string, category: string, extra: object = {}) => ({ op: 'link', item, category, ...extra });
const page = { limit: 1000, cursor: null };

interface Snapshot {
  items: NodeRecord[];
  categories: NodeRecord[];
  /** Edges found by walking from the items. */
  edgesFromItems: EdgeRecord[];
  /** Edges found by walking from the categories. A dangling edge shows up in only one of the two. */
  edgesFromCategories: EdgeRecord[];
}

const byKey = (a: EdgeRecord, b: EdgeRecord): number => `${a.item}\u0000${a.category}`.localeCompare(`${b.item}\u0000${b.category}`);

/** Everything stored in a graph, read through the adapter's own primitives. */
async function snapshot(adapter: StorageAdapter, graphId = 'g'): Promise<Snapshot> {
  return adapter.transaction(graphId, async (tx) => {
    const items = [...(await tx.listNodes('item', page)).items];
    const categories = [...(await tx.listNodes('category', page)).items];
    const edgesFromItems: EdgeRecord[] = [];
    for (const item of items) edgesFromItems.push(...(await tx.edgesOf('item', item.id, page)).items);
    const edgesFromCategories: EdgeRecord[] = [];
    for (const category of categories) edgesFromCategories.push(...(await tx.edgesOf('category', category.id, page)).items);
    return {
      items,
      categories,
      edgesFromItems: edgesFromItems.sort(byKey),
      edgesFromCategories: edgesFromCategories.sort(byKey),
    };
  });
}

/** Edges whose item or category node no longer exists. */
function danglingEdges(s: Snapshot): EdgeRecord[] {
  const items = new Set(s.items.map((n) => n.id));
  const categories = new Set(s.categories.map((n) => n.id));
  return [...s.edgesFromItems, ...s.edgesFromCategories].filter((e) => !items.has(e.item) || !categories.has(e.category));
}

async function seed(adapter: StorageAdapter): Promise<void> {
  const r = await write(
    adapter,
    mutation(
      [
        upsert('item', 'n1', { title: 'one' }),
        upsert('item', 'n2'),
        upsert('item', 'n3'),
        upsert('category', 'work', { label: 'Work' }),
        upsert('category', 'home'),
        link('n1', 'work', { weight: 2 }),
        link('n2', 'work'),
        link('n3', 'work'),
        link('n1', 'home'),
      ],
      { createIfMissing: true },
    ),
  );
  assert.equal(r.ok, true, 'seeding the graph should succeed');
}

/** Wraps an adapter and records every property read, so a test can prove it was never used. */
function watch(adapter: StorageAdapter): { adapter: StorageAdapter; touched: string[] } {
  const touched: string[] = [];
  const proxy = new Proxy(adapter, {
    get(target, prop, receiver) {
      touched.push(String(prop));
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return { adapter: proxy, touched };
}

const badLinks = (): Array<[string, unknown]> => [
  ['two items (items list)', { op: 'link', items: ['a', 'b'] }],
  ['two items (from/to)', { op: 'link', from: { partition: 'item', id: 'a' }, to: { partition: 'item', id: 'b' } }],
  ['two categories (categories list)', { op: 'link', categories: ['x', 'y'] }],
  ['two categories (from/to)', { op: 'link', from: { partition: 'category', id: 'x' }, to: { partition: 'category', id: 'y' } }],
  ['two items (extra item2 key)', { op: 'link', item: 'a', item2: 'b' }],
  ['two categories (extra category2 key)', { op: 'link', category: 'x', category2: 'y' }],
  ['an item and a category plus a partition override', { op: 'link', item: 'a', category: 'b', partition: 'item' }],
];

const ac02 = (): ConformanceCase[] => [
  {
    name: 'AC-02: a mutation on a missing graph fails with GRAPH_NOT_FOUND and writes nothing',
    run: async (adapter) => {
      const r = await write(adapter, mutation([upsert('item', 'a')], { graphId: 'C' }));
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'GRAPH_NOT_FOUND');
      assert.equal(await adapter.graphs.exists('C'), false);
      assert.deepEqual((await adapter.graphs.list(page)).items, []);
    },
  },
  {
    name: 'AC-02: createIfMissing creates the graph and applies the ops',
    run: async (adapter) => {
      const r = await write(adapter, mutation([upsert('item', 'a', { v: 1 })], { graphId: 'C', createIfMissing: true }));
      assert.deepEqual(r, { ok: true, value: { graphId: 'C', applied: 1, graphCreated: true } });
      assert.deepEqual((await snapshot(adapter, 'C')).items, [{ partition: 'item', id: 'a', data: { v: 1 } }]);
    },
  },
];

const ac03 = (): ConformanceCase[] =>
  badLinks().map(([label, bad]) => ({
    name: `AC-03: a link naming ${label} is rejected with a path to the op, before the adapter is called`,
    run: async (adapter) => {
      const watched = watch(adapter);
      const r = await write(watched.adapter, mutation([upsert('item', 'ok'), bad], { createIfMissing: true }));
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'VALIDATION_ERROR');
      assert.deepEqual(r.error.path?.slice(0, 2), ['ops', 1]);
      assert.deepEqual(watched.touched, [], 'the adapter must not be used for an invalid mutation');
      assert.equal(await adapter.graphs.exists('g'), false);
    },
  }));

const ac04 = (): ConformanceCase[] => [
  {
    name: 'AC-04: a mutation of 5 ops where op 4 fails leaves the store unchanged',
    run: async (adapter) => {
      await seed(adapter);
      const before = await snapshot(adapter);
      const r = await write(
        adapter,
        mutation([
          upsert('item', 'n1', { title: 'changed' }), // 1: changes existing data
          upsert('item', 'brand-new'), // 2: creates a node
          { op: 'deleteNode', partition: 'category', id: 'work' }, // 3: deletes, cascading edges
          link('n2', 'nonexistent'), // 4: fails, the category is missing
          upsert('item', 'never-reached'), // 5
        ]),
      );
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'NODE_NOT_FOUND');
      assert.deepEqual(r.error.path, ['ops', 3, 'category']);
      assert.deepEqual(await snapshot(adapter), before);
    },
  },
  {
    name: 'AC-04: a failed mutation does not leave behind a graph it would have created',
    run: async (adapter) => {
      const r = await write(adapter, mutation([upsert('item', 'a'), link('a', 'missing')], { graphId: 'C', createIfMissing: true }));
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'NODE_NOT_FOUND');
      assert.equal(await adapter.graphs.exists('C'), false);
      assert.deepEqual((await adapter.graphs.list(page)).items, []);
    },
  },
];

const ac05 = (): ConformanceCase[] => [
  {
    name: 'AC-05: deleting a category linked to 3 items leaves no orphan edges',
    run: async (adapter) => {
      await seed(adapter);
      const r = await write(adapter, mutation([{ op: 'deleteNode', partition: 'category', id: 'work' }]));
      assert.equal(r.ok, true);
      const after = await snapshot(adapter);
      for (const id of ['n1', 'n2', 'n3']) {
        const categories = after.edgesFromItems.filter((e) => e.item === id).map((e) => e.category);
        assert.ok(!categories.includes('work'), `item ${id} must no longer list the deleted category`);
      }
      assert.deepEqual(danglingEdges(after), []);
      assert.deepEqual(after.edgesFromItems, [{ item: 'n1', category: 'home' }]);
      assert.deepEqual(after.items.map((n) => n.id), ['n1', 'n2', 'n3']);
    },
  },
  {
    name: 'AC-05: deleting an item removes its edges from the category side too',
    run: async (adapter) => {
      await seed(adapter);
      await write(adapter, mutation([{ op: 'deleteNode', partition: 'item', id: 'n1' }]));
      const after = await snapshot(adapter);
      assert.deepEqual(danglingEdges(after), []);
      assert.deepEqual(after.edgesFromCategories.map((e) => e.item).sort(), ['n2', 'n3']);
    },
  },
];

const ac06 = (): ConformanceCase[] => [
  {
    name: 'AC-06: linking the same pair twice leaves exactly one edge with the latest weight',
    run: async (adapter) => {
      await adapter.graphs.create('g');
      await write(adapter, mutation([upsert('item', 'i'), upsert('category', 'c'), link('i', 'c', { weight: 1 })]));
      await write(adapter, mutation([link('i', 'c', { weight: 5 })]));
      const s = await snapshot(adapter);
      assert.deepEqual(s.edgesFromItems, [{ item: 'i', category: 'c', weight: 5 }]);
      assert.deepEqual(s.edgesFromCategories, [{ item: 'i', category: 'c', weight: 5 }]);
    },
  },
  {
    name: 'AC-06: the latest weight wins even when it is 0',
    run: async (adapter) => {
      await adapter.graphs.create('g');
      await write(adapter, mutation([upsert('item', 'i'), upsert('category', 'c'), link('i', 'c', { weight: 3 }), link('i', 'c', { weight: 0 })]));
      assert.equal((await snapshot(adapter)).edgesFromItems[0]?.weight, 0);
    },
  },
];

/** Behaviour of `write` that every adapter must support: AC-02 to AC-06. */
export function writeGroup(): ConformanceGroup {
  return { name: 'write', cases: [...ac02(), ...ac03(), ...ac04(), ...ac05(), ...ac06()] };
}
