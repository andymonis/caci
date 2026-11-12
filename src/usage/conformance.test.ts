import { describe, expect, it } from 'vitest';
import { createMemoryUsageStore } from './memory-store.js';
import type { UsageStore } from './store.js';
import { runUsageStoreConformance, type TestApi } from './testing/index.js';
import { createNaiveUsageStore, DEFECTS, type Defect } from './testing/naive-store.test-util.js';

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
async function failures(make: () => UsageStore): Promise<string[]> {
  const { api, names, bodies } = recordingRunner();
  runUsageStoreConformance(make, api);
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

describe('the usage store conformance suite', () => {
  it('has the cases it should', () => {
    const { names } = recordingRunner();
    const r = recordingRunner();
    runUsageStoreConformance(createMemoryUsageStore, r.api);
    expect(r.names.length).toBeGreaterThanOrEqual(25);
    expect(new Set(r.names).size).toBe(r.names.length);
    expect(names).toEqual([]);
  });

  it('passes for the memory store', async () => {
    expect(await failures(createMemoryUsageStore)).toEqual([]);
  });

  it('passes for a plain store with no defect', async () => {
    expect(await failures(() => createNaiveUsageStore())).toEqual([]);
  });

  it('calls dispose for every store a test used, even when the test fails', async () => {
    const disposed: UsageStore[] = [];
    const { api, bodies } = recordingRunner();
    runUsageStoreConformance(() => createNaiveUsageStore('partial-batch'), api, { dispose: (s) => void disposed.push(s) });
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
      const failed = await failures(() => createNaiveUsageStore(defect));
      expect(failed.length, `${defect} was not caught`).toBeGreaterThan(0);
    });
  });
});
