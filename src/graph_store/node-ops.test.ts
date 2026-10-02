import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from './adapters/memory/index.js';
import type { EdgeRecord, NodeRecord, StorageAdapter } from './adapter.js';
import {
  applyDeleteNode,
  applyUpsertNode,
  planCascade,
  planUpsertNode,
  type DeleteNodeOp,
  type UpsertNodeOp,
} from './node-ops.js';

const upsert = (over: Partial<UpsertNodeOp> = {}): UpsertNodeOp => ({
  op: 'upsertNode',
  partition: 'item',
  id: 'n',
  mode: 'replace',
  ...over,
});
const del = (partition: 'item' | 'category', id: string): DeleteNodeOp => ({ op: 'deleteNode', partition, id });
const node = (partition: 'item' | 'category', id: string, data?: NodeRecord['data']): NodeRecord =>
  data === undefined ? { partition, id } : { partition, id, data };
const edge = (item: string, category: string): EdgeRecord => ({ item, category });
const first = { limit: 1000, cursor: null };

describe('planUpsertNode (pure)', () => {
  it('creates a node from the op when none exists', () => {
    expect(planUpsertNode(upsert({ data: { a: 1 } }), undefined)).toEqual(node('item', 'n', { a: 1 }));
    expect(planUpsertNode(upsert(), undefined)).toEqual(node('item', 'n'));
    expect(planUpsertNode(upsert({ mode: 'merge', data: { a: 1 } }), undefined)).toEqual(node('item', 'n', { a: 1 }));
  });

  it('replace: data becomes exactly the op data', () => {
    const existing = node('item', 'n', { old: 1, keep: 2 });
    expect(planUpsertNode(upsert({ data: { new: 3 } }), existing)).toEqual(node('item', 'n', { new: 3 }));
  });

  it('replace without data clears existing data (PUT semantics)', () => {
    const existing = node('item', 'n', { old: 1 });
    expect(planUpsertNode(upsert(), existing)).toEqual(node('item', 'n'));
  });

  it('merge: shallow union where op keys win', () => {
    const existing = node('item', 'n', { a: 1, b: 2, nested: { x: 1, y: 2 } });
    const result = planUpsertNode(upsert({ mode: 'merge', data: { b: 20, c: 3, nested: { x: 9 } } }), existing);
    expect(result).toEqual(node('item', 'n', { a: 1, b: 20, c: 3, nested: { x: 9 } }));
  });

  it('merge without op data keeps existing data; null overrides rather than deletes', () => {
    const existing = node('item', 'n', { a: 1, b: 2 });
    expect(planUpsertNode(upsert({ mode: 'merge' }), existing)).toEqual(existing);
    expect(planUpsertNode(upsert({ mode: 'merge', data: { a: null } }), existing)).toEqual(
      node('item', 'n', { a: null, b: 2 }),
    );
  });

  it('does not modify its inputs', () => {
    const existing = Object.freeze(node('item', 'n', Object.freeze({ a: 1 })));
    const op = Object.freeze(upsert({ mode: 'merge', data: Object.freeze({ b: 2 }) }));
    expect(() => planUpsertNode(op, existing)).not.toThrow();
    expect(existing.data).toEqual({ a: 1 });
  });
});

describe('planCascade (pure)', () => {
  it('maps edges to their keys, dropping weight and data', () => {
    const edges: EdgeRecord[] = [{ item: 'i', category: 'c', weight: 2, data: { k: 1 } }];
    expect(planCascade(edges)).toEqual([{ item: 'i', category: 'c' }]);
    expect(planCascade([])).toEqual([]);
  });
});

async function adapterWithGraph(): Promise<StorageAdapter> {
  const adapter = createMemoryAdapter();
  await adapter.graphs.create('g');
  return adapter;
}

const run = <T>(adapter: StorageAdapter, fn: Parameters<StorageAdapter['transaction']>[1]) =>
  adapter.transaction('g', fn) as Promise<T>;

const getNode = (adapter: StorageAdapter, partition: 'item' | 'category', id: string) =>
  run<NodeRecord[]>(adapter, (tx) => tx.getNodes(partition, [id]));
const edgesOf = (adapter: StorageAdapter, partition: 'item' | 'category', id: string) =>
  run<EdgeRecord[]>(adapter, async (tx) => (await tx.edgesOf(partition, id, first)).items);

describe('applyUpsertNode (shell)', () => {
  it('creates, replaces and merges through the adapter', async () => {
    const adapter = await adapterWithGraph();
    await run(adapter, (tx) => applyUpsertNode(tx, upsert({ data: { title: 'v1', tags: ['a'] } })));
    expect(await getNode(adapter, 'item', 'n')).toEqual([node('item', 'n', { title: 'v1', tags: ['a'] })]);

    await run(adapter, (tx) => applyUpsertNode(tx, upsert({ mode: 'merge', data: { rating: 5 } })));
    expect(await getNode(adapter, 'item', 'n')).toEqual([node('item', 'n', { title: 'v1', tags: ['a'], rating: 5 })]);

    await run(adapter, (tx) => applyUpsertNode(tx, upsert({ data: { title: 'v2' } })));
    expect(await getNode(adapter, 'item', 'n')).toEqual([node('item', 'n', { title: 'v2' })]);
  });

  it('keeps the node edges when data is replaced', async () => {
    const adapter = await adapterWithGraph();
    await run(adapter, async (tx) => {
      await applyUpsertNode(tx, upsert({ id: 'i' }));
      await tx.putEdges([edge('i', 'c')]);
      await applyUpsertNode(tx, upsert({ id: 'i', data: { changed: true } }));
    });
    expect(await edgesOf(adapter, 'item', 'i')).toEqual([edge('i', 'c')]);
  });

  it('treats the same id in the two partitions as different nodes (FR-04)', async () => {
    const adapter = await adapterWithGraph();
    await run(adapter, async (tx) => {
      await applyUpsertNode(tx, upsert({ partition: 'item', id: 'x', data: { as: 'item' } }));
      await applyUpsertNode(tx, upsert({ partition: 'category', id: 'x', data: { as: 'category' } }));
    });
    expect(await getNode(adapter, 'item', 'x')).toEqual([node('item', 'x', { as: 'item' })]);
    expect(await getNode(adapter, 'category', 'x')).toEqual([node('category', 'x', { as: 'category' })]);
  });
});

describe('applyDeleteNode (shell, cascade)', () => {
  it('deleting an item removes its edges from the category side too', async () => {
    const adapter = await adapterWithGraph();
    await run(adapter, async (tx) => {
      await tx.putNodes([node('item', 'i'), node('item', 'other'), node('category', 'c')]);
      await tx.putEdges([edge('i', 'c'), edge('other', 'c')]);
    });
    await run(adapter, (tx) => applyDeleteNode(tx, del('item', 'i')));
    expect(await edgesOf(adapter, 'category', 'c')).toEqual([edge('other', 'c')]);
    expect(await getNode(adapter, 'item', 'i')).toEqual([]);
  });

  it('only cascades within the named partition when ids collide', async () => {
    const adapter = await adapterWithGraph();
    await run(adapter, async (tx) => {
      await tx.putNodes([node('item', 'x'), node('category', 'x'), node('category', 'c1'), node('item', 'i1')]);
      await tx.putEdges([edge('x', 'c1'), edge('i1', 'x')]);
    });
    await run(adapter, (tx) => applyDeleteNode(tx, del('item', 'x')));
    expect(await edgesOf(adapter, 'item', 'x')).toEqual([]);
    expect(await edgesOf(adapter, 'category', 'x')).toEqual([edge('i1', 'x')]);
    expect(await getNode(adapter, 'category', 'x')).toHaveLength(1);
  });

  it('removes every edge of a high-degree node across multiple pages', async () => {
    const adapter = await adapterWithGraph();
    const ids = Array.from({ length: 2500 }, (_, i) => `i${String(i).padStart(4, '0')}`);
    await run(adapter, async (tx) => {
      await tx.putNodes([node('category', 'hub'), ...ids.map((id) => node('item', id))]);
      await tx.putEdges(ids.map((id) => edge(id, 'hub')));
      await tx.putEdges([edge('i0000', 'other')]);
    });
    await run(adapter, (tx) => applyDeleteNode(tx, del('category', 'hub')));
    expect(await edgesOf(adapter, 'category', 'hub')).toEqual([]);
    for (const id of ['i0000', 'i1000', 'i2499']) {
      expect((await edgesOf(adapter, 'item', id)).map((e) => e.category)).not.toContain('hub');
    }
    expect(await edgesOf(adapter, 'item', 'i0000')).toEqual([edge('i0000', 'other')]);
  });

  it('is a no-op for a node that does not exist', async () => {
    const adapter = await adapterWithGraph();
    await run(adapter, async (tx) => {
      await tx.putNodes([node('item', 'a'), node('category', 'c')]);
      await tx.putEdges([edge('a', 'c')]);
    });
    await run(adapter, (tx) => applyDeleteNode(tx, del('item', 'ghost')));
    expect(await getNode(adapter, 'item', 'a')).toHaveLength(1);
    expect(await edgesOf(adapter, 'item', 'a')).toEqual([edge('a', 'c')]);
  });

  it('can be undone: a throw after the delete restores node and edges', async () => {
    const adapter = await adapterWithGraph();
    await run(adapter, async (tx) => {
      await tx.putNodes([node('item', 'a'), node('category', 'c')]);
      await tx.putEdges([edge('a', 'c')]);
    });
    await expect(
      run(adapter, async (tx) => {
        await applyDeleteNode(tx, del('category', 'c'));
        throw new Error('later op failed');
      }),
    ).rejects.toThrow('later op failed');
    expect(await getNode(adapter, 'category', 'c')).toHaveLength(1);
    expect(await edgesOf(adapter, 'item', 'a')).toEqual([edge('a', 'c')]);
  });
});
