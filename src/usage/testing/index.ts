import type { UsageStore } from '../store.js';
import { usageStoreCases } from './cases.js';
import type { ConformanceOptions, MakeUsageStore, TestApi } from './types.js';

export type { ConformanceOptions, MakeUsageStore, TestApi, UsageStoreCase } from './types.js';

/**
 * Registers the usage store conformance suite with your test runner. Every `UsageStore` must pass it.
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * runUsageStoreConformance(() => createMyUsageStore(), { describe, it });
 * ```
 *
 * `makeStore` is called at least once per test (some cases need two) and each call must return a fresh, empty store that shares
 * nothing with the others; use `options.dispose` to clean up.
 */
export function runUsageStoreConformance(makeStore: MakeUsageStore, testApi: TestApi, options: ConformanceOptions = {}): void {
  testApi.describe('usage store conformance', () => {
    for (const testCase of usageStoreCases()) {
      testApi.it(testCase.name, async () => {
        const made: UsageStore[] = [];
        const makeOne = async (): Promise<UsageStore> => {
          const store = await makeStore();
          made.push(store);
          return store;
        };
        try {
          await testCase.run(await makeOne(), makeOne);
        } finally {
          for (const store of made) await options.dispose?.(store);
        }
      });
    }
  });
}
