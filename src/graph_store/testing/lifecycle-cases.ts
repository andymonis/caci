import assert from 'node:assert/strict';
import type { StorageAdapter } from '../adapter.js';
import { write } from '../endpoints.js';
import { createGraph, describeGraph, dropGraph, listGraphs } from '../graphs.js';
import { link, mutation, snapshot, upsert, walk } from './helpers.js';
import type { ConformanceCase, ConformanceGroup } from './types.js';

const pad = (n: number, width = 3): string => String(n).padStart(width, '0');
const info = (graphId: string, itemCount: number, categoryCount: number, edgeCount: number) => ({
  ok: true,
  value: { graphId, itemCount, categoryCount, edgeCount },
});

/** Three items, two categories, three edges. */
const populate = (graphId: string) =>
  mutation(
    [
      upsert('item', 'i1'),
      upsert('item', 'i2'),
      upsert('item', 'i3'),
      upsert('category', 'c1'),
      upsert('category', 'c2'),
      link('i1', 'c1'),
      link('i2', 'c1'),
      link('i1', 'c2'),
    ],
    { graphId, createIfMissing: true },
  );

/** Reads every graph id by following cursors, and how many pages that took. */
async function allGraphIds(adapter: StorageAdapter, limit: number): Promise<{ ids: string[]; pages: number }> {
  const { items, pages } = await walk(async (page) => {
    const result = await listGraphs(adapter, page);
    assert.ok(result.ok);
    return result.value;
  }, limit);
  return { ids: items, pages };
}

/** The edges of what a graph id may be: shortest, longest, digits only, every allowed symbol. */
const legalGraphIds = (): string[] => ['a', '0', '42', 'a-b_c-9', 'user_42', 'x'.repeat(128)];

/** Node ids are opaque, so adapters must store anything: separators, dots, spaces, non-ASCII, case. */
const awkwardNodeIds = (): string[] => [
  'a/b',
  '../escape',
  'with space',
  'ünï côdé',
  'trailing ',
  'dots..',
  '.hidden',
  'back\\slash',
  'UPPER',
  'upper',
  'x'.repeat(256),
];

const creating = (): ConformanceCase[] => [
  {
    name: 'FR-01: createGraph makes an empty graph that is listed',
    run: async (adapter) => {
      assert.deepEqual(await createGraph(adapter, 'g'), { ok: true, value: { graphId: 'g' } });
      assert.equal(await adapter.graphs.exists('g'), true);
      assert.deepEqual(await listGraphs(adapter), { ok: true, value: { items: ['g'], nextCursor: null } });
      const s = await snapshot(adapter);
      assert.deepEqual([s.items, s.categories, s.edgesFromItems, s.edgesFromCategories], [[], [], [], []]);
    },
  },
  {
    name: 'FR-01: createGraph on an existing graph is a CONFLICT and keeps its data',
    run: async (adapter) => {
      await write(adapter, populate('g'));
      const r = await createGraph(adapter, 'g');
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'CONFLICT');
      assert.deepEqual(r.error.path, ['graphId']);
      assert.deepEqual(await describeGraph(adapter, 'g'), info('g', 3, 2, 3));
    },
  },
  {
    name: 'FR-01: the adapter\'s graphs.create and graphs.drop are idempotent',
    run: async (adapter) => {
      await adapter.graphs.create('g');
      await write(adapter, populate('g'));
      await adapter.graphs.create('g'); // creating again must not wipe or throw
      assert.deepEqual(await describeGraph(adapter, 'g'), info('g', 3, 2, 3));
      await adapter.graphs.drop('g');
      await adapter.graphs.drop('g'); // dropping again must not throw
      await adapter.graphs.drop('never-existed');
      assert.equal(await adapter.graphs.exists('g'), false);
    },
  },
];

const dropping = (): ConformanceCase[] => [
  {
    name: 'FR-01: dropGraph removes all nodes and edges, so a recreated graph is empty',
    run: async (adapter) => {
      await write(adapter, populate('g'));
      assert.deepEqual(await dropGraph(adapter, 'g'), { ok: true, value: { graphId: 'g' } });
      assert.equal(await adapter.graphs.exists('g'), false);
      assert.deepEqual(await listGraphs(adapter), { ok: true, value: { items: [], nextCursor: null } });
      await createGraph(adapter, 'g');
      const s = await snapshot(adapter);
      assert.deepEqual([s.items, s.categories, s.edgesFromItems, s.edgesFromCategories], [[], [], [], []]);
      assert.deepEqual(await describeGraph(adapter, 'g'), info('g', 0, 0, 0));
    },
  },
  {
    name: 'FR-01: dropGraph on a missing graph is GRAPH_NOT_FOUND and leaves other graphs alone',
    run: async (adapter) => {
      await write(adapter, populate('keep'));
      const r = await dropGraph(adapter, 'missing');
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'GRAPH_NOT_FOUND');
      assert.deepEqual(await describeGraph(adapter, 'keep'), info('keep', 3, 2, 3));
    },
  },
];

const listing = (): ConformanceCase[] => [
  {
    name: 'FR-01: listGraphs pages 120 graphs as 3 pages of unique ids in stable order',
    run: async (adapter) => {
      const expected = Array.from({ length: 120 }, (_, i) => `graph-${pad(i)}`);
      for (const id of [...expected].reverse()) assert.equal((await createGraph(adapter, id)).ok, true);
      const first = await allGraphIds(adapter, 50);
      assert.equal(first.pages, 3);
      assert.deepEqual(first.ids, expected);
      assert.deepEqual((await allGraphIds(adapter, 50)).ids, expected, 'a second walk gives the same order');
      assert.deepEqual((await allGraphIds(adapter, 1000)).pages, 1);
    },
  },
  {
    name: 'FR-01: listGraphs defaults to 50 per page',
    run: async (adapter) => {
      for (let i = 0; i < 60; i++) await createGraph(adapter, `g${pad(i)}`);
      const r = await listGraphs(adapter);
      assert.ok(r.ok);
      assert.equal(r.value.items.length, 50);
      assert.notEqual(r.value.nextCursor, null);
    },
  },
  {
    name: 'FR-01: listGraphs does not skip or repeat graphs added between pages',
    run: async (adapter) => {
      for (const id of ['b', 'd', 'f']) await createGraph(adapter, id);
      const p1 = await listGraphs(adapter, { limit: 2 });
      assert.ok(p1.ok);
      for (const id of ['a', 'c', 'e']) await createGraph(adapter, id);
      const p2 = await listGraphs(adapter, { limit: 10, cursor: p1.value.nextCursor });
      assert.deepEqual(p1.value.items, ['b', 'd']);
      assert.deepEqual(p2, { ok: true, value: { items: ['e', 'f'], nextCursor: null } });
    },
  },
  {
    name: 'FR-01: listGraphs stops listing a graph once it is dropped',
    run: async (adapter) => {
      for (const id of ['a', 'b', 'c']) await createGraph(adapter, id);
      await dropGraph(adapter, 'b');
      assert.deepEqual((await allGraphIds(adapter, 2)).ids, ['a', 'c']);
    },
  },
];

const describing = (): ConformanceCase[] => [
  {
    name: 'FR-01: describeGraph counts follow writes, unlinks and cascade deletes',
    run: async (adapter) => {
      await createGraph(adapter, 'g');
      assert.deepEqual(await describeGraph(adapter, 'g'), info('g', 0, 0, 0));
      await write(adapter, populate('g'));
      assert.deepEqual(await describeGraph(adapter, 'g'), info('g', 3, 2, 3));
      await write(adapter, mutation([{ op: 'unlink', item: 'i1', category: 'c2' }]));
      assert.deepEqual(await describeGraph(adapter, 'g'), info('g', 3, 2, 2));
      await write(adapter, mutation([{ op: 'deleteNode', partition: 'category', id: 'c1' }])); // takes 2 edges with it
      assert.deepEqual(await describeGraph(adapter, 'g'), info('g', 3, 1, 0));
      await write(adapter, mutation([{ op: 'deleteNode', partition: 'item', id: 'i3' }]));
      assert.deepEqual(await describeGraph(adapter, 'g'), info('g', 2, 1, 0));
    },
  },
  {
    name: 'FR-01: describeGraph counts correctly across page boundaries (1100 items, 1150 edges)',
    run: async (adapter) => {
      await createGraph(adapter, 'big');
      await adapter.transaction('big', async (tx) => {
        const items = Array.from({ length: 1100 }, (_, i) => `i${pad(i, 4)}`);
        await tx.putNodes([
          ...items.map((id) => ({ partition: 'item' as const, id })),
          { partition: 'category', id: 'c' },
          { partition: 'category', id: 'd' },
        ]);
        await tx.putEdges([
          ...items.map((item) => ({ item, category: 'c' })),
          ...items.slice(0, 50).map((item) => ({ item, category: 'd' })),
        ]);
      });
      assert.deepEqual(await describeGraph(adapter, 'big'), info('big', 1100, 2, 1150));
    },
  },
  {
    name: 'FR-01: describeGraph on a missing graph is GRAPH_NOT_FOUND',
    run: async (adapter) => {
      const r = await describeGraph(adapter, 'missing');
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'GRAPH_NOT_FOUND');
    },
  },
];

const identifiers = (): ConformanceCase[] => [
  {
    name: 'FR-01: every allowed graph id works end to end, from one character to the 128-character maximum',
    run: async (adapter) => {
      const ids = legalGraphIds();
      for (const id of ids) {
        const r = await write(adapter, mutation([upsert('item', 'n', { id })], { graphId: id, createIfMissing: true }));
        assert.equal(r.ok, true, `writing to graph ${id.slice(0, 20)}`);
      }
      assert.deepEqual((await allGraphIds(adapter, 1000)).ids.sort(), [...ids].sort());
      for (const id of ids) {
        assert.deepEqual((await snapshot(adapter, id)).items, [{ partition: 'item', id: 'n', data: { id } }]);
        assert.equal((await dropGraph(adapter, id)).ok, true);
      }
      assert.deepEqual((await allGraphIds(adapter, 1000)).ids, []);
    },
  },
  {
    name: 'FR-01: node ids with awkward characters round-trip unchanged, and ids differing by case stay distinct',
    run: async (adapter) => {
      const ids = awkwardNodeIds();
      const ops = ids.flatMap((id) => [upsert('item', id, { id }), upsert('category', id), link(id, id)]);
      assert.equal((await write(adapter, mutation(ops, { createIfMissing: true }))).ok, true);
      const s = await snapshot(adapter);
      assert.deepEqual(s.items.map((n) => n.id).sort(), [...ids].sort());
      assert.deepEqual(s.categories.map((n) => n.id).sort(), [...ids].sort());
      assert.deepEqual(s.items.find((n) => n.id === 'ünï côdé')?.data, { id: 'ünï côdé' });
      assert.equal(s.edgesFromItems.length, ids.length);
      assert.deepEqual(s.edgesFromItems, s.edgesFromCategories);
      assert.deepEqual(await describeGraph(adapter, 'g'), info('g', ids.length, ids.length, ids.length));
    },
  },
];

/** Graph lifecycle every adapter must support: create, drop, list, describe (FR-01). */
export function lifecycleGroup(): ConformanceGroup {
  return { name: 'lifecycle', cases: [...creating(), ...dropping(), ...listing(), ...describing(), ...identifiers()] };
}
