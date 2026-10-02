import assert from 'node:assert/strict';
import type { AdapterTx, EdgeRecord, NodeRecord, StorageAdapter } from '../adapter.js';
import type { ConformanceCase, ConformanceGroup } from './types.js';
import { isolationGroup } from './isolation-cases.js';
import { writeGroup } from './write-cases.js';

const first = { limit: 1000, cursor: null };
const item = (id: string): NodeRecord => ({ partition: 'item', id });
const category = (id: string): NodeRecord => ({ partition: 'category', id });
const edge = (itemId: string, categoryId: string): EdgeRecord => ({ item: itemId, category: categoryId });

const withGraph = async <T>(adapter: StorageAdapter, fn: (tx: AdapterTx) => Promise<T>): Promise<T> => {
  await adapter.graphs.create('g');
  return adapter.transaction('g', fn);
};

const smokeCases = (): ConformanceCase[] => [
  {
    name: 'reports a name and its capabilities',
    run: async (adapter) => {
      assert.equal(typeof adapter.name, 'string');
      assert.notEqual(adapter.name, '');
      for (const flag of ['transactions', 'idempotency', 'nativeSetQueries'] as const) {
        assert.equal(typeof adapter.capabilities[flag], 'boolean', `capabilities.${flag} must be a boolean`);
      }
    },
  },
  {
    name: 'creates, finds and drops a graph',
    run: async (adapter) => {
      assert.equal(await adapter.graphs.exists('g'), false);
      await adapter.graphs.create('g');
      assert.equal(await adapter.graphs.exists('g'), true);
      assert.deepEqual((await adapter.graphs.list(first)).items, ['g']);
      await adapter.graphs.drop('g');
      assert.equal(await adapter.graphs.exists('g'), false);
      assert.deepEqual((await adapter.graphs.list(first)).items, []);
    },
  },
  {
    name: 'starts a new graph empty',
    run: async (adapter) => {
      const [items, categories] = await withGraph(adapter, async (tx) => [
        await tx.listNodes('item', first),
        await tx.listNodes('category', first),
      ]);
      assert.deepEqual(items?.items, []);
      assert.deepEqual(categories?.items, []);
    },
  },
  {
    name: 'stores and reads back nodes and an edge',
    run: async (adapter) => {
      await withGraph(adapter, async (tx) => {
        await tx.putNodes([item('a'), category('c')]);
        await tx.putEdges([edge('a', 'c')]);
      });
      const read = await adapter.transaction('g', async (tx) => ({
        items: await tx.getNodes('item', ['a']),
        categories: await tx.getNodes('category', ['c']),
        fromItem: (await tx.edgesOf('item', 'a', first)).items,
        fromCategory: (await tx.edgesOf('category', 'c', first)).items,
      }));
      assert.deepEqual(read.items, [item('a')]);
      assert.deepEqual(read.categories, [category('c')]);
      assert.deepEqual(read.fromItem, [edge('a', 'c')]);
      assert.deepEqual(read.fromCategory, [edge('a', 'c')]);
    },
  },
  {
    name: 'leaves nothing behind when a transaction throws',
    run: async (adapter) => {
      await adapter.graphs.create('g');
      await adapter.transaction('g', (tx) => tx.putNodes([item('keep')]));
      await assert.rejects(
        adapter.transaction('g', async (tx) => {
          await tx.putNodes([item('lost')]);
          await tx.deleteNodes('item', ['keep']);
          await tx.putEdges([edge('keep', 'c')]);
          throw new Error('abort');
        }),
        /abort/,
      );
      const after = await adapter.transaction('g', async (tx) => ({
        items: (await tx.listNodes('item', first)).items,
        edges: (await tx.edgesOf('item', 'keep', first)).items,
      }));
      assert.deepEqual(after.items, [item('keep')]);
      assert.deepEqual(after.edges, []);
    },
  },
];

/** Every behaviour an adapter must have, grouped for reporting. Groups are added as the suite grows. */
export function conformanceGroups(): ConformanceGroup[] {
  return [{ name: 'smoke', cases: smokeCases() }, writeGroup(), isolationGroup()];
}
