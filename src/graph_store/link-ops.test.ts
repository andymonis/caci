import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from './adapters/memory/index.js';
import type { EdgeRecord, NodeRecord, StorageAdapter } from './adapter.js';
import { applyLink, applyUnlink, planLink, planLinkEndpoints, type LinkOp, type UnlinkOp } from './link-ops.js';
import type { Result } from './result.js';

const link = (over: Partial<LinkOp> = {}): LinkOp => ({
  op: 'link',
  item: 'i',
  category: 'c',
  ensureNodes: false,
  ...over,
});
const unlink = (item = 'i', category = 'c'): UnlinkOp => ({ op: 'unlink', item, category });
const node = (partition: 'item' | 'category', id: string, data?: NodeRecord['data']): NodeRecord =>
  data === undefined ? { partition, id } : { partition, id, data };
const first = { limit: 1000, cursor: null };

describe('planLink (pure)', () => {
  it('builds the edge from the op, including a weight of 0', () => {
    expect(planLink(link())).toEqual({ item: 'i', category: 'c' });
    expect(planLink(link({ weight: 0.8, data: { why: 'x' } }))).toEqual({
      item: 'i',
      category: 'c',
      weight: 0.8,
      data: { why: 'x' },
    });
    expect(planLink(link({ weight: 0 }))).toHaveProperty('weight', 0);
  });
});

describe('planLinkEndpoints (pure)', () => {
  it('needs nothing when both endpoints exist', () => {
    expect(planLinkEndpoints(link(), true, true)).toEqual({ ok: true, value: [] });
    expect(planLinkEndpoints(link({ ensureNodes: true }), true, true)).toEqual({ ok: true, value: [] });
  });

  it('fails with NODE_NOT_FOUND pointing at the missing field', () => {
    expect(planLinkEndpoints(link(), false, true)).toMatchObject({
      ok: false,
      error: { code: 'NODE_NOT_FOUND', path: ['item'] },
    });
    expect(planLinkEndpoints(link(), true, false)).toMatchObject({
      ok: false,
      error: { code: 'NODE_NOT_FOUND', path: ['category'] },
    });
  });

  it('reports the item first when both are missing', () => {
    expect(planLinkEndpoints(link(), false, false)).toMatchObject({ ok: false, error: { path: ['item'] } });
  });

  it('with ensureNodes, asks for exactly the missing nodes', () => {
    const ensure = link({ ensureNodes: true });
    expect(planLinkEndpoints(ensure, false, false)).toEqual({ ok: true, value: [node('item', 'i'), node('category', 'c')] });
    expect(planLinkEndpoints(ensure, false, true)).toEqual({ ok: true, value: [node('item', 'i')] });
    expect(planLinkEndpoints(ensure, true, false)).toEqual({ ok: true, value: [node('category', 'c')] });
  });
});

async function adapterWithGraph(): Promise<StorageAdapter> {
  const adapter = createMemoryAdapter();
  await adapter.graphs.create('g');
  return adapter;
}
const run = <T>(adapter: StorageAdapter, fn: Parameters<StorageAdapter['transaction']>[1]) =>
  adapter.transaction('g', fn) as Promise<T>;
const edgesOf = (adapter: StorageAdapter, p: 'item' | 'category', id: string) =>
  run<EdgeRecord[]>(adapter, async (tx) => (await tx.edgesOf(p, id, first)).items);
const nodes = (adapter: StorageAdapter, p: 'item' | 'category', ...ids: string[]) =>
  run<NodeRecord[]>(adapter, (tx) => tx.getNodes(p, ids));
const seed = (adapter: StorageAdapter, ...ns: NodeRecord[]) => run(adapter, (tx) => tx.putNodes(ns));

describe('applyLink (shell)', () => {
  it('creates an edge visible from both ends', async () => {
    const adapter = await adapterWithGraph();
    await seed(adapter, node('item', 'i'), node('category', 'c'));
    expect(await run(adapter, (tx) => applyLink(tx, link({ weight: 0.8 })))).toEqual({ ok: true, value: undefined });
    expect(await edgesOf(adapter, 'item', 'i')).toEqual([{ item: 'i', category: 'c', weight: 0.8 }]);
    expect(await edgesOf(adapter, 'category', 'c')).toEqual([{ item: 'i', category: 'c', weight: 0.8 }]);
  });

  it('keeps a weight of 0 as the latest value', async () => {
    const adapter = await adapterWithGraph();
    await seed(adapter, node('item', 'i'), node('category', 'c'));
    await run(adapter, (tx) => applyLink(tx, link({ weight: 3 })));
    await run(adapter, (tx) => applyLink(tx, link({ weight: 0 })));
    expect((await edgesOf(adapter, 'item', 'i'))[0]?.weight).toBe(0);
  });

  it('re-linking replaces the whole edge, so an omitted weight or data is dropped', async () => {
    const adapter = await adapterWithGraph();
    await seed(adapter, node('item', 'i'), node('category', 'c'));
    await run(adapter, (tx) => applyLink(tx, link({ weight: 3, data: { k: 1 } })));
    await run(adapter, (tx) => applyLink(tx, link()));
    expect(await edgesOf(adapter, 'item', 'i')).toEqual([{ item: 'i', category: 'c' }]);
  });

  it('fails with NODE_NOT_FOUND and writes nothing when an endpoint is missing', async () => {
    const adapter = await adapterWithGraph();
    await seed(adapter, node('category', 'c'));
    const r = await run(adapter, (tx) => applyLink(tx, link()));
    expect(r).toMatchObject({ ok: false, error: { code: 'NODE_NOT_FOUND', path: ['item'] } });
    expect(await edgesOf(adapter, 'category', 'c')).toEqual([]);
    expect(await nodes(adapter, 'item', 'i')).toEqual([]);
  });

  it('ensureNodes creates only the missing endpoints and never overwrites existing data', async () => {
    const adapter = await adapterWithGraph();
    await seed(adapter, node('item', 'i', { title: 'keep me' }));
    const r = await run<Result<undefined>>(adapter, (tx) => applyLink(tx, link({ ensureNodes: true })));
    expect(r.ok).toBe(true);
    expect(await nodes(adapter, 'item', 'i')).toEqual([node('item', 'i', { title: 'keep me' })]);
    expect(await nodes(adapter, 'category', 'c')).toEqual([node('category', 'c')]);
    expect(await edgesOf(adapter, 'item', 'i')).toHaveLength(1);
  });

  it('ensureNodes creates both endpoints when neither exists', async () => {
    const adapter = await adapterWithGraph();
    await run(adapter, (tx) => applyLink(tx, link({ ensureNodes: true })));
    expect(await nodes(adapter, 'item', 'i')).toEqual([node('item', 'i')]);
    expect(await nodes(adapter, 'category', 'c')).toEqual([node('category', 'c')]);
  });

  it('treats an item and a category with the same id as different nodes', async () => {
    const adapter = await adapterWithGraph();
    await seed(adapter, node('item', 'x'), node('category', 'x'));
    await run(adapter, (tx) => applyLink(tx, link({ item: 'x', category: 'x' })));
    expect(await edgesOf(adapter, 'item', 'x')).toEqual([{ item: 'x', category: 'x' }]);
    expect(await edgesOf(adapter, 'category', 'x')).toEqual([{ item: 'x', category: 'x' }]);
  });

  it('is undone with the transaction when a later step throws', async () => {
    const adapter = await adapterWithGraph();
    await expect(
      run(adapter, async (tx) => {
        await applyLink(tx, link({ ensureNodes: true }));
        throw new Error('later op failed');
      }),
    ).rejects.toThrow('later op failed');
    expect(await edgesOf(adapter, 'item', 'i')).toEqual([]);
    expect(await nodes(adapter, 'item', 'i')).toEqual([]);
  });
});

describe('applyUnlink (shell)', () => {
  it('removes the edge from both ends and keeps the nodes and other edges', async () => {
    const adapter = await adapterWithGraph();
    await seed(adapter, node('item', 'i'), node('category', 'c'), node('category', 'd'));
    await run(adapter, async (tx) => {
      await applyLink(tx, link({ category: 'c' }));
      await applyLink(tx, link({ category: 'd' }));
    });
    await run(adapter, (tx) => applyUnlink(tx, unlink('i', 'c')));
    expect((await edgesOf(adapter, 'item', 'i')).map((e) => e.category)).toEqual(['d']);
    expect(await edgesOf(adapter, 'category', 'c')).toEqual([]);
    expect(await nodes(adapter, 'item', 'i')).toHaveLength(1);
    expect(await nodes(adapter, 'category', 'c')).toHaveLength(1);
  });

  it('is a no-op for an edge or nodes that do not exist', async () => {
    const adapter = await adapterWithGraph();
    await seed(adapter, node('item', 'i'), node('category', 'c'));
    await run(adapter, (tx) => applyLink(tx, link()));
    await expect(run(adapter, (tx) => applyUnlink(tx, unlink('ghost', 'c')))).resolves.toBeUndefined();
    await expect(run(adapter, (tx) => applyUnlink(tx, unlink('i', 'ghost')))).resolves.toBeUndefined();
    expect(await edgesOf(adapter, 'item', 'i')).toHaveLength(1);
  });

  it('can be followed by linking the same pair again', async () => {
    const adapter = await adapterWithGraph();
    await seed(adapter, node('item', 'i'), node('category', 'c'));
    await run(adapter, (tx) => applyLink(tx, link({ weight: 1 })));
    await run(adapter, (tx) => applyUnlink(tx, unlink()));
    await run(adapter, (tx) => applyLink(tx, link({ weight: 2 })));
    expect(await edgesOf(adapter, 'category', 'c')).toEqual([{ item: 'i', category: 'c', weight: 2 }]);
  });
});

