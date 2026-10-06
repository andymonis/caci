import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../../src/graph_store/adapters/memory/index.ts';
import { createSqliteAdapter } from '../../src/graph_store/adapters/sqlite/index.ts';
import * as graph from '../../src/graph_store/index.ts';
import { GRAPH_ID, LOOKUP_TARGET_MS, runBench } from './bench.mjs';
import { main, parseArgs } from './cli.mjs';
import { FULL, SIZES, SMOKE, generate, seededRandom } from './dataset.mjs';
import { formatReport, overTarget } from './report.mjs';
import { percentile, summarise } from './stats.mjs';

const lib = { createGraph: graph.createGraph, write: graph.write, query: graph.query, describeGraph: graph.describeGraph };
const adapters = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close?.();
});
const makeAdapter = async (name = 'memory') => {
  const adapter = name === 'sqlite' ? createSqliteAdapter() : createMemoryAdapter();
  adapters.push(adapter);
  return { adapter, dispose: async () => {} };
};

describe('the generated graph', () => {
  it('is the NFR-05 size at full scale, exactly', () => {
    const g = generate(FULL, 1);
    expect([g.items.length, g.categories.length, g.edges.length]).toEqual([10_000, 1_000, 100_000]);
  });

  it('is the same for the same seed and different for another', () => {
    expect(generate(SMOKE, 7)).toEqual(generate(SMOKE, 7));
    expect(generate(SMOKE, 7).edges).not.toEqual(generate(SMOKE, 8).edges);
  });

  it('has no repeated edge and every end exists', () => {
    const g = generate(SMOKE, 3);
    const keys = g.edges.map((e) => `${e.item}|${e.category}`);
    expect(new Set(keys).size).toBe(keys.length);
    const items = new Set(g.items);
    const categories = new Set(g.categories);
    for (const e of g.edges) {
      expect(items.has(e.item)).toBe(true);
      expect(categories.has(e.category)).toBe(true);
    }
  });

  it('links the first hubItems items to the first category, exactly', () => {
    const g = generate(SMOKE, 1);
    const linked = new Set(g.edges.filter((e) => e.category === g.categories[0]).map((e) => e.item));
    for (const item of g.items.slice(0, SMOKE.hubItems)) expect(linked.has(item), item).toBe(true);
  });

  it('is skewed: the second-biggest category is several times the middle one', () => {
    const g = generate(SMOKE, 1);
    const counts = new Map();
    for (const e of g.edges) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    const rest = g.categories.slice(1).map((c) => counts.get(c) ?? 0);
    const median = [...rest].sort((a, b) => a - b)[Math.floor(rest.length / 2)];
    expect(counts.get(g.categories[1])).toBeGreaterThan(median * 3);
  });

  it('refuses sizes that cannot exist', () => {
    expect(() => generate({ ...SMOKE, hubItems: SMOKE.items + 1 }, 1)).toThrow(RangeError);
    expect(() => generate({ items: 2, categories: 2, edges: 5, hubItems: 1 }, 1)).toThrow(RangeError);
  });

  it('the random generator is repeatable and stays in [0, 1)', () => {
    const a = seededRandom(5);
    const b = seededRandom(5);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('statistics', () => {
  it('uses nearest-rank percentiles', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });

  it('summarises without changing the input order', () => {
    const input = [5, 1, 9, 3];
    expect(summarise(input)).toEqual({ n: 4, min: 1, p50: 3, p95: 9, max: 9 });
    expect(input).toEqual([5, 1, 9, 3]);
  });
});

describe('running the benchmark on a tiny graph (the gate runs only this, to check the plumbing)', () => {
  for (const name of ['memory', 'sqlite']) {
    it(`builds the whole graph through write and measures every operation on ${name}`, async () => {
      let t = 0;
      const run = await runBench({ lib, makeAdapter: () => makeAdapter(name), size: SMOKE, seed: 1, samples: 3, now: () => (t += 1) });
      expect([run.items, run.categories, run.edges]).toEqual([300, 30, 1200]);
      expect(run.results.map((r) => r.name)).toEqual(['category-items', 'item-categories', 'describe-graph', 'first-page-of-hub', 'deep-page', 'write-1', 'write-1000']);
      for (const r of run.results) expect(r.stats.n).toBeGreaterThan(0);
      expect(run.results.find((r) => r.name === 'category-items').targetMs).toBe(LOOKUP_TARGET_MS);
      expect(run.results.filter((r) => r.targetMs !== undefined)).toHaveLength(1);
    });
  }

  it('builds a graph larger than one batch of nodes and of links', async () => {
    const size = { items: 900, categories: 30, edges: 2500, hubItems: 100, pageSize: 5, deepPage: 10 };
    let adapter;
    await runBench({ lib, makeAdapter: async () => ((adapter = (await makeAdapter('sqlite')).adapter), { adapter, dispose: async () => {} }), size, seed: 2, samples: 1, now: () => 0 });
    const info = await graph.describeGraph(adapter, GRAPH_ID);
    expect(info.value.categoryCount).toBe(30);
    expect(info.value.itemCount).toBeGreaterThanOrEqual(900);
    expect(info.value.edgeCount).toBeGreaterThanOrEqual(2500);
  });

  it('takes fewer samples of the slow operations than it was asked for', async () => {
    const run = await runBench({ lib, makeAdapter, size: SMOKE, seed: 1, samples: 40, now: () => 0 });
    const n = Object.fromEntries(run.results.map((r) => [r.name, r.stats.n]));
    expect(n).toEqual({ 'category-items': 40, 'item-categories': 40, 'describe-graph': 10, 'first-page-of-hub': 40, 'deep-page': 20, 'write-1': 40, 'write-1000': 5 });
  });

  it('builds exactly the generated graph (counts match what was asked for)', async () => {
    let adapter;
    await runBench({ lib, makeAdapter: async () => ((adapter = (await makeAdapter('sqlite')).adapter), { adapter, dispose: async () => {} }), size: SMOKE, seed: 1, samples: 1, now: () => 0 });
    const info = await graph.describeGraph(adapter, GRAPH_ID);
    // the timed writes add items too, so the build's counts are a floor
    expect(info.value.categoryCount).toBe(30);
    expect(info.value.itemCount).toBeGreaterThanOrEqual(300);
    expect(info.value.edgeCount).toBeGreaterThanOrEqual(1200);
  });

  it('times with the clock it is given, one reading before and one after each sample', async () => {
    const readings = [];
    let t = 0;
    const run = await runBench({ lib, makeAdapter, size: SMOKE, seed: 1, samples: 2, now: () => { readings.push(t); return (t += 10); } });
    for (const r of run.results) expect([r.stats.min, r.stats.max]).toEqual([10, 10]); // every sample took exactly one tick of 10
    expect(readings.length).toBeGreaterThan(14);
  });

  it('measures the deep page after really walking to it, and fails clearly when the category is too small', async () => {
    await expect(runBench({ lib, makeAdapter, size: { ...SMOKE, deepPage: 500 }, seed: 1, samples: 1, now: () => 0 })).rejects.toThrow(/fewer than 500 pages/);
  });

  it('disposes the adapter even when the run fails', async () => {
    let disposed = 0;
    await expect(runBench({ lib, makeAdapter: async () => ({ adapter: createMemoryAdapter(), dispose: async () => { disposed++; } }), size: { ...SMOKE, deepPage: 500 }, seed: 1, samples: 1, now: () => 0 })).rejects.toThrow();
    expect(disposed).toBe(1);
  });

  it('stops with a clear message when a write is refused', async () => {
    const broken = { ...lib, write: async () => ({ ok: false, error: { code: 'STORAGE_ERROR', message: 'disk full' } }) };
    await expect(runBench({ lib: broken, makeAdapter, size: SMOKE, seed: 1, samples: 1, now: () => 0 })).rejects.toThrow(/write nodes failed: STORAGE_ERROR: disk full/);
  });
});

describe('the report', () => {
  const run = (adapter, p95) => ({ adapter, seed: 1, items: 1, categories: 1, edges: 1, buildMs: 1500, results: [{ name: 'category-items', what: 'x', targetMs: 20, stats: { n: 3, min: 1, p50: 2, p95, max: p95 } }, { name: 'write-1', what: 'y', stats: { n: 3, min: 1, p50: 2, p95: 3, max: 3 } }] });

  it('shows the table, the target and a verdict', () => {
    const text = formatReport([run('sqlite', 5)], { nodeVersion: 'v22' });
    expect(text).toContain('sqlite: 1 items');
    expect(text).toContain('category-items');
    expect(text).toContain('< 20');
    expect(text).toMatch(/category-items.*ok$/m);
    expect(text).toContain('Node v22');
  });

  it('says OVER TARGET when the 95th percentile is at or over it', () => {
    expect(formatReport([run('sqlite', 25)])).toMatch(/OVER TARGET/);
    expect(formatReport([run('sqlite', 20)])).toMatch(/OVER TARGET/);
    expect(overTarget([run('sqlite', 25), run('memory', 1)])).toEqual(['sqlite: category-items p95 25.0 ms, target 20 ms']);
    expect(overTarget([run('sqlite', 5)])).toEqual([]);
  });
});

describe('the command', () => {
  const io = (argv, extra = {}) => {
    const out = [];
    const err = [];
    return { out, err, io: { argv, lib, stdout: (t) => out.push(t), stderr: (t) => err.push(t), makeAdapter: (name) => makeAdapter(name), now: () => 0, nodeVersion: 'v22', save: async (r) => { (io.saved ??= []).push(r); return 'bench-results/x.json'; }, ...extra } };
  };

  it('parses the options and refuses bad ones with the usage', () => {
    expect(parseArgs([])).toMatchObject({ size: 'full', adapters: ['sqlite', 'memory'], samples: 30, seed: 1, save: true });
    expect(parseArgs(['--size', 'smoke', '--adapters', 'sqlite', '--samples', '3', '--seed', '9', '--no-save'])).toMatchObject({ size: 'smoke', adapters: ['sqlite'], samples: 3, seed: 9, save: false });
    for (const bad of [['--size', 'huge'], ['--adapters', 'oracle'], ['--samples', '0'], ['--samples', 'x'], ['--seed', '-1'], ['--size'], ['--nope']]) expect(() => parseArgs(bad), bad.join(' ')).toThrow();
  });

  it('runs the chosen adapters, prints the report and saves it', async () => {
    const t = io(['--size', 'smoke', '--adapters', 'memory,sqlite', '--samples', '2']);
    expect(await main(t.io)).toBe(0);
    const text = t.out.join('');
    expect(text).toMatch(/memory: 300 items/);
    expect(text).toMatch(/sqlite: 300 items/);
    expect(text).toContain('Saved bench-results/x.json');
  });

  it('lists only the real adapter under "over target": the memory reference is never a finding', async () => {
    let t = 0;
    const slow = io(['--size', 'smoke', '--adapters', 'memory,sqlite', '--samples', '1', '--no-save'], { now: () => (t += 25) });
    expect(await main(slow.io)).toBe(0);
    const text = slow.out.join('');
    const findings = text.slice(text.indexOf('Over target'));
    expect(findings).toContain('sqlite: category-items');
    expect(findings).not.toContain('memory: category-items');
  });

  it('--no-save saves nothing; --help prints the usage; a bad option exits 2', async () => {
    const quiet = io(['--size', 'smoke', '--adapters', 'memory', '--samples', '1', '--no-save']);
    expect(await main(quiet.io)).toBe(0);
    expect(quiet.out.join('')).not.toContain('Saved');
    const help = io(['--help']);
    expect(await main(help.io)).toBe(0);
    expect(help.out.join('')).toContain('Usage');
    const bad = io(['--size', 'huge']);
    expect(await main(bad.io)).toBe(2);
    expect(bad.err.join('')).toContain('--size must be full or smoke');
  });

  it('knows the two sizes', () => {
    expect(Object.keys(SIZES)).toEqual(['full', 'smoke']);
  });
});
