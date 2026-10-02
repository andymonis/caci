import assert from 'node:assert/strict';
import type { StorageAdapter } from '../adapter.js';
import { query, write } from '../endpoints.js';
import { createGraph, listGraphs } from '../graphs.js';
import type { QueryOutput, SubgraphOutput } from '../types.js';
import { link, mutation, snapshot, upsert, watch } from './helpers.js';
import type { ConformanceCase, ConformanceGroup } from './types.js';

// Reads as a caller sees them: data goes in through `write`, questions go through `query`. Only the
// "store is unchanged" checks look at the adapter's own primitives.

type Raw = Record<string, unknown>;
const pad = (n: number, width = 3): string => String(n).padStart(width, '0');
const q = (graphId: string, extra: Raw = {}) => ({ version: 1, graphId, from: { all: true }, return: { shape: 'nodes' }, ...extra });

async function ask(adapter: StorageAdapter, input: Raw, options?: { limits: Record<string, number> }): Promise<QueryOutput> {
  const r = await query(adapter, input, options);
  assert.ok(r.ok, `the query should have worked, but gave ${r.ok ? '' : `${r.error.code}: ${r.error.message}`}`);
  return r.value;
}
const nodesOf = (out: QueryOutput) => ('nodes' in out ? out.nodes : []);
const idsOf = (out: QueryOutput) => nodesOf(out).map((n) => n.id);
const keysOf = (out: QueryOutput) => nodesOf(out).map((n) => `${n.partition === 'item' ? 'i' : 'c'}:${n.id}`);
const edgeKeys = (out: QueryOutput) => ('edges' in out ? out.edges : []).map((e) => `${e.item}>${e.category}`);
const cursorOf = (out: QueryOutput): string | null => ('nextCursor' in out ? out.nextCursor : null);

/** Follows cursors to the end, failing instead of looping if a cursor never runs out. */
async function everyPage(adapter: StorageAdapter, input: Raw, limit: number): Promise<QueryOutput[]> {
  const pages: QueryOutput[] = [];
  let cursor: string | null = null;
  do {
    assert.ok(pages.length < 2000, 'paging never finished: the cursors do not run out');
    const out = await ask(adapter, { ...input, page: { limit, cursor } });
    pages.push(out);
    cursor = cursorOf(out);
  } while (cursor !== null);
  return pages;
}

const itemIds: readonly string[] = Object.freeze(Array.from({ length: 120 }, (_, i) => `i${pad(i + 1)}`));
const categoryIds: readonly string[] = Object.freeze(['c1', 'c2', 'c3', 'c4', 'c5']);
/** 160 edges: every item to one category, and every third item to a second one with weight 2. */
const bigEdges = () => itemIds.flatMap((id, i) => [{ item: id, category: categoryIds[i % 5] as string, weight: undefined as number | undefined }, ...(i % 3 === 0 ? [{ item: id, category: categoryIds[(i + 1) % 5] as string, weight: 2 }] : [])]);

async function put(adapter: StorageAdapter, graphId: string, ops: unknown[]): Promise<void> {
  const r = await write(adapter, mutation(ops, { graphId, createIfMissing: true }));
  assert.ok(r.ok, `setting up ${graphId} should have worked`);
}

/** Graph `g` (120 items, 5 categories, 160 edges) and graph `h` that reuses some of its ids. */
async function bigGraphs(adapter: StorageAdapter): Promise<void> {
  await put(adapter, 'g', [...itemIds.map((id) => upsert('item', id, { n: id })), ...categoryIds.map((c) => upsert('category', c, { label: c }))]);
  await put(adapter, 'g', bigEdges().map((e) => link(e.item, e.category, e.weight === undefined ? {} : { weight: e.weight })));
  await put(adapter, 'h', [upsert('item', 'i001', { from: 'h' }), upsert('item', 'i002'), upsert('item', 'only-in-h'), upsert('category', 'c1'), upsert('category', 'c2')]);
  await put(adapter, 'h', [link('i001', 'c2'), link('i002', 'c1'), link('only-in-h', 'c1')]);
}

/** Doctor X has four visits that are also appointments; v17 is also under billing; v50 is another doctor's. */
async function clinic(adapter: StorageAdapter): Promise<void> {
  await put(adapter, 'clinic', [
    ...['v14', 'v17', 'v21', 'v30', 'v50', 'shopping'].map((id) => upsert('item', id, { id })),
    ...['doctor-x', 'appointments', 'billing', 'errands'].map((c) => upsert('category', c, { label: c })),
    ...['v14', 'v17', 'v21', 'v30'].map((v) => link(v, 'doctor-x')),
    ...['v14', 'v17', 'v21', 'v30', 'v50'].map((v) => link(v, 'appointments')),
    link('v17', 'billing'),
    link('shopping', 'errands'),
  ]);
}
const fromCat = (id: string, depth: number) => ({ from: { partition: 'category', ids: [id] }, traverse: { depth } });

const paging = (): ConformanceCase[] => [
  {
    name: 'AC-09: 120 matches come back as 3 pages of unique nodes in stable order',
    run: async (adapter) => {
      await bigGraphs(adapter);
      const pages = await everyPage(adapter, q('g', { filter: { partition: 'item' } }), 50);
      assert.deepEqual(pages.map((p) => nodesOf(p).length), [50, 50, 20]);
      assert.deepEqual(pages.flatMap(idsOf), itemIds);
      assert.deepEqual(pages.map(cursorOf).map((c) => c !== null), [true, true, false]);
    },
  },
  {
    name: 'FR-14: items come before categories, and paging crosses from one kind to the other',
    run: async (adapter) => {
      await bigGraphs(adapter);
      const pages = await everyPage(adapter, q('g'), 50);
      assert.deepEqual(pages.map((p) => nodesOf(p).length), [50, 50, 25]);
      assert.deepEqual(pages.flatMap(keysOf), [...itemIds.map((id) => `i:${id}`), ...categoryIds.map((c) => `c:${c}`)]);
    },
  },
  {
    name: 'FR-14: a page that exactly fills the limit ends the listing, and a limit of 1 still walks everything',
    run: async (adapter) => {
      await bigGraphs(adapter);
      const exact = await everyPage(adapter, q('g', { filter: { partition: 'category' } }), 5);
      assert.equal(exact.length, 1);
      assert.equal(cursorOf(exact[0] as QueryOutput), null);
      const single = await everyPage(adapter, q('g', { filter: { partition: 'category' } }), 1);
      assert.deepEqual(single.flatMap(idsOf), categoryIds);
      assert.equal(single.length, 5);
    },
  },
  {
    name: 'FR-14: paging does not skip or repeat nodes that are added or removed between pages',
    run: async (adapter) => {
      await put(adapter, 'g', ['i001', 'i002', 'i003', 'i004', 'i005', 'i006'].map((id) => upsert('item', id)));
      const first = await ask(adapter, q('g', { page: { limit: 3 } }));
      assert.deepEqual(idsOf(first), ['i001', 'i002', 'i003']);
      await put(adapter, 'g', [upsert('item', 'a-before-everything'), upsert('item', 'i003x'), { op: 'deleteNode', partition: 'item', id: 'i004' }]);
      const second = await ask(adapter, q('g', { page: { limit: 3, cursor: cursorOf(first) } }));
      assert.deepEqual(idsOf(second), ['i003x', 'i005', 'i006']);
    },
  },
  {
    name: 'FR-14: nodes are ordered by id as plain text (UTF-16 code units): upper case before lower case, and byte order is not enough',
    run: async (adapter) => {
      // '😀' (outside the basic plane) sorts before '～' (U+FF5E) by UTF-16 code unit but after it by UTF-8 byte,
      // so an adapter that orders by bytes, or by a locale, would get this wrong.
      const ids = ['b', 'B', 'a', 'A', 'ünï', 'a/b', '../x', 'a b', 'i10', 'i9', '😀', '\uFF5E'];
      await put(adapter, 'g', ids.map((id) => upsert('item', id)));
      assert.deepEqual(idsOf(await ask(adapter, q('g', { page: { limit: 100 } }))), [...ids].sort());
    },
  },
  {
    name: 'FR-14: a graph bigger than one read of the adapter pages correctly (1,100 nodes)',
    run: async (adapter) => {
      const ids = Array.from({ length: 1100 }, (_, i) => `n${pad(i, 4)}`);
      await put(adapter, 'g', ids.slice(0, 550).map((id) => upsert('item', id)));
      await put(adapter, 'g', ids.slice(550).map((id) => upsert('item', id)));
      assert.deepEqual(await ask(adapter, q('g', { return: { shape: 'count' } })), { count: 1100, truncated: false });
      const pages = await everyPage(adapter, q('g'), 400);
      assert.deepEqual(pages.map((p) => nodesOf(p).length), [400, 400, 300]);
      assert.deepEqual(pages.flatMap(idsOf), ids);
    },
  },
  {
    name: 'FR-14: a cursor only works for the query that made it',
    run: async (adapter) => {
      await bigGraphs(adapter);
      const first = await ask(adapter, q('g', { filter: { partition: 'item' }, page: { limit: 10 } }));
      const cursor = cursorOf(first);
      assert.notEqual(cursor, null);
      for (const other of [q('g', { filter: { partition: 'category' } }), q('h'), q('g', { return: { shape: 'ids' } })]) {
        const r = await query(adapter, { ...other, page: { limit: 10, cursor } });
        assert.ok(!r.ok);
        assert.deepEqual(r.error.path, ['page', 'cursor']);
      }
      const garbage = await query(adapter, q('g', { page: { cursor: 'not-a-cursor' } }));
      assert.ok(!garbage.ok);
      assert.equal(garbage.error.code, 'VALIDATION_ERROR');
    },
  },
];

const shapes = (): ConformanceCase[] => [
  {
    name: 'FR-20: nodes, ids and count agree, data and weight follow includeData',
    run: async (adapter) => {
      await bigGraphs(adapter);
      assert.deepEqual(await ask(adapter, q('g', { return: { shape: 'count' } })), { count: 125, truncated: false });
      assert.deepEqual(await ask(adapter, q('g', { filter: { partition: 'category' }, return: { shape: 'count' } })), { count: 5, truncated: false });
      const bare = nodesOf(await ask(adapter, q('g', { page: { limit: 1 } })))[0];
      assert.deepEqual(bare, { partition: 'item', id: 'i001' });
      const rich = nodesOf(await ask(adapter, q('g', { return: { shape: 'nodes', includeData: true }, page: { limit: 1 } })))[0];
      assert.deepEqual(rich, { partition: 'item', id: 'i001', data: { n: 'i001' } });
      const ids = await ask(adapter, q('g', { return: { shape: 'ids', includeData: true }, page: { limit: 2 } }));
      assert.deepEqual(ids, { ids: [{ partition: 'item', id: 'i001' }, { partition: 'item', id: 'i002' }], nextCursor: ids && cursorOf(ids), truncated: false });
    },
  },
  {
    name: 'FR-18: named seeds that do not exist are ignored; excludeSeeds and the partition filter narrow the result',
    run: async (adapter) => {
      await clinic(adapter);
      assert.deepEqual(keysOf(await ask(adapter, q('clinic', fromCat('no-such-category', 3)))), []);
      assert.deepEqual(keysOf(await ask(adapter, q('clinic', fromCat('billing', 0)))), ['c:billing']);
      assert.deepEqual(keysOf(await ask(adapter, q('clinic', { ...fromCat('doctor-x', 1), filter: { excludeSeeds: true } }))), ['i:v14', 'i:v17', 'i:v21', 'i:v30']);
      assert.deepEqual(keysOf(await ask(adapter, q('clinic', { ...fromCat('doctor-x', 3), filter: { partition: 'category' } }))), ['c:appointments', 'c:billing', 'c:doctor-x']);
      assert.deepEqual(keysOf(await ask(adapter, q('clinic', { from: { partition: 'category', ids: ['billing', 'no-such', 'doctor-x'] }, traverse: { depth: 0 } }))), ['c:billing', 'c:doctor-x']);
    },
  },
  {
    name: 'FR-19: the result is capped at maxReachedNodes and says so',
    run: async (adapter) => {
      await bigGraphs(adapter);
      assert.deepEqual(await ask(adapter, q('g', { return: { shape: 'count' } }), { limits: { maxReachedNodes: 100 } }), { count: 100, truncated: true });
      const walked = await ask(adapter, q('g', { ...fromCat('c1', 2), return: { shape: 'count' } }), { limits: { maxReachedNodes: 10 } });
      assert.deepEqual(walked, { count: 10, truncated: true });
    },
  },
];

const walks = (): ConformanceCase[] => [
  {
    name: 'AC-17: doctor X at depth 1 as a subgraph is exactly it, its 4 visits and the 4 edges between them',
    run: async (adapter) => {
      await clinic(adapter);
      const out = (await ask(adapter, q('clinic', { ...fromCat('doctor-x', 1), return: { shape: 'subgraph' } }))) as SubgraphOutput;
      assert.deepEqual(keysOf(out), ['i:v14', 'i:v17', 'i:v21', 'i:v30', 'c:doctor-x']);
      assert.deepEqual(edgeKeys(out), ['v14>doctor-x', 'v17>doctor-x', 'v21>doctor-x', 'v30>doctor-x']);
      assert.ok(out.edges.every((e) => e.weight === 1), 'an edge stored without a weight reports 1');
    },
  },
  {
    name: 'AC-17: each depth adds what is one hop further, and only edges with both ends in the result',
    run: async (adapter) => {
      await clinic(adapter);
      const at = async (depth: number) => (await ask(adapter, q('clinic', { ...fromCat('doctor-x', depth), return: { shape: 'subgraph' } }))) as SubgraphOutput;
      assert.deepEqual(keysOf(await at(0)), ['c:doctor-x']);
      assert.deepEqual(keysOf(await at(2)), ['i:v14', 'i:v17', 'i:v21', 'i:v30', 'c:appointments', 'c:billing', 'c:doctor-x']);
      assert.equal((await at(2)).edges.length, 9);
      assert.deepEqual(keysOf(await at(3)).slice(0, 5), ['i:v14', 'i:v17', 'i:v21', 'i:v30', 'i:v50']);
      assert.equal((await at(3)).edges.length, 10);
      assert.ok(!keysOf(await at(3)).includes('i:shopping'), 'the unrelated part of the graph is never reached');
    },
  },
  {
    name: 'FR-18: from an item, depth 2 reaches the items that share a category with it',
    run: async (adapter) => {
      await clinic(adapter);
      const out = await ask(adapter, q('clinic', { from: { partition: 'item', ids: ['v17'] }, traverse: { depth: 2 }, filter: { partition: 'item' } }));
      assert.deepEqual(idsOf(out), ['v14', 'v17', 'v21', 'v30', 'v50']);
    },
  },
  {
    name: 'AC-19: the whole graph as a subgraph returns every node and edge exactly once across pages, and nothing from another graph',
    run: async (adapter) => {
      await bigGraphs(adapter);
      const pages = (await everyPage(adapter, q('g', { return: { shape: 'subgraph' } }), 50)) as SubgraphOutput[];
      assert.deepEqual(pages.flatMap(keysOf), [...itemIds.map((id) => `i:${id}`), ...categoryIds.map((c) => `c:${c}`)]);
      const seen = pages.flatMap(edgeKeys);
      assert.equal(new Set(seen).size, seen.length, 'no edge may appear twice');
      assert.deepEqual([...seen].sort(), bigEdges().map((e) => `${e.item}>${e.category}`).sort());
      assert.ok(!seen.some((e) => e.includes('only-in-h')));
      const weights = pages.flatMap((p) => p.edges.map((e) => e.weight));
      assert.equal(weights.filter((w) => w === 2).length, 40);
      assert.equal(weights.filter((w) => w === 1).length, 120);
    },
  },
  {
    name: 'AC-19: the same edges come back whatever the page size',
    run: async (adapter) => {
      await bigGraphs(adapter);
      const edgesAt = async (limit: number) => (await everyPage(adapter, q('g', { return: { shape: 'subgraph' } }), limit)).flatMap(edgeKeys).sort();
      assert.deepEqual(await edgesAt(7), await edgesAt(1000));
    },
  },
  {
    name: 'FR-01: a query reads only the graph it names, even where another graph reuses the same ids',
    run: async (adapter) => {
      await bigGraphs(adapter);
      const inH = (await ask(adapter, q('h', { return: { shape: 'subgraph', includeData: true }, page: { limit: 100 } }))) as SubgraphOutput;
      assert.deepEqual(keysOf(inH), ['i:i001', 'i:i002', 'i:only-in-h', 'c:c1', 'c:c2']);
      assert.deepEqual(edgeKeys(inH), ['i001>c2', 'i002>c1', 'only-in-h>c1']);
      assert.deepEqual(nodesOf(inH)[0]?.data, { from: 'h' });
      const seeded = await ask(adapter, q('g', { from: { partition: 'item', ids: ['only-in-h'] }, traverse: { depth: 0 } }));
      assert.deepEqual(idsOf(seeded), []);
    },
  },
  {
    name: 'FR-02: a query on a graph that does not exist is GRAPH_NOT_FOUND and creates nothing',
    run: async (adapter) => {
      const r = await query(adapter, q('nowhere'));
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'GRAPH_NOT_FOUND');
      assert.equal(await adapter.graphs.exists('nowhere'), false);
    },
  },
];

const guarantees = (): ConformanceCase[] => [
  {
    name: 'AC-13: the same query on an unchanged store gives deep-equal results, cursors included',
    run: async (adapter) => {
      await bigGraphs(adapter);
      await clinic(adapter);
      const battery: Raw[] = [
        q('g'),
        q('g', { page: { limit: 7 } }),
        q('g', { return: { shape: 'subgraph', includeData: true }, page: { limit: 40 } }),
        q('g', { filter: { partition: 'category' }, return: { shape: 'ids' } }),
        q('g', { return: { shape: 'count' } }),
        q('clinic', { ...fromCat('doctor-x', 3), return: { shape: 'subgraph', includeData: true } }),
        q('h', { return: { shape: 'subgraph' } }),
      ];
      for (const input of battery) assert.deepEqual(await query(adapter, input), await query(adapter, input));
    },
  },
  {
    name: 'AC-21: depth 4 is a VALIDATION_ERROR that never reaches the adapter, and depth 3 works',
    run: async (adapter) => {
      await clinic(adapter);
      const watched = watch(adapter);
      const r = await query(watched.adapter, q('clinic', fromCat('doctor-x', 4)));
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'VALIDATION_ERROR');
      assert.deepEqual(r.error.path, ['traverse', 'depth']);
      assert.deepEqual(watched.touched, [], 'an invalid query must not use the adapter at all');
      assert.ok((await query(adapter, q('clinic', fromCat('doctor-x', 3)))).ok);
    },
  },
  {
    name: 'AC-22: any valid query leaves the store exactly as it was',
    run: async (adapter) => {
      await bigGraphs(adapter);
      await clinic(adapter);
      const dump = async () =>
        JSON.stringify({
          g: await snapshot(adapter, 'g'),
          h: await snapshot(adapter, 'h'),
          clinic: await snapshot(adapter, 'clinic'),
          graphs: await listGraphs(adapter, { limit: 100 }),
        });
      const before = await dump();
      for (const input of [
        q('g'),
        q('g', { return: { shape: 'subgraph', includeData: true }, page: { limit: 33 } }),
        q('clinic', { ...fromCat('doctor-x', 3), return: { shape: 'subgraph' } }),
        q('g', { return: { shape: 'count' } }),
        q('h', { return: { shape: 'ids' } }),
        q('nowhere'),
      ]) {
        await query(adapter, input);
      }
      await everyPage(adapter, q('g', { return: { shape: 'subgraph' } }), 9);
      assert.equal(await dump(), before);
    },
  },
  {
    name: 'FR-21: a query never creates a graph, even one it names',
    run: async (adapter) => {
      await createGraph(adapter, 'empty');
      assert.deepEqual(await ask(adapter, q('empty')), { nodes: [], nextCursor: null, truncated: false });
      await query(adapter, q('not-there'));
      assert.deepEqual((await listGraphs(adapter)).ok && (await listGraphs(adapter)), { ok: true, value: { items: ['empty'], nextCursor: null } });
    },
  },
];

/** What `query` must return, end to end, on any adapter: FR-14, FR-18 to FR-21, AC-09, 13, 17, 19, 21, 22. */
export function readsGroup(): ConformanceGroup {
  return { name: 'reads', cases: [...paging(), ...shapes(), ...walks(), ...guarantees()] };
}
