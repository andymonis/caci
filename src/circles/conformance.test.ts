import { describe, expect, it } from 'vitest';
import { createMemoryCircleStore } from './memory-store.js';
import type { CircleStore } from './store.js';
import { circleStoreCases } from './testing/cases.js';
import { runCircleStoreConformance, type TestApi } from './testing/index.js';
import { createNaiveCircleStore, DEFECTS, type Defect } from './testing/naive-store.test-util.js';

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
  return { api, names, bodies };
}

/** How many cases fail for a store (every case is run, none may hang). */
async function failures(make: () => CircleStore): Promise<string[]> {
  const { api, names, bodies } = recordingRunner();
  runCircleStoreConformance(make, api);
  const settled = await Promise.allSettled(bodies.map((b) => Promise.resolve().then(b)));
  return settled.flatMap((r, i) => (r.status === 'rejected' ? [names[i] as string] : []));
}

describe('runCircleStoreConformance (the harness itself)', () => {
  it('registers every case under "circle store conformance"', () => {
    const { api, names } = recordingRunner();
    runCircleStoreConformance(() => createMemoryCircleStore(), api);
    expect(names).toEqual(circleStoreCases().map((c) => `circle store conformance > ${c.name}`));
    expect(names.length).toBeGreaterThanOrEqual(40);
  });

  it('makes a fresh store per test and disposes each one, also when a test fails', async () => {
    const made: CircleStore[] = [];
    const disposed: CircleStore[] = [];
    const { api, bodies } = recordingRunner();
    runCircleStoreConformance(
      () => {
        const store = createMemoryCircleStore();
        made.push(store);
        return store;
      },
      api,
      { dispose: (store) => void disposed.push(store) },
    );
    for (const body of bodies) await body();
    expect(new Set(made).size).toBe(made.length);
    expect(disposed).toEqual(made);

    const failing = recordingRunner();
    let disposals = 0;
    runCircleStoreConformance(() => ({ ...createMemoryCircleStore(), getCircle: async () => ({ id: 'x', name: 'x', createdAt: 1, updatedAt: 1 }) }), failing.api, { dispose: () => void disposals++ });
    const results = await Promise.allSettled(failing.bodies.map((b) => b()));
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
    expect(disposals).toBeGreaterThanOrEqual(failing.bodies.length);
  });

  it('has cases with distinct names', () => {
    const names = circleStoreCases().map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the suite catches deliberately broken stores', () => {
  it('a store with no defect passes everything', async () => {
    expect(await failures(() => createNaiveCircleStore())).toEqual([]);
  });

  it.each(DEFECTS.filter((d) => d !== 'shared-state').map((d) => [d] as const))('%s is caught', async (defect: Defect) => {
    expect((await failures(() => createNaiveCircleStore(defect))).length, `nothing caught "${defect}"`).toBeGreaterThan(0);
  });

  it('shared-state is caught (two stores sharing one)', async () => {
    expect((await failures(() => createNaiveCircleStore('shared-state'))).length).toBeGreaterThan(0);
  });
});
