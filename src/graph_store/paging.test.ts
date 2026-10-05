import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from './adapters/memory/index.js';
import type { AdapterTx, Page, Paged, Partition, StorageAdapter } from './adapter.js';
import { query, write } from './endpoints.js';
import { describeGraph } from './graphs.js';
import { READ_PAGE, walkPages } from './paging.js';
import { conformanceGroups } from './testing/cases.js';
import { link, mutation, upsert } from './testing/helpers.js';

/** A listing over `rows` that hands out `size` rows per page with cursors "1", "2", ... */
const listing = <T>(rows: readonly T[], size: number) => async (page: Page): Promise<Paged<T>> => {
  const start = page.cursor === null ? 0 : Number(page.cursor) * size;
  const end = Math.min(rows.length, start + size);
  return { items: rows.slice(start, end), nextCursor: end < rows.length ? String(end / size) : null };
};
const collect = async <T>(gen: AsyncGenerator<readonly T[]>): Promise<T[][]> => {
  const out: T[][] = [];
  for await (const page of gen) out.push([...page]);
  return out;
};

describe('walkPages', () => {
  it('hands over every page in order, however many there are', async () => {
    const pages = await collect(walkPages(listing([1, 2, 3, 4, 5], 2), 'numbers'));
    expect(pages).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('asks for the page size it is given, starting from no cursor', async () => {
    const asked: Page[] = [];
    await collect(walkPages(async (page) => (asked.push(page), { items: [], nextCursor: null }), 'x', 25));
    expect(asked).toEqual([{ limit: 25, cursor: null }]);
    const defaults: Page[] = [];
    await collect(walkPages(async (page) => (defaults.push(page), { items: [], nextCursor: null }), 'x'));
    expect(defaults[0]?.limit).toBe(READ_PAGE);
  });

  it('follows the cursors the adapter returns', async () => {
    const asked: Array<string | null> = [];
    await collect(walkPages(async (page) => {
      asked.push(page.cursor);
      return { items: [asked.length], nextCursor: asked.length < 3 ? `c${asked.length}` : null };
    }, 'x'));
    expect(asked).toEqual([null, 'c1', 'c2']);
  });

  it('copes with an empty listing and with one page that has everything', async () => {
    expect(await collect(walkPages(listing([], 2), 'nothing'))).toEqual([[]]);
    expect(await collect(walkPages(listing([1, 2], 5), 'few'))).toEqual([[1, 2]]);
  });

  it('gives the caller a page before it checks that page\'s cursor, so the caller can act on it first', async () => {
    const seen: number[][] = [];
    await expect(
      (async () => {
        for await (const page of walkPages(async () => ({ items: [7], nextCursor: 'same' }), 'rows')) seen.push([...page]);
      })(),
    ).rejects.toThrow();
    expect(seen).toEqual([[7], [7]]); // the first page, then the second page whose cursor repeated
  });

  it('throws when a cursor does not advance, and says what it was listing', async () => {
    await expect(collect(walkPages(async () => ({ items: [1], nextCursor: 'same' }), 'item nodes'))).rejects.toThrow(
      "the adapter's paging cursor did not advance while listing item nodes",
    );
  });

  it('throws when the adapter goes back to a cursor it already gave', async () => {
    const order = ['a', 'b', 'a'];
    let n = 0;
    await expect(collect(walkPages(async () => ({ items: [n], nextCursor: order[n++] ?? null }), 'edges of item "i1"'))).rejects.toThrow(
      "the adapter's paging cursor went back to an earlier page while listing edges of item \"i1\"",
    );
  });

  it('throws on a cursor that is not text and does not move (undefined)', async () => {
    await expect(collect(walkPages(async () => ({ items: [1], nextCursor: undefined as unknown as null }), 'x'))).rejects.toThrow('did not advance');
  });

  it('does not throw for many different cursors, even long runs of them', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => i);
    const pages = await collect(walkPages(listing(rows, 1), 'many'));
    expect(pages).toHaveLength(5000);
  });

  it('treats a cursor value given on two different pages as going back (a cursor names a position)', async () => {
    let n = 0;
    await expect(collect(walkPages(async () => ({ items: [n], nextCursor: n++ % 2 === 0 ? 'x' : 'y' }), 'x'))).rejects.toThrow('went back');
  });
});

// ---- the core, on adapters whose cursors misbehave ----

type Patch = (tx: AdapterTx) => Partial<AdapterTx>;

/** A memory adapter whose transactions are patched, plus the untouched one underneath for looking at what was stored. */
function broken(patch: Patch): { adapter: StorageAdapter; real: StorageAdapter } {
  const real = createMemoryAdapter();
  return { real, adapter: { ...real, transaction: (graphId, fn) => real.transaction(graphId, (tx) => fn({ ...tx, ...patch(tx) })) } };
}

const everything = async (tx: AdapterTx, p: Partition) => (await tx.listNodes(p, { limit: 1_000_000, cursor: null })).items;
const everyEdge = async (tx: AdapterTx, p: Partition, id: string) => (await tx.edgesOf(p, id, { limit: 1_000_000, cursor: null })).items;

/** A listing whose cursor never moves on. */
const stuckNodes: Patch = (tx) => ({
  listNodes: async (p, page) => {
    const r = await tx.listNodes(p, { limit: Math.min(page.limit, 2), cursor: null });
    return { items: r.items, nextCursor: r.items.length > 0 ? 'same' : null };
  },
});
const stuckEdges: Patch = (tx) => ({
  edgesOf: async (p, id, page) => {
    const r = await tx.edgesOf(p, id, { limit: Math.min(page.limit, 2), cursor: null });
    return { items: r.items, nextCursor: r.items.length > 0 ? 'same' : null };
  },
});
/** A listing that goes page one, page two, page one, ... with cursors a, b, a. */
const cyclingNodes: Patch = (tx) => ({
  listNodes: async (p, page) => {
    const all = await everything(tx, p);
    const start = page.cursor === 'a' ? 2 : 0;
    return { items: all.slice(start, start + 2), nextCursor: page.cursor === null ? 'a' : page.cursor === 'a' ? 'b' : 'a' };
  },
});
const cyclingEdges: Patch = (tx) => ({
  edgesOf: async (p, id, page) => {
    const all = await everyEdge(tx, p, id);
    const start = page.cursor === 'a' ? 2 : 0;
    return { items: all.slice(start, start + 2), nextCursor: page.cursor === null ? 'a' : page.cursor === 'a' ? 'b' : 'a' };
  },
});

/** Six items, two categories; item i1 is linked to five categories' worth of edges so edge paging has several pages. */
const populate = (graphId = 'g') =>
  mutation(
    [
      ...['i1', 'i2', 'i3', 'i4', 'i5', 'i6'].map((id) => upsert('item', id)),
      ...['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => upsert('category', id)),
      ...['c1', 'c2', 'c3', 'c4', 'c5'].map((c) => link('i1', c)),
      link('i2', 'c1'),
    ],
    { graphId, createIfMissing: true },
  );

const contents = async (adapter: StorageAdapter) =>
  adapter.transaction('g', async (tx) => ({
    items: (await everything(tx, 'item')).length,
    categories: (await everything(tx, 'category')).length,
    edgesOfI1: (await everyEdge(tx, 'item', 'i1')).length,
  }));

describe('describeGraph does not loop for ever on a bad cursor', () => {
  it.each([
    ['listNodes never advances', stuckNodes, 'did not advance while listing item nodes'],
    ['edgesOf never advances', stuckEdges, 'did not advance while listing edges of item'],
    ['listNodes goes back to an earlier page', cyclingNodes, 'went back to an earlier page while listing item nodes'],
    ['edgesOf goes back to an earlier page', cyclingEdges, 'went back to an earlier page while listing edges of item'],
  ])('%s: STORAGE_ERROR that names the listing', async (_name, patch, message) => {
    const { adapter, real } = broken(patch);
    expect((await write(real, populate())).ok).toBe(true);
    const r = await describeGraph(adapter, 'g');
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR', message: expect.stringContaining(message) } });
  });

  it('still counts correctly with a well-behaved adapter', async () => {
    const adapter = createMemoryAdapter();
    await write(adapter, populate());
    expect(await describeGraph(adapter, 'g')).toEqual({ ok: true, value: { graphId: 'g', itemCount: 6, categoryCount: 5, edgeCount: 6 } });
  });

  it('counts across many pages (the guard does not trip on a long, honest listing)', async () => {
    const adapter = createMemoryAdapter();
    for (let batch = 0; batch < 3; batch++) {
      const ops = Array.from({ length: 900 }, (_, i) => upsert('item', `b${batch}-${String(i).padStart(4, '0')}`));
      expect((await write(adapter, mutation(ops, { graphId: 'big', createIfMissing: true }))).ok).toBe(true);
    }
    const r = await describeGraph(adapter, 'big');
    expect(r).toMatchObject({ ok: true, value: { itemCount: 2700 } });
  });
});

describe('deleting a node does not loop for ever on a bad edge cursor, and is rolled back', () => {
  it.each([
    ['edgesOf never advances', stuckEdges, 'did not advance while listing edges of item "i1"'],
    ['edgesOf goes back to an earlier page', cyclingEdges, 'went back to an earlier page while listing edges of item "i1"'],
  ])('%s', async (_name, patch, message) => {
    const { adapter, real } = broken(patch);
    expect((await write(real, populate())).ok).toBe(true);
    const before = await contents(real);
    const r = await write(adapter, mutation([{ op: 'deleteNode', partition: 'item', id: 'i1' }], { graphId: 'g' }));
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR', message: expect.stringContaining(message) } });
    expect(await contents(real)).toEqual(before); // the item and every edge it had are still there
  });

  it('also guards a category\'s edges', async () => {
    const { adapter, real } = broken(stuckEdges);
    await write(real, populate());
    await write(real, mutation([link('i3', 'c1'), link('i4', 'c1'), link('i5', 'c1')], { graphId: 'g' })); // c1 now has five edges: several pages
    const r = await write(adapter, mutation([{ op: 'deleteNode', partition: 'category', id: 'c1' }], { graphId: 'g' }));
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR', message: expect.stringContaining('edges of category "c1"') } });
  });

  it('deleting still works with a well-behaved adapter, including a node with many edges', async () => {
    const adapter = createMemoryAdapter();
    const cats = Array.from({ length: 2500 }, (_, i) => `c${String(i).padStart(4, '0')}`);
    for (let i = 0; i < cats.length; i += 450) {
      const ops = cats.slice(i, i + 450).flatMap((c) => [upsert('category', c), link('hub', c, { ensureNodes: true })]); // 900 operations, under the limit
      expect((await write(adapter, mutation(ops, { graphId: 'hub', createIfMissing: true }))).ok).toBe(true);
    }
    expect(await describeGraph(adapter, 'hub')).toMatchObject({ ok: true, value: { itemCount: 1, categoryCount: 2500, edgeCount: 2500 } });
    const r = await write(adapter, mutation([{ op: 'deleteNode', partition: 'item', id: 'hub' }], { graphId: 'hub' }));
    expect(r.ok).toBe(true);
    expect(await describeGraph(adapter, 'hub')).toMatchObject({ ok: true, value: { itemCount: 0, categoryCount: 2500, edgeCount: 0 } });
  });
});

describe('queries keep their guard, now against cycles as well', () => {
  const all = { version: 1, graphId: 'g', from: { all: true }, traverse: { depth: 0 }, return: { shape: 'ids' }, page: { limit: 50, cursor: null } };

  it.each([
    ['listNodes never advances', stuckNodes, 'did not advance'],
    ['listNodes goes back to an earlier page', cyclingNodes, 'went back to an earlier page'],
  ])('%s: STORAGE_ERROR', async (_name, patch, message) => {
    const { adapter, real } = broken(patch);
    await write(real, populate());
    // a whole-graph count walks every page, which is where a cursor that does not move would run for ever
    const r = await query(adapter, { ...all, return: { shape: 'count' } });
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR', message: expect.stringContaining(message) } });
  });
});

// ---- the shared suite, run against adapters whose cursors misbehave ----

describe('the conformance suite fails such adapters promptly instead of hanging', () => {
  const makers: Array<[string, Patch]> = [
    ['a listNodes cursor that never advances', stuckNodes],
    ['an edgesOf cursor that never advances', stuckEdges],
    ['a listNodes listing that repeats a page', cyclingNodes],
    ['an edgesOf listing that repeats a page', cyclingEdges],
  ];

  it.each(makers)('%s', { timeout: 60_000 }, async (_name, patch) => {
    const failed: string[] = [];
    let ran = 0;
    for (const group of conformanceGroups()) {
      for (const testCase of group.cases) {
        ran += 1;
        const made = (): StorageAdapter => broken(patch).adapter;
        try {
          await testCase.run(made(), async () => made());
        } catch {
          failed.push(`${group.name}: ${testCase.name}`);
        }
      }
    }
    expect(ran).toBeGreaterThan(50);
    expect(failed.length).toBeGreaterThan(0); // caught, and the loop above finished, so nothing hung
  });
});
