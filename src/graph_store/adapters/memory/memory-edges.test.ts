import { describe, expect, it } from 'vitest';
import type { AdapterTx, EdgeRecord, StorageAdapter } from '../../adapter.js';
import { createMemoryAdapter } from './index.js';

const edge = (item: string, category: string, extra: Partial<EdgeRecord> = {}): EdgeRecord => ({
  item,
  category,
  ...extra,
});
const first = { limit: 1000, cursor: null };

async function adapterWithGraph(graphId = 'g'): Promise<StorageAdapter> {
  const adapter = createMemoryAdapter();
  await adapter.graphs.create(graphId);
  return adapter;
}

const edgesOf = (adapter: StorageAdapter, p: 'item' | 'category', id: string, graphId = 'g') =>
  adapter.transaction(graphId, async (tx) => (await tx.edgesOf(p, id, first)).items);

describe('memory adapter: edges', () => {
  it('finds an edge from either end', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putEdges([edge('note', 'work', { weight: 0.8, data: { why: 'x' } })]));
    const expected = [edge('note', 'work', { weight: 0.8, data: { why: 'x' } })];
    expect(await edgesOf(adapter, 'item', 'note')).toEqual(expected);
    expect(await edgesOf(adapter, 'category', 'work')).toEqual(expected);
  });

  it('returns every edge for a node, ordered by the other end', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) =>
      tx.putEdges([edge('i1', 'c2'), edge('i1', 'c1'), edge('i2', 'c1'), edge('i0', 'c1')]),
    );
    expect((await edgesOf(adapter, 'item', 'i1')).map((e) => e.category)).toEqual(['c1', 'c2']);
    expect((await edgesOf(adapter, 'category', 'c1')).map((e) => e.item)).toEqual(['i0', 'i1', 'i2']);
  });

  it('returns nothing for a node with no edges', async () => {
    const adapter = await adapterWithGraph();
    expect(await edgesOf(adapter, 'item', 'ghost')).toEqual([]);
    expect(await edgesOf(adapter, 'category', 'ghost')).toEqual([]);
  });

  it('keeps an item and a category with the same id apart', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putEdges([edge('x', 'other'), edge('another', 'x')]));
    expect((await edgesOf(adapter, 'item', 'x')).map((e) => e.category)).toEqual(['other']);
    expect((await edgesOf(adapter, 'category', 'x')).map((e) => e.item)).toEqual(['another']);
  });
});

describe('memory adapter: put is an idempotent upsert', () => {
  it('stores one edge when the same link is put twice, latest weight wins (AC-06)', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putEdges([edge('a', 'c', { weight: 1 })]));
    await adapter.transaction('g', (tx) => tx.putEdges([edge('a', 'c', { weight: 5 })]));
    expect(await edgesOf(adapter, 'item', 'a')).toEqual([edge('a', 'c', { weight: 5 })]);
    expect(await edgesOf(adapter, 'category', 'c')).toEqual([edge('a', 'c', { weight: 5 })]);
  });

  it('replaces the whole record, so an omitted weight or data is dropped', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putEdges([edge('a', 'c', { weight: 1, data: { k: 1 } })]));
    await adapter.transaction('g', (tx) => tx.putEdges([edge('a', 'c')]));
    expect(await edgesOf(adapter, 'item', 'a')).toEqual([edge('a', 'c')]);
  });

  it('dedupes within a single call: last one wins', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putEdges([edge('a', 'c', { weight: 1 }), edge('a', 'c', { weight: 2 })]));
    expect(await edgesOf(adapter, 'item', 'a')).toEqual([edge('a', 'c', { weight: 2 })]);
  });

  it('does not alias caller data in or out', async () => {
    const adapter = await adapterWithGraph();
    const data = { tags: ['x'] };
    await adapter.transaction('g', (tx) => tx.putEdges([edge('a', 'c', { data })]));
    data.tags.push('mutated');
    const [out] = await edgesOf(adapter, 'item', 'a');
    expect(out?.data).toEqual({ tags: ['x'] });
    (out?.data?.tags as string[]).push('mutated-out');
    expect((await edgesOf(adapter, 'category', 'c'))[0]?.data).toEqual({ tags: ['x'] });
  });
});

describe('memory adapter: delete', () => {
  it('removes an edge from both directions and leaves other edges alone', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putEdges([edge('a', 'c1'), edge('a', 'c2'), edge('b', 'c1')]));
    await adapter.transaction('g', (tx) => tx.deleteEdges([{ item: 'a', category: 'c1' }]));
    expect((await edgesOf(adapter, 'item', 'a')).map((e) => e.category)).toEqual(['c2']);
    expect((await edgesOf(adapter, 'category', 'c1')).map((e) => e.item)).toEqual(['b']);
  });

  it('ignores keys that do not exist', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putEdges([edge('a', 'c')]));
    await adapter.transaction('g', (tx) =>
      tx.deleteEdges([
        { item: 'a', category: 'nope' },
        { item: 'nope', category: 'c' },
      ]),
    );
    expect(await edgesOf(adapter, 'item', 'a')).toEqual([edge('a', 'c')]);
  });

  it('can delete and re-add the same edge', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putEdges([edge('a', 'c', { weight: 1 })]));
    await adapter.transaction('g', (tx) => tx.deleteEdges([{ item: 'a', category: 'c' }]));
    expect(await edgesOf(adapter, 'item', 'a')).toEqual([]);
    await adapter.transaction('g', (tx) => tx.putEdges([edge('a', 'c', { weight: 2 })]));
    expect(await edgesOf(adapter, 'category', 'c')).toEqual([edge('a', 'c', { weight: 2 })]);
  });
});

describe('memory adapter: edge transactions and isolation', () => {
  it('rolls edges back when the callback throws (AC-04 groundwork)', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putEdges([edge('keep', 'c')]));
    await expect(
      adapter.transaction('g', async (tx) => {
        await tx.putEdges([edge('new', 'c')]);
        await tx.deleteEdges([{ item: 'keep', category: 'c' }]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await edgesOf(adapter, 'category', 'c')).toEqual([edge('keep', 'c')]);
  });

  it('keeps edges separate between graphs (AC-01 groundwork)', async () => {
    const adapter = await adapterWithGraph('A');
    await adapter.graphs.create('B');
    await adapter.transaction('A', (tx) => tx.putEdges([edge('a', 'c')]));
    expect(await edgesOf(adapter, 'item', 'a', 'B')).toEqual([]);
  });

  it('forgets edges when a graph is dropped', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putEdges([edge('a', 'c')]));
    await adapter.graphs.drop('g');
    await adapter.graphs.create('g');
    expect(await edgesOf(adapter, 'item', 'a')).toEqual([]);
    expect(await edgesOf(adapter, 'category', 'c')).toEqual([]);
  });

  it('serialises concurrent edge writes (no lost updates)', async () => {
    const adapter = await adapterWithGraph();
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        adapter.transaction('g', async (tx) => {
          const before = (await tx.edgesOf('category', 'c', first)).items.length;
          await Promise.resolve();
          await tx.putEdges([edge(`i${String(i).padStart(2, '0')}`, 'c', { weight: before })]);
        }),
      ),
    );
    expect(await edgesOf(adapter, 'category', 'c')).toHaveLength(40);
  });
});

describe('memory adapter: edge paging', () => {
  async function collect(tx: AdapterTx, p: 'item' | 'category', id: string, limit: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<AdapterTx['edgesOf']>> = await tx.edgesOf(p, id, { limit, cursor });
      seen.push(...page.items.map((e) => (p === 'item' ? e.category : e.item)));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return seen;
  }

  it('pages 120 edges as 3 pages of unique ids in stable order, from either end', async () => {
    const adapter = await adapterWithGraph();
    const ids = Array.from({ length: 120 }, (_, i) => `n${String(i).padStart(3, '0')}`);
    await adapter.transaction('g', (tx) => tx.putEdges([...ids].reverse().map((id) => edge('hub', id))));
    await adapter.transaction('g', (tx) => tx.putEdges([...ids].reverse().map((id) => edge(id, 'hub'))));
    await adapter.transaction('g', async (tx) => {
      expect(await collect(tx, 'item', 'hub', 50)).toEqual(ids);
      expect(await collect(tx, 'category', 'hub', 50)).toEqual(ids);
      const firstPage = await tx.edgesOf('item', 'hub', { limit: 50, cursor: null });
      expect(firstPage.items).toHaveLength(50);
      expect(firstPage.nextCursor).not.toBeNull();
    });
  });

  it('does not skip or repeat when edges are added between pages', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putEdges(['b', 'd', 'f'].map((c) => edge('i', c))));
    const p1 = await adapter.transaction('g', (tx) => tx.edgesOf('item', 'i', { limit: 2, cursor: null }));
    await adapter.transaction('g', (tx) => tx.putEdges(['a', 'c', 'e'].map((c) => edge('i', c))));
    const p2 = await adapter.transaction('g', (tx) => tx.edgesOf('item', 'i', { limit: 10, cursor: p1.nextCursor }));
    expect(p1.items.map((e) => e.category)).toEqual(['b', 'd']);
    expect(p2.items.map((e) => e.category)).toEqual(['e', 'f']);
  });

  it('has no next cursor on the last page', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', (tx) => tx.putEdges([edge('i', 'a'), edge('i', 'b')]));
    const page = await adapter.transaction('g', (tx) => tx.edgesOf('item', 'i', { limit: 2, cursor: null }));
    expect(page.nextCursor).toBeNull();
  });
});

describe('memory adapter: cascade built from the primitives (FR-07, AC-05 groundwork)', () => {
  it('deleting a category via edgesOf + deleteEdges + deleteNodes leaves no orphan edges', async () => {
    const adapter = await adapterWithGraph();
    await adapter.transaction('g', async (tx) => {
      await tx.putNodes([
        { partition: 'category', id: 'work' },
        { partition: 'category', id: 'keep' },
        ...['i1', 'i2', 'i3'].map((id) => ({ partition: 'item' as const, id })),
      ]);
      await tx.putEdges([edge('i1', 'work'), edge('i2', 'work'), edge('i3', 'work'), edge('i1', 'keep')]);
    });

    await adapter.transaction('g', async (tx) => {
      const { items } = await tx.edgesOf('category', 'work', first);
      await tx.deleteEdges(items.map(({ item, category }) => ({ item, category })));
      await tx.deleteNodes('category', ['work']);
    });

    for (const id of ['i1', 'i2', 'i3']) {
      const categories = (await edgesOf(adapter, 'item', id)).map((e) => e.category);
      expect(categories).not.toContain('work');
    }
    expect(await edgesOf(adapter, 'category', 'work')).toEqual([]);
    expect((await edgesOf(adapter, 'item', 'i1')).map((e) => e.category)).toEqual(['keep']);
  });
});
