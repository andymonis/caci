import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../adapters/memory/index.js';
import type { AdapterTx, StorageAdapter } from '../adapter.js';
import { conformanceGroups } from './cases.js';
import type { ConformanceCase } from './types.js';
import { runAdapterConformance, type TestApi } from './index.js';

/** Runs one case the way the harness does: a fresh adapter, plus more from the same factory on request. */
const runCase = async (testCase: ConformanceCase, make: () => StorageAdapter): Promise<void> =>
  testCase.run(make(), async () => make());

// The real thing: the memory adapter must pass the whole suite, run through Vitest itself.
runAdapterConformance(() => createMemoryAdapter(), { describe, it });

/** A runner that records what the harness registers, and can execute it afterwards. */
function recordingRunner() {
  const names: string[] = [];
  const bodies: Array<() => Promise<void> | void> = [];
  const stack: string[] = [];
  const api: TestApi = {
    describe: (name, body) => {
      stack.push(name);
      body();
      stack.pop();
    },
    it: (name, body) => {
      names.push([...stack, name].join(' > '));
      bodies.push(body);
    },
  };
  return {
    api,
    names,
    bodies,
    runAll: async () => { for (const body of bodies) await body(); },
  };
}

describe('runAdapterConformance (the harness itself)', () => {
  it('registers every case under adapter conformance > group > case', () => {
    const { api, names } = recordingRunner();
    runAdapterConformance(() => createMemoryAdapter(), api);
    const expected = conformanceGroups().flatMap((g) => g.cases.map((c) => `adapter conformance > ${g.name} > ${c.name}`));
    expect(names).toEqual(expected);
    expect(names.length).toBeGreaterThanOrEqual(5);
  });

  it('creates a fresh adapter for every test and disposes each one', async () => {
    const made: StorageAdapter[] = [];
    const disposed: StorageAdapter[] = [];
    const { api, names, runAll } = recordingRunner();
    runAdapterConformance(
      () => {
        const adapter = createMemoryAdapter();
        made.push(adapter);
        return adapter;
      },
      api,
      { dispose: (adapter) => void disposed.push(adapter) },
    );
    await runAll();
    expect(made.length).toBeGreaterThanOrEqual(names.length); // some cases ask for a second adapter
    expect(new Set(made).size).toBe(made.length); // never the same adapter twice
    expect(disposed).toEqual(made); // every adapter handed out is disposed
  });

  it('accepts an async factory and an async dispose', async () => {
    let disposals = 0;
    const { api, runAll } = recordingRunner();
    runAdapterConformance(async () => createMemoryAdapter(), api, {
      dispose: async () => {
        disposals += 1;
      },
    });
    await runAll();
    expect(disposals).toBeGreaterThan(0);
  });

  it('disposes after every test, including the ones that fail, and still reports the failure', async () => {
    let disposals = 0;
    let made = 0;
    const runner = recordingRunner();
    runAdapterConformance(
      () => {
        made += 1;
        const real = createMemoryAdapter();
        return { ...real, graphs: { ...real.graphs, exists: async () => true } };
      },
      runner.api,
      { dispose: () => void (disposals += 1) },
    );

    let failures = 0;
    for (const body of runner.bodies) {
      try {
        await body();
      } catch {
        failures += 1;
      }
    }
    expect(failures).toBeGreaterThan(0);
    expect(disposals).toBe(made); // every adapter made is disposed, whether its test passed or failed
    expect(made).toBeGreaterThanOrEqual(runner.bodies.length);
  });
});

/** The memory adapter with one behaviour broken. The suite must notice each of these. */
function brokenAdapters(): Array<[string, () => StorageAdapter]> {
  const wrapTx = (real: StorageAdapter, patch: (tx: AdapterTx) => Partial<AdapterTx>): StorageAdapter => ({
    ...real,
    transaction: (graphId, fn) => real.transaction(graphId, (tx) => fn({ ...tx, ...patch(tx) })),
  });
  return [
    ['graphs.exists always says yes', () => {
      const r = createMemoryAdapter();
      return { ...r, graphs: { ...r.graphs, exists: async () => true } };
    }],
    ['graphs.drop does nothing', () => {
      const r = createMemoryAdapter();
      return { ...r, graphs: { ...r.graphs, drop: async () => {} } };
    }],
    ['graphs.list is always empty', () => {
      const r = createMemoryAdapter();
      return { ...r, graphs: { ...r.graphs, list: async () => ({ items: [], nextCursor: null }) } };
    }],
    ['putNodes silently stores nothing', () => wrapTx(createMemoryAdapter(), () => ({ putNodes: async () => {} }))],
    ['getNodes finds nothing', () => wrapTx(createMemoryAdapter(), () => ({ getNodes: async () => [] }))],
    ['edgesOf from a category finds nothing', () =>
      wrapTx(createMemoryAdapter(), (tx) => ({
        edgesOf: (p, id, page) => (p === 'category' ? Promise.resolve({ items: [], nextCursor: null }) : tx.edgesOf(p, id, page)),
      }))],
    ['a failed transaction still commits', () => {
      const real = createMemoryAdapter();
      return {
        ...real,
        transaction: async (graphId, fn) => {
          let failure: unknown;
          const result = await real.transaction(graphId, async (tx) => {
            try {
              return await fn(tx);
            } catch (error) {
              failure = error; // swallow, so the adapter commits the partial work
              return undefined as never;
            }
          });
          if (failure !== undefined) throw failure;
          return result;
        },
      };
    }],
    ['capabilities are not booleans', () => ({ ...createMemoryAdapter(), capabilities: { transactions: 'yes' } as never })],
    ['an empty name', () => ({ ...createMemoryAdapter(), name: '' })],
  ];
}

/**
 * Adapters whose primitives look fine to the smoke group but break write behaviour. Each must be
 * caught by the named AC case, which shows the write group adds detection the smoke group lacks.
 */
function brokenForWrite(): Array<[string, RegExp, () => StorageAdapter]> {
  const wrapTx = (patch: (tx: AdapterTx) => Partial<AdapterTx>): StorageAdapter => {
    const real = createMemoryAdapter();
    return { ...real, transaction: (graphId, fn) => real.transaction(graphId, (tx) => fn({ ...tx, ...patch(tx) })) };
  };
  return [
    ['deleteEdges does nothing, so deleting a node leaves orphan edges', /AC-05/, () => wrapTx(() => ({ deleteEdges: async () => {} }))],
    ['putEdges keeps the first edge instead of replacing it', /AC-06/, () =>
      wrapTx((tx) => ({
        putEdges: async (edges) => {
          const fresh: typeof edges = [];
          for (const e of edges) {
            const existing = (await tx.edgesOf('item', e.item, { limit: 1000, cursor: null })).items;
            if (!existing.some((x) => x.category === e.category)) fresh.push(e);
          }
          await tx.putEdges(fresh);
        },
      }))],
    ['graphs.drop does nothing, so a failed create-if-missing leaves a graph behind', /AC-04/, () => {
      const r = createMemoryAdapter();
      return { ...r, graphs: { ...r.graphs, drop: async () => {} } };
    }],
  ];
}

describe('the write group catches write-specific adapter bugs', () => {
  it.each(brokenForWrite())('%s', async (_name, expected, makeBroken) => {
    const failed: string[] = [];
    for (const testCase of conformanceGroups().find((g) => g.name === 'write')?.cases ?? []) {
      try {
        await runCase(testCase, makeBroken);
      } catch {
        failed.push(testCase.name);
      }
    }
    expect(failed.some((name) => expected.test(name))).toBe(true);
  });

  it('the smoke group alone would miss the deleteEdges bug', async () => {
    const smoke = conformanceGroups().find((g) => g.name === 'smoke')?.cases ?? [];
    const noDeleteEdges = (): StorageAdapter => {
      const real = createMemoryAdapter(); // fresh per case, like the harness
      return { ...real, transaction: (graphId, fn) => real.transaction(graphId, (tx) => fn({ ...tx, deleteEdges: async () => {} })) };
    };
    for (const testCase of smoke) await expect(runCase(testCase, noDeleteEdges)).resolves.toBeUndefined();
  });
});

describe('the isolation group catches adapters that leak', () => {
  const isolation = () => conformanceGroups().find((g) => g.name === 'isolation')?.cases ?? [];

  /** Every graph id maps onto one shared inner graph, so graphs see each other's data. */
  const oneStoreForAllGraphs = (): StorageAdapter => {
    const real = createMemoryAdapter();
    const ids = new Set<string>();
    return {
      ...real,
      graphs: {
        exists: async (id) => ids.has(id),
        create: async (id) => {
          ids.add(id);
          await real.graphs.create('shared');
        },
        drop: async (id) => void ids.delete(id),
        list: async () => ({ items: [...ids].sort(), nextCursor: null }),
      },
      transaction: (_graphId, fn) => real.transaction('shared', fn),
    };
  };

  it('catches graphs that share one store (AC-01)', async () => {
    const failed: string[] = [];
    for (const testCase of isolation()) {
      try {
        await runCase(testCase, oneStoreForAllGraphs);
      } catch {
        failed.push(testCase.name);
      }
    }
    expect(failed.some((n) => n.startsWith('AC-01'))).toBe(true);
  });

  it('catches a factory that hands out the same adapter every time (AC-12)', async () => {
    const shared = createMemoryAdapter();
    const failed: string[] = [];
    for (const testCase of isolation().filter((c) => c.name.startsWith('AC-12'))) {
      try {
        await runCase(testCase, () => shared);
      } catch {
        failed.push(testCase.name);
      }
    }
    expect(failed.length).toBeGreaterThan(0);
  });

  it('passes every isolation case on the memory adapter', async () => {
    for (const testCase of isolation()) await expect(runCase(testCase, createMemoryAdapter)).resolves.toBeUndefined();
  });
});

describe('the suite catches broken adapters', () => {
  it.each(brokenAdapters())('%s', async (_name, makeBroken) => {
    const failures: string[] = [];
    for (const group of conformanceGroups()) {
      for (const testCase of group.cases) {
        try {
          await runCase(testCase, makeBroken);
        } catch {
          failures.push(testCase.name);
        }
      }
    }
    expect(failures.length).toBeGreaterThan(0);
  });

  it('passes every case on the unbroken memory adapter', async () => {
    for (const group of conformanceGroups()) {
      for (const testCase of group.cases) await expect(runCase(testCase, createMemoryAdapter)).resolves.toBeUndefined();
    }
  });
});
