import assert from 'node:assert/strict';
import type { EdgeRecord, NodeRecord, StorageAdapter } from '../adapter.js';
import { write } from '../endpoints.js';

export const mutation = (ops: unknown[], extra: object = {}) => ({ version: 1, kind: 'mutation', graphId: 'g', ops, ...extra });
export const upsert = (partition: 'item' | 'category', id: string, data?: object) => ({
  op: 'upsertNode',
  partition,
  id,
  ...(data === undefined ? {} : { data }),
});
export const link = (item: string, category: string, extra: object = {}) => ({ op: 'link', item, category, ...extra });
export const page = { limit: 1000, cursor: null };

export interface Snapshot {
  items: NodeRecord[];
  categories: NodeRecord[];
  /** Edges found by walking from the items. */
  edgesFromItems: EdgeRecord[];
  /** Edges found by walking from the categories. A dangling edge shows up in only one of the two. */
  edgesFromCategories: EdgeRecord[];
}

export const byKey = (a: EdgeRecord, b: EdgeRecord): number => `${a.item}\u0000${a.category}`.localeCompare(`${b.item}\u0000${b.category}`);

/** Everything stored in a graph, read through the adapter's own primitives. */
export async function snapshot(adapter: StorageAdapter, graphId = 'g'): Promise<Snapshot> {
  return adapter.transaction(graphId, async (tx) => {
    const items = [...(await tx.listNodes('item', page)).items];
    const categories = [...(await tx.listNodes('category', page)).items];
    const edgesFromItems: EdgeRecord[] = [];
    for (const item of items) edgesFromItems.push(...(await tx.edgesOf('item', item.id, page)).items);
    const edgesFromCategories: EdgeRecord[] = [];
    for (const category of categories) edgesFromCategories.push(...(await tx.edgesOf('category', category.id, page)).items);
    return {
      items,
      categories,
      edgesFromItems: edgesFromItems.sort(byKey),
      edgesFromCategories: edgesFromCategories.sort(byKey),
    };
  });
}

/** Edges whose item or category node no longer exists. */
export function danglingEdges(s: Snapshot): EdgeRecord[] {
  const items = new Set(s.items.map((n) => n.id));
  const categories = new Set(s.categories.map((n) => n.id));
  return [...s.edgesFromItems, ...s.edgesFromCategories].filter((e) => !items.has(e.item) || !categories.has(e.category));
}

export async function seed(adapter: StorageAdapter): Promise<void> {
  const r = await write(
    adapter,
    mutation(
      [
        upsert('item', 'n1', { title: 'one' }),
        upsert('item', 'n2'),
        upsert('item', 'n3'),
        upsert('category', 'work', { label: 'Work' }),
        upsert('category', 'home'),
        link('n1', 'work', { weight: 2 }),
        link('n2', 'work'),
        link('n3', 'work'),
        link('n1', 'home'),
      ],
      { createIfMissing: true },
    ),
  );
  assert.equal(r.ok, true, 'seeding the graph should succeed');
}

/** Wraps an adapter and records every property read, so a test can prove it was never used. */
export function watch(adapter: StorageAdapter): { adapter: StorageAdapter; touched: string[] } {
  const touched: string[] = [];
  const proxy = new Proxy(adapter, {
    get(target, prop, receiver) {
      touched.push(String(prop));
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return { adapter: proxy, touched };
}

