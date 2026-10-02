import assert from 'node:assert/strict';
import type { AdapterTx, EdgeRecord, NodeRecord, StorageAdapter } from '../adapter.js';
import { walk } from './helpers.js';
import type { ConformanceCase, ConformanceGroup } from './types.js';

// These cases talk to the adapter directly, with no core in between: they are the storage contract
// every adapter must honour for the core's rules (cascade, atomic writes, paging) to hold.

const pad = (n: number, width = 3): string => String(n).padStart(width, '0');
const item = (id: string, data?: NodeRecord['data']): NodeRecord => (data === undefined ? { partition: 'item', id } : { partition: 'item', id, data });
const category = (id: string, data?: NodeRecord['data']): NodeRecord => (data === undefined ? { partition: 'category', id } : { partition: 'category', id, data });
const edge = (itemId: string, categoryId: string, extra: Partial<EdgeRecord> = {}): EdgeRecord => ({ item: itemId, category: categoryId, ...extra });
const ids = (nodes: readonly NodeRecord[]): string[] => nodes.map((n) => n.id);

/** A fresh graph `g`, and a short way to run something inside a transaction on it. */
async function graph(adapter: StorageAdapter): Promise<<T>(fn: (tx: AdapterTx) => Promise<T>) => Promise<T>> {
  await adapter.graphs.create('g');
  return (fn) => adapter.transaction('g', fn);
}

const nodeCases = (): ConformanceCase[] => [
  {
    name: 'FR-04: nodes are stored per partition, so an item and a category can share an id',
    run: async (adapter) => {
      const tx = await graph(adapter);
      await tx((t) => t.putNodes([item('x', { as: 'item' }), category('x', { as: 'category' })]));
      assert.deepEqual(await tx((t) => t.getNodes('item', ['x'])), [item('x', { as: 'item' })]);
      assert.deepEqual(await tx((t) => t.getNodes('category', ['x'])), [category('x', { as: 'category' })]);
      await tx((t) => t.deleteNodes('item', ['x']));
      assert.deepEqual(await tx((t) => t.getNodes('item', ['x'])), []);
      assert.deepEqual(await tx((t) => t.getNodes('category', ['x'])), [category('x', { as: 'category' })]);
    },
  },
  {
    name: 'FR-03: putNodes replaces the whole record; getNodes skips missing ids and keeps request order',
    run: async (adapter) => {
      const tx = await graph(adapter);
      await tx((t) => t.putNodes([item('a', { v: 1, keep: true }), item('b'), item('c')]));
      await tx((t) => t.putNodes([item('a', { v: 2 })])); // not a merge: `keep` must be gone
      assert.deepEqual(await tx((t) => t.getNodes('item', ['c', 'missing', 'a', 'b'])), [item('c'), item('a', { v: 2 }), item('b')]);
      await tx((t) => t.putNodes([item('a')]));
      assert.deepEqual(await tx((t) => t.getNodes('item', ['a'])), [item('a')], 'a record without data has no data');
    },
  },
  {
    name: 'FR-03: deleteNodes removes only the named nodes and ignores ids that do not exist',
    run: async (adapter) => {
      const tx = await graph(adapter);
      await tx((t) => t.putNodes([item('a'), item('b'), category('a')]));
      await tx((t) => t.deleteNodes('item', ['a', 'never-existed']));
      assert.deepEqual(ids((await tx((t) => t.listNodes('item', { limit: 10, cursor: null }))).items), ['b']);
      assert.deepEqual(ids((await tx((t) => t.listNodes('category', { limit: 10, cursor: null }))).items), ['a']);
    },
  },
  {
    name: 'FR-03: node data is copied on the way in and on the way out, never shared',
    run: async (adapter) => {
      const tx = await graph(adapter);
      const input = { tags: ['x'], nested: { n: 1 } };
      await tx((t) => t.putNodes([item('a', input)]));
      input.tags.push('changed-after-put');
      input.nested.n = 99;
      const [out] = await tx((t) => t.getNodes('item', ['a']));
      assert.deepEqual(out?.data, { tags: ['x'], nested: { n: 1 } });
      (out?.data?.tags as string[]).push('changed-after-get');
      const [again] = await tx((t) => t.getNodes('item', ['a']));
      assert.deepEqual(again?.data, { tags: ['x'], nested: { n: 1 } });
      const listed = (await tx((t) => t.listNodes('item', { limit: 10, cursor: null }))).items[0];
      (listed?.data?.tags as string[]).push('changed-after-list');
      assert.deepEqual((await tx((t) => t.getNodes('item', ['a'])))[0]?.data?.tags, ['x']);
    },
  },
];

const transactionCases = (): ConformanceCase[] => [
  {
    name: 'FR-08: a transaction returns its callback\'s result and commits what it wrote',
    run: async (adapter) => {
      const tx = await graph(adapter);
      const result = await tx(async (t) => {
        await t.putNodes([item('a')]);
        return 'the result';
      });
      assert.equal(result, 'the result');
      assert.deepEqual(await tx((t) => t.getNodes('item', ['a'])), [item('a')]);
    },
  },
  {
    name: 'FR-08: inside a transaction, later reads see earlier writes',
    run: async (adapter) => {
      const tx = await graph(adapter);
      const seen = await tx(async (t) => {
        await t.putNodes([item('a'), category('c')]);
        await t.putEdges([edge('a', 'c', { weight: 2 })]);
        await t.deleteNodes('item', ['gone']);
        return {
          node: await t.getNodes('item', ['a']),
          edges: (await t.edgesOf('item', 'a', { limit: 10, cursor: null })).items,
          listed: ids((await t.listNodes('category', { limit: 10, cursor: null })).items),
        };
      });
      assert.deepEqual(seen, { node: [item('a')], edges: [edge('a', 'c', { weight: 2 })], listed: ['c'] });
    },
  },
  {
    name: 'FR-08: a transaction that throws undoes every kind of write, and the adapter keeps working',
    run: async (adapter) => {
      const tx = await graph(adapter);
      await tx(async (t) => {
        await t.putNodes([item('keep', { v: 1 }), category('c')]);
        await t.putEdges([edge('keep', 'c')]);
      });
      await assert.rejects(
        tx(async (t) => {
          await t.putNodes([item('lost'), item('keep', { v: 2 })]);
          await t.deleteNodes('category', ['c']);
          await t.putEdges([edge('lost', 'c')]);
          await t.deleteEdges([{ item: 'keep', category: 'c' }]);
          throw new Error('abort');
        }),
        /abort/,
      );
      assert.deepEqual(await tx((t) => t.getNodes('item', ['keep', 'lost'])), [item('keep', { v: 1 })]);
      assert.deepEqual(await tx((t) => t.getNodes('category', ['c'])), [category('c')]);
      assert.deepEqual((await tx((t) => t.edgesOf('category', 'c', { limit: 10, cursor: null }))).items, [edge('keep', 'c')]);
      await tx((t) => t.putNodes([item('after')])); // still usable after a failure
      assert.deepEqual(await tx((t) => t.getNodes('item', ['after'])), [item('after')]);
    },
  },
  {
    name: 'FR-08: concurrent transactions on one graph are serialised, so no update is lost',
    run: async (adapter) => {
      const tx = await graph(adapter);
      await tx((t) => t.putNodes([item('counter', { n: 0 }), category('c')]));
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          tx(async (t) => {
            const [counter] = await t.getNodes('item', ['counter']);
            const before = (await t.edgesOf('category', 'c', { limit: 1000, cursor: null })).items.length;
            await Promise.resolve(); // yield, so unserialised transactions would interleave here
            await new Promise((resolve) => setTimeout(resolve, 0));
            await t.putNodes([item('counter', { n: Number(counter?.data?.n) + 1 })]);
            await t.putEdges([edge(`i${pad(i)}`, 'c', { weight: before })]);
          }),
        ),
      );
      const [counter] = await tx((t) => t.getNodes('item', ['counter']));
      assert.equal(counter?.data?.n, 30, 'every increment must be kept');
      assert.equal((await tx((t) => t.edgesOf('category', 'c', { limit: 1000, cursor: null }))).items.length, 30);
    },
  },
  {
    name: 'FR-02: a transaction on a graph that does not exist rejects and does not create it',
    run: async (adapter) => {
      await assert.rejects(adapter.transaction('nope', async (t) => t.putNodes([item('a')])));
      assert.equal(await adapter.graphs.exists('nope'), false);
      assert.deepEqual((await adapter.graphs.list({ limit: 10, cursor: null })).items, []);
    },
  },
];

const edgeCases = (): ConformanceCase[] => [
  {
    name: 'FR-05: an edge is found from either end, ordered by the other end\'s id',
    run: async (adapter) => {
      const tx = await graph(adapter);
      await tx((t) => t.putEdges([edge('i1', 'c2'), edge('i1', 'c1'), edge('i2', 'c1'), edge('i0', 'c1'), edge('x', 'other'), edge('another', 'x')]));
      const page = { limit: 100, cursor: null };
      assert.deepEqual((await tx((t) => t.edgesOf('item', 'i1', page))).items.map((e) => e.category), ['c1', 'c2']);
      assert.deepEqual((await tx((t) => t.edgesOf('category', 'c1', page))).items.map((e) => e.item), ['i0', 'i1', 'i2']);
      assert.deepEqual((await tx((t) => t.edgesOf('item', 'ghost', page))).items, []);
      assert.deepEqual((await tx((t) => t.edgesOf('category', 'ghost', page))).items, []);
      // an item and a category with the same id are different nodes with different edges
      assert.deepEqual((await tx((t) => t.edgesOf('item', 'x', page))).items.map((e) => e.category), ['other']);
      assert.deepEqual((await tx((t) => t.edgesOf('category', 'x', page))).items.map((e) => e.item), ['another']);
    },
  },
  {
    name: 'FR-05: putEdges is an idempotent upsert: one edge, the latest weight wins, even 0',
    run: async (adapter) => {
      const tx = await graph(adapter);
      const read = async () => ({
        fromItem: (await tx((t) => t.edgesOf('item', 'a', { limit: 10, cursor: null }))).items,
        fromCategory: (await tx((t) => t.edgesOf('category', 'c', { limit: 10, cursor: null }))).items,
      });
      await tx((t) => t.putEdges([edge('a', 'c', { weight: 1 })]));
      await tx((t) => t.putEdges([edge('a', 'c', { weight: 5 })]));
      assert.deepEqual(await read(), { fromItem: [edge('a', 'c', { weight: 5 })], fromCategory: [edge('a', 'c', { weight: 5 })] });
      await tx((t) => t.putEdges([edge('a', 'c', { weight: 0 })]));
      assert.equal((await read()).fromItem[0]?.weight, 0);
    },
  },
  {
    name: 'FR-05: putEdges replaces the whole edge record, and the last duplicate in one call wins',
    run: async (adapter) => {
      const tx = await graph(adapter);
      await tx((t) => t.putEdges([edge('a', 'c', { weight: 1, data: { k: 1 } })]));
      await tx((t) => t.putEdges([edge('a', 'c')]));
      assert.deepEqual((await tx((t) => t.edgesOf('item', 'a', { limit: 10, cursor: null }))).items, [edge('a', 'c')]);
      await tx((t) => t.putEdges([edge('a', 'c', { weight: 1 }), edge('a', 'c', { weight: 2 })]));
      assert.deepEqual((await tx((t) => t.edgesOf('item', 'a', { limit: 10, cursor: null }))).items, [edge('a', 'c', { weight: 2 })]);
    },
  },
  {
    name: 'FR-05: edge data is copied on the way in and on the way out, never shared',
    run: async (adapter) => {
      const tx = await graph(adapter);
      const data = { tags: ['x'] };
      await tx((t) => t.putEdges([edge('a', 'c', { data })]));
      data.tags.push('changed-after-put');
      const [out] = (await tx((t) => t.edgesOf('item', 'a', { limit: 10, cursor: null }))).items;
      assert.deepEqual(out?.data, { tags: ['x'] });
      (out?.data?.tags as string[]).push('changed-after-read');
      const [again] = (await tx((t) => t.edgesOf('category', 'c', { limit: 10, cursor: null }))).items;
      assert.deepEqual(again?.data, { tags: ['x'] });
    },
  },
  {
    name: 'FR-05: deleteEdges removes an edge from both ends, keeps the others, and ignores unknown keys',
    run: async (adapter) => {
      const tx = await graph(adapter);
      const page = { limit: 10, cursor: null };
      await tx((t) => t.putEdges([edge('a', 'c1'), edge('a', 'c2'), edge('b', 'c1')]));
      await tx((t) => t.deleteEdges([{ item: 'a', category: 'c1' }, { item: 'a', category: 'nope' }, { item: 'nope', category: 'c1' }]));
      assert.deepEqual((await tx((t) => t.edgesOf('item', 'a', page))).items.map((e) => e.category), ['c2']);
      assert.deepEqual((await tx((t) => t.edgesOf('category', 'c1', page))).items.map((e) => e.item), ['b']);
      await tx((t) => t.putEdges([edge('a', 'c1', { weight: 9 })])); // can be added again
      assert.deepEqual((await tx((t) => t.edgesOf('category', 'c1', page))).items, [edge('a', 'c1', { weight: 9 }), edge('b', 'c1')]);
    },
  },
  {
    name: 'FR-07: the core\'s cascade works from the primitives: edgesOf, then deleteEdges, then deleteNodes',
    run: async (adapter) => {
      const tx = await graph(adapter);
      const page = { limit: 1000, cursor: null };
      await tx(async (t) => {
        await t.putNodes([category('work'), category('keep'), item('i1'), item('i2'), item('i3')]);
        await t.putEdges([edge('i1', 'work'), edge('i2', 'work'), edge('i3', 'work'), edge('i1', 'keep')]);
      });
      await tx(async (t) => {
        const { items } = await t.edgesOf('category', 'work', page);
        await t.deleteEdges(items.map((e) => ({ item: e.item, category: e.category })));
        await t.deleteNodes('category', ['work']);
      });
      for (const id of ['i1', 'i2', 'i3']) {
        const left = (await tx((t) => t.edgesOf('item', id, page))).items.map((e) => e.category);
        assert.ok(!left.includes('work'), `item ${id} must not list the deleted category`);
      }
      assert.deepEqual((await tx((t) => t.edgesOf('category', 'work', page))).items, []);
      assert.deepEqual((await tx((t) => t.edgesOf('item', 'i1', page))).items, [edge('i1', 'keep')]);
      assert.deepEqual(ids((await tx((t) => t.listNodes('item', page))).items), ['i1', 'i2', 'i3']);
    },
  },
];

const pagingCases = (): ConformanceCase[] => [
  {
    name: 'FR-14: listNodes pages 120 nodes as 3 pages of unique ids in id order, whatever order they were added in',
    run: async (adapter) => {
      const tx = await graph(adapter);
      const expected = Array.from({ length: 120 }, (_, i) => `n${pad(i)}`);
      await tx((t) => t.putNodes([...expected].reverse().map((id) => item(id))));
      await tx((t) => t.putNodes([category('not-an-item')]));
      const { items, pages } = await tx((t) => walk((page) => t.listNodes('item', page), 50));
      assert.equal(pages, 3);
      assert.deepEqual(ids(items), expected, 'only items, each exactly once, in id order');
    },
  },
  {
    name: 'FR-14: a page that exactly fills the limit has no next cursor, and a limit of 1 still walks everything',
    run: async (adapter) => {
      const tx = await graph(adapter);
      await tx((t) => t.putNodes(['a', 'b', 'c'].map((id) => item(id))));
      const exact = await tx((t) => t.listNodes('item', { limit: 3, cursor: null }));
      assert.deepEqual([ids(exact.items), exact.nextCursor], [['a', 'b', 'c'], null]);
      const roomy = await tx((t) => t.listNodes('item', { limit: 1000, cursor: null }));
      assert.equal(roomy.nextCursor, null);
      const single = await tx((t) => walk((page) => t.listNodes('item', page), 1));
      assert.deepEqual([ids(single.items), single.pages], [['a', 'b', 'c'], 3]);
      assert.deepEqual((await tx((t) => t.listNodes('category', { limit: 5, cursor: null }))), { items: [], nextCursor: null });
    },
  },
  {
    name: 'FR-14: listNodes does not skip or repeat nodes added between pages',
    run: async (adapter) => {
      const tx = await graph(adapter);
      await tx((t) => t.putNodes(['b', 'd', 'f'].map((id) => item(id))));
      const p1 = await tx((t) => t.listNodes('item', { limit: 2, cursor: null }));
      await tx((t) => t.putNodes(['a', 'c', 'e'].map((id) => item(id))));
      await tx((t) => t.deleteNodes('item', ['b']));
      const p2 = await tx((t) => t.listNodes('item', { limit: 10, cursor: p1.nextCursor }));
      assert.deepEqual(ids(p1.items), ['b', 'd']);
      assert.deepEqual(ids(p2.items), ['e', 'f']);
      assert.equal(p2.nextCursor, null);
    },
  },
  {
    name: 'FR-14: edgesOf pages 120 edges as 3 pages of unique ids in order, from either end',
    run: async (adapter) => {
      const tx = await graph(adapter);
      const expected = Array.from({ length: 120 }, (_, i) => `n${pad(i)}`);
      await tx((t) => t.putEdges([...expected].reverse().flatMap((id) => [edge('hub', id), edge(id, 'hub')])));
      await tx((t) => t.putEdges([edge('other', 'elsewhere')]));
      const fromItem = await tx((t) => walk((page) => t.edgesOf('item', 'hub', page), 50));
      const fromCategory = await tx((t) => walk((page) => t.edgesOf('category', 'hub', page), 50));
      assert.deepEqual([fromItem.pages, fromCategory.pages], [3, 3]);
      assert.deepEqual(fromItem.items.map((e) => e.category), expected);
      assert.deepEqual(fromCategory.items.map((e) => e.item), expected);
    },
  },
  {
    name: 'FR-14: edgesOf does not skip or repeat edges added or removed between pages, and ends with a null cursor',
    run: async (adapter) => {
      const tx = await graph(adapter);
      await tx((t) => t.putEdges(['b', 'd', 'f'].map((c) => edge('i', c))));
      const p1 = await tx((t) => t.edgesOf('item', 'i', { limit: 2, cursor: null }));
      await tx((t) => t.putEdges(['a', 'c', 'e'].map((c) => edge('i', c))));
      await tx((t) => t.deleteEdges([{ item: 'i', category: 'b' }]));
      const p2 = await tx((t) => t.edgesOf('item', 'i', { limit: 10, cursor: p1.nextCursor }));
      assert.deepEqual(p1.items.map((e) => e.category), ['b', 'd']);
      assert.deepEqual(p2.items.map((e) => e.category), ['e', 'f']);
      assert.equal(p2.nextCursor, null);
      const exact = await tx((t) => t.edgesOf('item', 'i', { limit: 5, cursor: null }));
      assert.deepEqual([exact.items.length, exact.nextCursor], [5, null], 'a page that exactly fills the limit ends the listing');
    },
  },
];

/** The storage contract the core relies on: nodes, edges, transactions and paging (FR-03 to FR-08, FR-14). */
export function primitivesGroup(): ConformanceGroup {
  return { name: 'primitives', cases: [...nodeCases(), ...transactionCases(), ...edgeCases(), ...pagingCases()] };
}
