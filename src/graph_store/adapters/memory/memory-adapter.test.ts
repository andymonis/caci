import { describe, expect, it } from 'vitest';
import type { NodeRecord, StorageAdapter } from '../../adapter.js';
import { createMemoryAdapter } from './index.js';

const item = (id: string, data?: NodeRecord['data']): NodeRecord =>
  data === undefined ? { partition: 'item', id } : { partition: 'item', id, data };
const category = (id: string): NodeRecord => ({ partition: 'category', id });
const first = { limit: 1000, cursor: null };

async function adapterWithGraph(graphId = 'g'): Promise<StorageAdapter> {
  const adapter = createMemoryAdapter();
  await adapter.graphs.create(graphId);
  return adapter;
}

const listAll = (adapter: StorageAdapter, graphId: string, p: 'item' | 'category') =>
  adapter.transaction(graphId, async (tx) => (await tx.listNodes(p, first)).items);

describe('memory adapter: nodes', () => {
  it('stores and retrieves nodes per partition', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putNodes([item('a', { title: 'A' }), category('c')]));
    const got = await adapter.transaction('g', async (tx) => ({
      items: await tx.getNodes('item', ['a']),
      categories: await tx.getNodes('category', ['c']),
    }));
    expect(got.items).toEqual([item('a', { title: 'A' })]);
    expect(got.categories).toEqual([category('c')]);
  });

  it('allows the same id as an item and a category (FR-04)', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putNodes([item('x', { kind: 'item' }), category('x')]));
    expect(await listAll(adapter, 'g', 'item')).toEqual([item('x', { kind: 'item' })]);
    expect(await listAll(adapter, 'g', 'category')).toEqual([category('x')]);
    await adapter.transaction('g', (tx) => tx.deleteNodes('item', ['x']));
    expect(await listAll(adapter, 'g', 'item')).toEqual([]);
    expect(await listAll(adapter, 'g', 'category')).toEqual([category('x')]);
  });

  it('put replaces the whole record; get omits missing ids and keeps request order', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putNodes([item('a', { v: 1 }), item('b')]));
    await adapter.transaction('g', (tx) => tx.putNodes([item('a')]));
    const got = await adapter.transaction('g', (tx) => tx.getNodes('item', ['b', 'missing', 'a']));
    expect(got).toEqual([item('b'), item('a')]);
  });

  it('delete removes nodes and ignores missing ids', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putNodes([item('a'), item('b')]));
    await adapter.transaction('g', (tx) => tx.deleteNodes('item', ['a', 'nope']));
    expect(await listAll(adapter, 'g', 'item')).toEqual([item('b')]);
  });

  it('does not alias caller data in or out', async () => {
    const adapter = await adapterWithGraph();
    const input = { tags: ['x'] };
    await adapter.transaction('g', (tx) => tx.putNodes([item('a', input)]));
    input.tags.push('mutated-after-put');
    const [out] = await adapter.transaction('g', (tx) => tx.getNodes('item', ['a']));
    expect(out?.data).toEqual({ tags: ['x'] });
    (out?.data?.tags as string[]).push('mutated-after-get');
    const [again] = await adapter.transaction('g', (tx) => tx.getNodes('item', ['a']));
    expect(again?.data).toEqual({ tags: ['x'] });
  });
});

describe('memory adapter: transactions', () => {
  it('leaves state unchanged when the callback throws', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putNodes([item('keep')]));
    await expect(
      adapter.transaction('g', async (tx) => {
        await tx.putNodes([item('new')]);
        await tx.deleteNodes('item', ['keep']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await listAll(adapter, 'g', 'item')).toEqual([item('keep')]);
  });

  it('commits on success and returns the callback result', async () => {
    const adapter = await adapterWithGraph();
    const result = await adapter.transaction('g', async (tx) => {
      await tx.putNodes([item('a')]);
      return 'done';
    });
    expect(result).toBe('done');
    expect(await listAll(adapter, 'g', 'item')).toEqual([item('a')]);
  });

  it('reads its own writes inside a transaction', async () => {
    const adapter = await adapterWithGraph();
    const seen = await adapter.transaction('g', async (tx) => {
      await tx.putNodes([item('a')]);
      return tx.getNodes('item', ['a']);
    });
    expect(seen).toEqual([item('a')]);
  });

  it('serialises concurrent transactions on one graph (no lost updates)', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putNodes([item('counter', { n: 0 })]));
    await Promise.all(
      Array.from({ length: 50 }, () =>
        adapter.transaction('g', async (tx) => {
          const [node] = await tx.getNodes('item', ['counter']);
          await Promise.resolve(); // yield, so interleaving would lose updates without serialisation
          await tx.putNodes([item('counter', { n: Number(node?.data?.n) + 1 })]);
        }),
      ),
    );
    const [final] = await adapter.transaction('g', (tx) => tx.getNodes('item', ['counter']));
    expect(final?.data).toEqual({ n: 50 });
  });

  it('keeps working after a failed transaction', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', async () => {
      throw new Error('first fails');
    }).catch(() => undefined);
    await adapter.transaction('g', (tx) => tx.putNodes([item('a')]));
    expect(await listAll(adapter, 'g', 'item')).toEqual([item('a')]);
  });

  it('rejects use of a transaction after it has finished', async () => {
    const adapter = await adapterWithGraph();
    let leaked!: Parameters<Parameters<StorageAdapter['transaction']>[1]>[0];
    await adapter.transaction('g', async (tx) => {
      leaked = tx;
    });
    await expect(leaked.putNodes([item('late')])).rejects.toThrow('closed');
  });

  it('rejects a transaction on a missing graph', async () => {
    const adapter = createMemoryAdapter();
    await expect(adapter.transaction('nope', async () => 1)).rejects.toThrow('Graph not found');
  });
});

describe('memory adapter: isolation', () => {
  it('keeps graphs separate even with identical node ids', async () => {
    const adapter = await adapterWithGraph('A');
    await adapter.graphs.create('B');
    await adapter.transaction('A', (tx) => tx.putNodes([item('same', { from: 'A' })]));
    expect(await listAll(adapter, 'B', 'item')).toEqual([]);
    await adapter.transaction('B', (tx) => tx.putNodes([item('same', { from: 'B' })]));
    expect(await listAll(adapter, 'A', 'item')).toEqual([item('same', { from: 'A' })]);
  });

  it('shares nothing between two adapter instances', async () => {
    const one = await adapterWithGraph();
    const two = await adapterWithGraph();
    await one.transaction('g', (tx) => tx.putNodes([item('only-in-one')]));
    expect(await listAll(two, 'g', 'item')).toEqual([]);
    const three = createMemoryAdapter();
    expect(await three.graphs.exists('g')).toBe(false);
  });
});

describe('memory adapter: graphs', () => {
  it('creates, checks, lists and drops graphs', async () => {
    const adapter = createMemoryAdapter();
    expect(await adapter.graphs.exists('g')).toBe(false);
    await adapter.graphs.create('g');
    expect(await adapter.graphs.exists('g')).toBe(true);
    await adapter.graphs.create('a');
    expect((await adapter.graphs.list(first)).items).toEqual(['a', 'g']);
    await adapter.graphs.drop('g');
    expect(await adapter.graphs.exists('g')).toBe(false);
  });

  it('create is idempotent and keeps existing data; drop of a missing graph is a no-op', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putNodes([item('a')]));
    await adapter.graphs.create('g');
    expect(await listAll(adapter, 'g', 'item')).toEqual([item('a')]);
    await expect(adapter.graphs.drop('missing')).resolves.toBeUndefined();
  });

  it('drop removes all nodes: a recreated graph is empty', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putNodes([item('a'), category('c')]));
    await adapter.graphs.drop('g');
    await adapter.graphs.create('g');
    expect(await listAll(adapter, 'g', 'item')).toEqual([]);
    expect(await listAll(adapter, 'g', 'category')).toEqual([]);
  });

  it('pages graph ids with a keyset cursor', async () => {
    const adapter = createMemoryAdapter();
    for (const id of ['d', 'b', 'a', 'c', 'e']) await adapter.graphs.create(id);
    const p1 = await adapter.graphs.list({ limit: 2, cursor: null });
    const p2 = await adapter.graphs.list({ limit: 2, cursor: p1.nextCursor });
    const p3 = await adapter.graphs.list({ limit: 2, cursor: p2.nextCursor });
    expect([p1.items, p2.items, p3.items]).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(p3.nextCursor).toBeNull();
  });
});

describe('memory adapter: listNodes paging', () => {
  it('returns 120 nodes as 3 pages of unique ids in stable order', async () => {
    const adapter = await adapterWithGraph();
    const ids = Array.from({ length: 120 }, (_, i) => `n${String(i).padStart(3, '0')}`);
    await adapter.transaction('g', (tx) => tx.putNodes([...ids].reverse().map((id) => item(id))));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { items: readonly NodeRecord[]; nextCursor: string | null } = await adapter.transaction(
        'g',
        (tx) => tx.listNodes('item', { limit: 50, cursor }),
      );
      seen.push(...page.items.map((n) => n.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual(ids);
  });

  it('does not skip or repeat when nodes are added between pages', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putNodes(['b', 'd', 'f'].map((id) => item(id))));
    const p1 = await adapter.transaction('g', (tx) => tx.listNodes('item', { limit: 2, cursor: null }));
    await adapter.transaction('g', (tx) => tx.putNodes([item('a'), item('c'), item('e')]));
    const p2 = await adapter.transaction('g', (tx) => tx.listNodes('item', { limit: 10, cursor: p1.nextCursor }));
    expect(p1.items.map((n) => n.id)).toEqual(['b', 'd']);
    expect(p2.items.map((n) => n.id)).toEqual(['e', 'f']);
  });

  it('rejects a non-positive limit', async () => {
    const adapter = await adapterWithGraph();
    await expect(adapter.transaction('g', (tx) => tx.listNodes('item', { limit: 0, cursor: null }))).rejects.toThrow(
      RangeError,
    );
  });
});

describe('memory adapter: contract', () => {
  it('declares its capabilities', () => {
    const adapter = createMemoryAdapter();
    expect(adapter.name).toBe('memory');
    expect(adapter.capabilities).toEqual({ transactions: true, idempotency: false, nativeSetQueries: false });
  });
});
