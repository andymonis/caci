import { describe, expect, it } from 'vitest';
import { createMemoryResolutionStore } from './memory-store.js';
import type { ResolutionStore } from './store.js';
import { runResolutionStoreConformance, type TestApi } from './testing/index.js';
import { createNaiveResolutionStore, DEFECTS, type Defect } from './testing/naive-store.test-util.js';

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

/** The cases that fail for a store (every case is run, none may hang). */
async function failures(make: () => ResolutionStore): Promise<string[]> {
  const { api, names, bodies } = recordingRunner();
  runResolutionStoreConformance(make, api);
  const failed: string[] = [];
  for (const [i, body] of bodies.entries()) {
    try {
      await body();
    } catch {
      failed.push(names[i] as string);
    }
  }
  return failed;
}

describe('the resolution store conformance suite', () => {
  it('has the cases it should', () => {
    const r = recordingRunner();
    runResolutionStoreConformance(createMemoryResolutionStore, r.api);
    expect(r.names.length).toBeGreaterThanOrEqual(24);
    expect(new Set(r.names).size).toBe(r.names.length);
  });

  it('passes for the memory store', async () => {
    expect(await failures(createMemoryResolutionStore)).toEqual([]);
  });

  it('passes for a plain store with no defect', async () => {
    expect(await failures(() => createNaiveResolutionStore())).toEqual([]);
  });

  it('calls dispose for every store a test used, even when the test fails', async () => {
    const disposed: ResolutionStore[] = [];
    const { api, bodies } = recordingRunner();
    runResolutionStoreConformance(() => createNaiveResolutionStore('no-validation'), api, { dispose: (s) => void disposed.push(s) });
    let failedCount = 0;
    for (const body of bodies) {
      try {
        await body();
      } catch {
        failedCount++;
      }
    }
    expect(failedCount).toBeGreaterThan(0);
    expect(disposed.length).toBeGreaterThanOrEqual(bodies.length);
  });

  describe.each(DEFECTS)('a store with the defect %s', (defect: Defect) => {
    it('is caught by at least one case', async () => {
      const failed = await failures(() => createNaiveResolutionStore(defect));
      expect(failed.length, `${defect} was not caught`).toBeGreaterThan(0);
    });
  });
});
