import assert from 'node:assert/strict';
import { createGraphClient, write } from '../endpoints.js';
import { describeGraph, dropGraph, listGraphs } from '../graphs.js';
import { link, mutation, snapshot, upsert } from './helpers.js';
import type { ConformanceCase, ConformanceGroup } from './types.js';

/** The same three node ids in a graph, with `tag` so graphs can be told apart. */
const sameIds = (graphId: string, tag: string, extraOps: unknown[] = []) =>
  mutation(
    [upsert('item', 'note', { tag }), upsert('category', 'topic', { tag }), upsert('item', 'other', { tag }), ...extraOps],
    { graphId, createIfMissing: true },
  );

const both = async (adapter: Parameters<ConformanceCase['run']>[0], withLink: boolean): Promise<void> => {
  const ops = withLink ? [link('note', 'topic', { weight: 1 })] : [];
  assert.equal((await write(adapter, sameIds('graph-a', 'a', ops))).ok, true);
  assert.equal((await write(adapter, sameIds('graph-b', 'b', ops))).ok, true);
};

const ac01 = (): ConformanceCase[] => [
  {
    name: 'AC-01: linking in graph A is invisible in graph B, even with identical node ids',
    run: async (adapter) => {
      await both(adapter, false);
      await write(adapter, mutation([link('note', 'topic', { weight: 1 })], { graphId: 'graph-a' }));
      const [a, b] = [await snapshot(adapter, 'graph-a'), await snapshot(adapter, 'graph-b')];
      assert.deepEqual(a.edgesFromItems, [{ item: 'note', category: 'topic', weight: 1 }]);
      assert.deepEqual(b.edgesFromItems, []);
      assert.deepEqual(b.edgesFromCategories, []);
      assert.deepEqual(b.items.map((n) => n.data), [{ tag: 'b' }, { tag: 'b' }]);
      assert.deepEqual(b.categories.map((n) => n.data), [{ tag: 'b' }]);
    },
  },
  {
    name: 'AC-01: writing to one graph does not change what another graph holds',
    run: async (adapter) => {
      await both(adapter, true);
      const before = await describeGraph(adapter, 'graph-b');
      await write(adapter, mutation([upsert('item', 'extra'), upsert('category', 'more'), link('extra', 'more')], { graphId: 'graph-a' }));
      await write(adapter, mutation([{ op: 'unlink', item: 'note', category: 'topic' }], { graphId: 'graph-a' }));
      assert.deepEqual(await describeGraph(adapter, 'graph-b'), before);
      assert.deepEqual(before, { ok: true, value: { graphId: 'graph-b', itemCount: 2, categoryCount: 1, edgeCount: 1 } });
    },
  },
  {
    name: 'AC-01: deleting a node in graph A (with its edges) leaves the same-id node and edges in B',
    run: async (adapter) => {
      await both(adapter, true);
      await write(adapter, mutation([{ op: 'deleteNode', partition: 'category', id: 'topic' }], { graphId: 'graph-a' }));
      const [a, b] = [await snapshot(adapter, 'graph-a'), await snapshot(adapter, 'graph-b')];
      assert.deepEqual(a.categories, []);
      assert.deepEqual(a.edgesFromItems, []);
      assert.deepEqual(b.categories.map((n) => n.id), ['topic']);
      assert.deepEqual(b.edgesFromItems, [{ item: 'note', category: 'topic', weight: 1 }]);
      assert.deepEqual(b.edgesFromCategories, [{ item: 'note', category: 'topic', weight: 1 }]);
    },
  },
  {
    name: 'AC-01: dropping graph A leaves graph B intact',
    run: async (adapter) => {
      await both(adapter, true);
      assert.equal((await dropGraph(adapter, 'graph-a')).ok, true);
      assert.deepEqual(await listGraphs(adapter), { ok: true, value: { items: ['graph-b'], nextCursor: null } });
      const b = await snapshot(adapter, 'graph-b');
      assert.deepEqual(b.edgesFromItems, [{ item: 'note', category: 'topic', weight: 1 }]);
      assert.deepEqual(b.items.map((n) => n.data), [{ tag: 'b' }, { tag: 'b' }]);
    },
  },
  {
    name: 'AC-01: a failed mutation in graph A leaves graph B untouched',
    run: async (adapter) => {
      await both(adapter, true);
      const before = await snapshot(adapter, 'graph-b');
      const r = await write(adapter, mutation([upsert('item', 'note', { tag: 'changed' }), link('note', 'missing')], { graphId: 'graph-a' }));
      assert.equal(r.ok, false);
      assert.deepEqual(await snapshot(adapter, 'graph-b'), before);
    },
  },
];

const ac12 = (): ConformanceCase[] => [
  {
    name: 'AC-12: two adapters from the same factory share no data',
    run: async (adapter, makeAnother) => {
      const second = await makeAnother();
      await write(adapter, sameIds('g', 'first'));
      assert.equal(await second.graphs.exists('g'), false);
      assert.deepEqual((await second.graphs.list({ limit: 10, cursor: null })).items, []);

      await write(second, sameIds('g', 'second'));
      assert.deepEqual((await snapshot(adapter, 'g')).items.map((n) => n.data), [{ tag: 'first' }, { tag: 'first' }]);
      assert.deepEqual((await snapshot(second, 'g')).items.map((n) => n.data), [{ tag: 'second' }, { tag: 'second' }]);

      await dropGraph(second, 'g');
      assert.equal(await adapter.graphs.exists('g'), true);
      assert.equal((await snapshot(adapter, 'g')).items.length, 2);
    },
  },
  {
    name: 'AC-12: two clients on different adapters see only their own graphs',
    run: async (adapter, makeAnother) => {
      const [one, two] = [createGraphClient(adapter), createGraphClient(await makeAnother())];
      assert.equal((await one.createGraph('shared-name')).ok, true);
      assert.equal((await one.createGraph('only-in-one')).ok, true);
      assert.deepEqual(await two.listGraphs(), { ok: true, value: { items: [], nextCursor: null } });
      assert.equal((await two.createGraph('shared-name')).ok, true, 'the same id is free in the other adapter');
      assert.equal((await two.describeGraph('only-in-one')).ok, false);
      assert.deepEqual(await one.listGraphs(), { ok: true, value: { items: ['only-in-one', 'shared-name'], nextCursor: null } });
    },
  },
];

/** Graphs and adapters never leak into each other: AC-01 and AC-12. */
export function isolationGroup(): ConformanceGroup {
  return { name: 'isolation', cases: [...ac01(), ...ac12()] };
}
