import { describe, expect, it } from 'vitest';
import { runAdapterConformance } from '../../testing/index.js';
import type { AdapterTx } from '../../adapter.js';
import { createSqliteAdapter, type SqliteAdapter } from './index.js';

// The whole storage contract, on a private in-memory database per test.
runAdapterConformance(() => createSqliteAdapter(), { describe, it }, { dispose: (adapter) => (adapter as SqliteAdapter).close() });

describe('sqlite adapter: behaviour specific to this implementation', () => {
  it('declares what it can do', () => {
    const adapter = createSqliteAdapter();
    expect(adapter.name).toBe('sqlite');
    expect(adapter.capabilities).toEqual({ transactions: true, idempotency: false, nativeSetQueries: false });
    void adapter.close();
  });

  it('rejects use of a transaction handle after the transaction has finished', async () => {
    const adapter = createSqliteAdapter();
    await adapter.graphs.create('g');
    let leaked!: AdapterTx;
    await adapter.transaction('g', async (tx) => {
      leaked = tx;
    });
    await expect(leaked.putNodes([{ partition: 'item', id: 'late' }])).rejects.toThrow('closed');
    await expect(leaked.edgesOf('item', 'late', { limit: 1, cursor: null })).rejects.toThrow('closed');
    await adapter.close();
  });

  it('rejects a page limit that is not a positive whole number, and a cursor it never gave out', async () => {
    const adapter = createSqliteAdapter();
    await adapter.graphs.create('g');
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(adapter.transaction('g', (tx) => tx.listNodes('item', { limit, cursor: null }))).rejects.toThrow(RangeError);
      await expect(adapter.graphs.list({ limit, cursor: null })).rejects.toThrow(RangeError);
    }
    await expect(adapter.transaction('g', (tx) => tx.listNodes('item', { limit: 1, cursor: 'nonsense' }))).rejects.toThrow(RangeError);
    await expect(adapter.graphs.list({ limit: 1, cursor: 'nonsense' })).rejects.toThrow(RangeError);
    await adapter.close();
  });

  it('rolls back when the callback throws after awaiting other work, and then works again', async () => {
    const adapter = createSqliteAdapter();
    await adapter.graphs.create('g');
    await expect(
      adapter.transaction('g', async (tx) => {
        await tx.putNodes([{ partition: 'item', id: 'a' }]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const ids = await adapter.transaction('g', async (tx) => (await tx.listNodes('item', { limit: 10, cursor: null })).items);
    expect(ids).toEqual([]);
    await adapter.close();
  });

  it('keeps two transactions that await from interleaving: one SQL transaction at a time', async () => {
    const adapter = createSqliteAdapter();
    await adapter.graphs.create('g');
    const order: string[] = [];
    const run = (name: string) =>
      adapter.transaction('g', async (tx) => {
        order.push(`${name} start`);
        await tx.putNodes([{ partition: 'item', id: name }]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`${name} end`);
      });
    await Promise.all([run('a'), run('b')]);
    expect(order).toEqual(['a start', 'a end', 'b start', 'b end']);
    await adapter.close();
  });

  it('a transaction on a missing graph rejects and creates nothing', async () => {
    const adapter = createSqliteAdapter();
    await expect(adapter.transaction('nope', async () => 1)).rejects.toThrow('Graph not found');
    expect(await adapter.graphs.exists('nope')).toBe(false);
    expect((await adapter.graphs.list({ limit: 10, cursor: null })).items).toEqual([]);
    await adapter.close();
  });

  it('close waits for work in progress, is idempotent, and later calls fail with CLOSED', async () => {
    const adapter = createSqliteAdapter();
    await adapter.graphs.create('g');
    const slow = adapter.transaction('g', async (tx) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await tx.putNodes([{ partition: 'item', id: 'a' }]);
      return 'done';
    });
    const closing = adapter.close();
    await expect(slow).resolves.toBe('done');
    await closing;
    await adapter.close();
    await expect(adapter.graphs.exists('g')).rejects.toMatchObject({ code: 'CLOSED' });
    await expect(adapter.transaction('g', async () => 1)).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('batches long id lists under the variable limit', async () => {
    const adapter = createSqliteAdapter();
    await adapter.graphs.create('g');
    const ids = Array.from({ length: 40_000 }, (_, i) => `n${i}`);
    const found = await adapter.transaction('g', async (tx) => {
      await tx.putNodes(ids.slice(0, 3000).map((id) => ({ partition: 'item' as const, id })));
      return tx.getNodes('item', ids);
    });
    expect(found.length).toBe(3000);
    await adapter.close();
  });

  it('a repeated id in one request gives independent copies', async () => {
    const adapter = createSqliteAdapter();
    await adapter.graphs.create('g');
    const [one, two] = await adapter.transaction('g', async (tx) => {
      await tx.putNodes([{ partition: 'item', id: 'a', data: { n: 1 } }]);
      return tx.getNodes('item', ['a', 'a']);
    });
    expect(one).toEqual(two);
    expect(one?.data).not.toBe(two?.data);
    await adapter.close();
  });

  it('refuses to open something that is not a graph database, and says why', () => {
    expect(() => createSqliteAdapter({ path: '/no/such/dir/x.db' })).toThrow(/could not open/);
  });
});
