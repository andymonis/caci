import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from './adapters/memory/index.js';
import type { StorageAdapter } from './adapter.js';
import { planGraphResolution, resolveGraph } from './write-plan.js';

describe('planGraphResolution (pure)', () => {
  it('plans to create atomically when createIfMissing is true', () => {
    expect(planGraphResolution({ graphId: 'C', createIfMissing: true })).toEqual({ graphId: 'C', strategy: 'create-if-missing' });
  });

  it('plans to require the graph otherwise (AC-02)', () => {
    expect(planGraphResolution({ graphId: 'C', createIfMissing: false })).toEqual({ graphId: 'C', strategy: 'require-existing' });
  });

  it('is deterministic and does not touch its input', () => {
    const input = Object.freeze({ graphId: 'g', createIfMissing: true });
    expect(planGraphResolution(input)).toEqual(planGraphResolution(input));
  });
});

/** Memory adapter whose graph-lifecycle and transaction calls are recorded. */
function spied() {
  const real = createMemoryAdapter();
  const calls = { create: [] as string[], drop: [] as string[], transaction: [] as string[] };
  const adapter: StorageAdapter = {
    ...real,
    transaction: (graphId, fn) => {
      calls.transaction.push(graphId);
      return real.transaction(graphId, fn);
    },
    graphs: {
      ...real.graphs,
      create: (id) => {
        calls.create.push(id);
        return real.graphs.create(id);
      },
      drop: (id) => {
        calls.drop.push(id);
        return real.graphs.drop(id);
      },
    },
  };
  return { adapter, calls };
}

describe('resolveGraph (shell)', () => {
  it('missing graph with createIfMissing: creates it and reports created', async () => {
    const { adapter, calls } = spied();
    const r = await resolveGraph(adapter, { graphId: 'C', createIfMissing: true });
    expect(r).toEqual({ ok: true, value: { created: true } });
    expect(calls.create).toEqual(['C']);
    expect(await adapter.graphs.exists('C')).toBe(true);
  });

  it('existing graph: leaves it alone and reports not created', async () => {
    const { adapter } = spied();
    await adapter.graphs.create('g');
    await adapter.transaction('g', (tx) => tx.putNodes([{ partition: 'item', id: 'a' }]));
    for (const createIfMissing of [false, true]) {
      expect(await resolveGraph(adapter, { graphId: 'g', createIfMissing })).toEqual({
        ok: true,
        value: { created: false },
      });
    }
    const kept = await adapter.transaction('g', (tx) => tx.getNodes('item', ['a']));
    expect(kept).toHaveLength(1);
  });

  it('without createIfMissing it only checks, never creates (AC-02)', async () => {
    const { adapter, calls } = spied();
    expect(await resolveGraph(adapter, { graphId: 'C', createIfMissing: false })).toMatchObject({
      ok: false,
      error: { code: 'GRAPH_NOT_FOUND', path: ['graphId'] },
    });
    expect(calls.create).toEqual([]);
    expect(await adapter.graphs.exists('C')).toBe(false);
  });

  it('with createIfMissing it makes one atomic create call and no separate check', async () => {
    const real = createMemoryAdapter();
    const seen: string[] = [];
    const adapter: StorageAdapter = {
      ...real,
      graphs: {
        ...real.graphs,
        exists: (id) => (seen.push(`exists ${id}`), real.graphs.exists(id)),
        create: (id) => (seen.push(`create ${id}`), real.graphs.create(id)),
      },
    };
    await resolveGraph(adapter, { graphId: 'g', createIfMissing: true });
    expect(seen).toEqual(['create g']);
  });

  it('two simultaneous creating writes: exactly one is told it created the graph', async () => {
    const { adapter } = spied();
    const results = await Promise.all(Array.from({ length: 5 }, () => resolveGraph(adapter, { graphId: 'g', createIfMissing: true })));
    expect(results.filter((r) => r.ok && r.value.created)).toHaveLength(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('an adapter that does not say whether it created the graph is a STORAGE_ERROR, not a guess', async () => {
    const real = createMemoryAdapter();
    for (const answer of [undefined, null, 'yes', 1]) {
      const vague = { ...real, graphs: { ...real.graphs, create: async () => answer } } as unknown as StorageAdapter;
      expect(await resolveGraph(vague, { graphId: 'g', createIfMissing: true })).toMatchObject({
        ok: false,
        error: { code: 'STORAGE_ERROR', message: expect.stringContaining('did not say whether it created') },
      });
    }
  });

  it('only touches the named graph', async () => {
    const { adapter } = spied();
    await resolveGraph(adapter, { graphId: 'A', createIfMissing: true });
    expect(await adapter.graphs.exists('B')).toBe(false);
  });

  it('turns adapter failures into STORAGE_ERROR instead of throwing (FR-15)', async () => {
    const real = createMemoryAdapter();
    const failingExists: StorageAdapter = {
      ...real,
      graphs: { ...real.graphs, exists: async () => { throw new Error('disk on fire'); } },
    };
    expect(await resolveGraph(failingExists, { graphId: 'g', createIfMissing: false })).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: expect.stringContaining('disk on fire') },
    });

    const failingCreate: StorageAdapter = {
      ...real,
      graphs: { ...real.graphs, create: async () => { throw 'not an Error object'; } },
    };
    expect(await resolveGraph(failingCreate, { graphId: 'g', createIfMissing: true })).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: expect.stringContaining('not an Error object') },
    });
  });
});
