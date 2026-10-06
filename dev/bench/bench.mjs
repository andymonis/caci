// Builds the benchmark graph through the real `write` and times the operations NFR-05 cares about.
// Everything it needs is passed in, so it is tested with a tiny graph and a fake clock.
import { generate, seededRandom } from './dataset.mjs';
import { summarise } from './stats.mjs';

export const GRAPH_ID = 'bench';
/** NFR-05: single-category lookup under 20 ms (p95). */
export const LOOKUP_TARGET_MS = 20;
const NODE_BATCH = 500;
const LINK_BATCH = 1000;

const mutation = (ops) => ({ version: 1, kind: 'mutation', graphId: GRAPH_ID, ops });
const nodeOp = (partition, id, data) => ({ op: 'upsertNode', partition, id, mode: 'replace', data });

async function must(promise, what) {
  const result = await promise;
  if (!result.ok) throw new Error(`${what} failed: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** Writes the generated graph in batches under the operation limit; returns how long it took. */
export async function build(lib, adapter, graph, now) {
  const started = now();
  await must(lib.createGraph(adapter, GRAPH_ID), 'createGraph');
  const nodes = [
    ...graph.categories.map((id) => nodeOp('category', id, { name: id })),
    ...graph.items.map((id) => nodeOp('item', id, { title: `Item ${id}`, summary: 'benchmark' })),
  ];
  for (let i = 0; i < nodes.length; i += NODE_BATCH) await must(lib.write(adapter, mutation(nodes.slice(i, i + NODE_BATCH))), 'write nodes');
  for (let i = 0; i < graph.edges.length; i += LINK_BATCH) {
    const ops = graph.edges.slice(i, i + LINK_BATCH).map((e) => ({ op: 'link', item: e.item, category: e.category, weight: 0.5 }));
    await must(lib.write(adapter, mutation(ops)), 'write links');
  }
  return now() - started;
}

const pageQuery = (seed, extra) => ({ version: 1, graphId: GRAPH_ID, ...seed, return: { shape: 'nodes' }, ...extra });

/** The operations to time. Each has a name, what it is, how many samples, and a function that does one sample. */
function plan(lib, adapter, graph, size, random, samples) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const linkedCategories = [...new Set(graph.edges.map((e) => e.category))];
  const linkedItems = [...new Set(graph.edges.map((e) => e.item))];
  const limit = size.pageSize;
  let counter = 0;
  const hub = graph.categories[0];

  return [
    {
      name: 'category-items',
      what: `the items of one category (a page of ${limit})`,
      target: LOOKUP_TARGET_MS,
      samples,
      prepare: async () => undefined,
      sample: async () =>
        must(lib.query(adapter, pageQuery({ from: { partition: 'category', ids: [pick(linkedCategories)] }, traverse: { depth: 1 }, filter: { partition: 'item' } }, { page: { limit } })), 'query'),
    },
    {
      name: 'item-categories',
      what: 'the categories of one item',
      samples,
      prepare: async () => undefined,
      sample: async () =>
        must(lib.query(adapter, pageQuery({ from: { partition: 'item', ids: [pick(linkedItems)] }, traverse: { depth: 1 }, filter: { partition: 'category' } }, { page: { limit } })), 'query'),
    },
    {
      name: 'describe-graph',
      what: 'describeGraph (counts by walking the graph)',
      samples: Math.min(samples, 10),
      prepare: async () => undefined,
      sample: async () => must(lib.describeGraph(adapter, GRAPH_ID), 'describeGraph'),
    },
    {
      name: 'first-page-of-hub',
      what: `the first page (${limit}) of the biggest category (${size.hubItems} items)`,
      samples,
      prepare: async () => undefined,
      sample: async () => must(lib.query(adapter, pageQuery({ from: { partition: 'category', ids: [hub] }, traverse: { depth: 1 }, filter: { partition: 'item' } }, { page: { limit } })), 'query'),
    },
    {
      name: 'deep-page',
      what: `page ${size.deepPage} of the biggest category (shows the cost of reaching a cursor)`,
      samples: Math.min(samples, 20),
      prepare: async () => {
        let cursor = null;
        for (let n = 1; n < size.deepPage; n++) {
          const out = await must(lib.query(adapter, pageQuery({ from: { partition: 'category', ids: [hub] }, traverse: { depth: 1 }, filter: { partition: 'item' } }, { page: { limit, cursor } })), 'query');
          cursor = out.nextCursor;
          if (cursor === null) throw new Error(`the biggest category has fewer than ${size.deepPage} pages`);
        }
        return cursor;
      },
      sample: async (cursor) =>
        must(lib.query(adapter, pageQuery({ from: { partition: 'category', ids: [hub] }, traverse: { depth: 1 }, filter: { partition: 'item' } }, { page: { limit, cursor } })), 'query'),
    },
    {
      name: 'write-1',
      what: 'one write of a single operation',
      samples,
      prepare: async () => undefined,
      sample: async () => must(lib.write(adapter, mutation([nodeOp('item', `w1-${counter++}`, { title: 'single' })])), 'write'),
    },
    {
      name: 'write-1000',
      what: 'one write of 1,000 operations (500 new items, each linked to a category)',
      samples: Math.min(samples, 5),
      prepare: async () => undefined,
      sample: async () => {
        const base = counter++;
        const ops = [];
        for (let i = 0; i < 500; i++) {
          const id = `w1000-${base}-${i}`;
          ops.push(nodeOp('item', id, { title: 'bulk' }), { op: 'link', item: id, category: pick(linkedCategories), weight: 0.5 });
        }
        return must(lib.write(adapter, mutation(ops)), 'write');
      },
    },
  ];
}

/**
 * @param io.lib         { createGraph, write, query, describeGraph }
 * @param io.makeAdapter async () => { adapter, dispose }
 * @param io.size        one of the sizes in dataset.mjs
 * @param io.now         a clock in milliseconds (fractions allowed)
 * @param io.progress    (text) => void
 */
export async function runBench({ lib, makeAdapter, size, seed, samples, now = () => performance.now(), progress = () => {} }) {
  const graph = generate(size, seed);
  const random = seededRandom(seed ^ 0x9e3779b9);
  const { adapter, dispose } = await makeAdapter();
  try {
    progress(`  building ${graph.items.length} items, ${graph.categories.length} categories, ${graph.edges.length} edges on ${adapter.name}...\n`);
    const buildMs = await build(lib, adapter, graph, now);
    const results = [];
    for (const op of plan(lib, adapter, graph, size, random, samples)) {
      progress(`  ${op.name}\n`);
      const prepared = await op.prepare();
      const times = [];
      for (let i = 0; i < op.samples; i++) {
        const t0 = now();
        await op.sample(prepared);
        times.push(now() - t0);
      }
      results.push({ name: op.name, what: op.what, ...(op.target === undefined ? {} : { targetMs: op.target }), stats: summarise(times) });
    }
    return { adapter: adapter.name, seed, size, items: graph.items.length, categories: graph.categories.length, edges: graph.edges.length, buildMs, results };
  } finally {
    await dispose();
  }
}
