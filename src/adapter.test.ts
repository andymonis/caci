import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AdapterTx,
  EdgeKey,
  EdgeRecord,
  NodeRecord,
  Page,
  Paged,
  SetClause,
  StorageAdapter,
} from './adapter.js';

const empty = async <T>(): Promise<Paged<T>> => ({ items: [], nextCursor: null });

const tx: AdapterTx = {
  getNodes: async () => [],
  putNodes: async () => {},
  deleteNodes: async () => {},
  putEdges: async () => {},
  deleteEdges: async () => {},
  edgesOf: () => empty<EdgeRecord>(),
  listNodes: () => empty<NodeRecord>(),
};

const stub = {
  name: 'stub',
  capabilities: { transactions: true, idempotency: false, nativeSetQueries: false },
  transaction: (_graphId, fn) => fn(tx),
  graphs: {
    create: async () => {},
    exists: async () => true,
    list: () => empty<string>(),
    drop: async () => {},
  },
} satisfies StorageAdapter;

describe('adapter contract types', () => {
  it('is satisfied by a minimal stub (itemsByCategories is optional)', async () => {
    const adapter: StorageAdapter = stub;
    expect(adapter.name).toBe('stub');
    expect(await adapter.transaction('g', async (t) => (await t.listNodes('item', { limit: 1, cursor: null })).items)).toEqual([]);
  });

  it('has the shapes the spec defines', () => {
    expectTypeOf<Page>().toEqualTypeOf<{ readonly limit: number; readonly cursor: string | null }>();
    expectTypeOf<EdgeRecord>().toExtend<EdgeKey>();
    expectTypeOf<SetClause>().toEqualTypeOf<{
      readonly all?: readonly string[];
      readonly any?: readonly string[];
      readonly none?: readonly string[];
    }>();
    expectTypeOf<AdapterTx['edgesOf']>().returns.resolves.toEqualTypeOf<Paged<EdgeRecord>>();
    expectTypeOf<StorageAdapter['transaction']>().parameter(0).toEqualTypeOf<string>();
  });

  it('rejects incomplete adapters at compile time', () => {
    // @ts-expect-error missing `graphs`
    const incomplete: StorageAdapter = { name: 'x', capabilities: stub.capabilities, transaction: stub.transaction };
    // @ts-expect-error a transaction must implement every required primitive
    const badTx: AdapterTx = { getNodes: tx.getNodes };
    expect([incomplete, badTx]).toHaveLength(2);
  });
});
