import { describe, expect, it } from 'vitest';
import type { AdapterTx } from '../../adapter.js';
import { createMemoryAdapter } from './index.js';

// The storage contract every adapter must honour (nodes, edges, transactions, paging, graphs) is
// tested once, for all adapters, in the shared conformance suite (testing/primitives-cases.ts and
// friends, run for this adapter in testing/conformance.test.ts). Only what is specific to this
// implementation is tested here.

describe('memory adapter: behaviour specific to this implementation', () => {
  it('declares what it can do', () => {
    const adapter = createMemoryAdapter();
    expect(adapter.name).toBe('memory');
    expect(adapter.capabilities).toEqual({ transactions: true, idempotency: false, nativeSetQueries: false });
  });

  it('rejects use of a transaction handle after the transaction has finished', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    let leaked!: AdapterTx;
    await adapter.transaction('g', async (tx) => {
      leaked = tx;
    });
    await expect(leaked.putNodes([{ partition: 'item', id: 'late' }])).rejects.toThrow('closed');
    await expect(leaked.edgesOf('item', 'late', { limit: 1, cursor: null })).rejects.toThrow('closed');
  });

  it('rejects a page limit that is not a positive whole number', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(adapter.transaction('g', (tx) => tx.listNodes('item', { limit, cursor: null }))).rejects.toThrow(RangeError);
      await expect(adapter.graphs.list({ limit, cursor: null })).rejects.toThrow(RangeError);
    }
  });

  it('orders ids by UTF-16 code unit, so upper case sorts before lower case', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    const listed = await adapter.transaction('g', async (tx) => {
      await tx.putNodes(['b', 'B', 'a', 'A'].map((id) => ({ partition: 'item' as const, id })));
      return (await tx.listNodes('item', { limit: 10, cursor: null })).items.map((n) => n.id);
    });
    expect(listed).toEqual(['A', 'B', 'a', 'b']);
  });

  it('hands out cursors that are opaque strings, not row numbers', async () => {
    const adapter = createMemoryAdapter();
    await adapter.graphs.create('g');
    const page = await adapter.transaction('g', async (tx) => {
      await tx.putNodes(['a', 'b', 'c'].map((id) => ({ partition: 'item' as const, id })));
      return tx.listNodes('item', { limit: 1, cursor: null });
    });
    expect(typeof page.nextCursor).toBe('string');
    expect(page.nextCursor).not.toMatch(/^\d+$/);
  });
});
