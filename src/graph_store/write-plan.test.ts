import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from './adapters/memory/index.js';
import type { StorageAdapter } from './adapter.js';
import { planGraphResolution, resolveGraph } from './write-plan.js';

describe('planGraphResolution (pure)', () => {
  it('uses an existing graph as is, whatever createIfMissing says', () => {
    for (const createIfMissing of [false, true]) {
      expect(planGraphResolution({ graphId: 'g', createIfMissing }, true)).toEqual({
        ok: true,
        value: { graphId: 'g', create: false },
      });
    }
  });

  it('fails with GRAPH_NOT_FOUND for a missing graph without createIfMissing (AC-02)', () => {
    expect(planGraphResolution({ graphId: 'C', createIfMissing: false }, false)).toMatchObject({
      ok: false,
      error: { code: 'GRAPH_NOT_FOUND', path: ['graphId'] },
    });
  });

  it('plans to create a missing graph when createIfMissing is true', () => {
    expect(planGraphResolution({ graphId: 'C', createIfMissing: true }, false)).toEqual({
      ok: true,
      value: { graphId: 'C', create: true },
    });
  });

  it('is deterministic and does not touch its input', () => {
    const input = Object.freeze({ graphId: 'g', createIfMissing: true });
    expect(planGraphResolution(input, false)).toEqual(planGraphResolution(input, false));
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
  it('missing graph without createIfMissing: GRAPH_NOT_FOUND and nothing is written (AC-02)', async () => {
    const { adapter, calls } = spied();
    const r = await resolveGraph(adapter, { graphId: 'C', createIfMissing: false });
    expect(r).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND' } });
    expect(calls).toEqual({ create: [], drop: [], transaction: [] });
    expect(await adapter.graphs.exists('C')).toBe(false);
    expect((await adapter.graphs.list({ limit: 10, cursor: null })).items).toEqual([]);
  });

  it('missing graph with createIfMissing: creates it and reports created', async () => {
    const { adapter, calls } = spied();
    const r = await resolveGraph(adapter, { graphId: 'C', createIfMissing: true });
    expect(r).toEqual({ ok: true, value: { created: true } });
    expect(calls.create).toEqual(['C']);
    expect(await adapter.graphs.exists('C')).toBe(true);
  });

  it('existing graph: leaves it alone and reports not created', async () => {
    const { adapter, calls } = spied();
    await adapter.graphs.create('g');
    calls.create.length = 0;
    await adapter.transaction('g', (tx) => tx.putNodes([{ partition: 'item', id: 'a' }]));
    for (const createIfMissing of [false, true]) {
      expect(await resolveGraph(adapter, { graphId: 'g', createIfMissing })).toEqual({
        ok: true,
        value: { created: false },
      });
    }
    expect(calls.create).toEqual([]);
    const kept = await adapter.transaction('g', (tx) => tx.getNodes('item', ['a']));
    expect(kept).toHaveLength(1);
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
    expect(await resolveGraph(failingExists, { graphId: 'g', createIfMissing: true })).toMatchObject({
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
