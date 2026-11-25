import type { ResolutionStore } from '../store.js';
import { resolutionStoreCases } from './cases.js';
import type { ConformanceOptions, MakeResolutionStore, TestApi } from './types.js';

export type { ConformanceOptions, MakeResolutionStore, ResolutionStoreCase, TestApi } from './types.js';

/**
 * Registers the resolution store conformance suite with your test runner. Every `ResolutionStore` must pass it.
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * runResolutionStoreConformance(() => createMyResolutionStore(), { describe, it });
 * ```
 *
 * `makeStore` is called at least once per test and each call must return a fresh, empty store that shares nothing with the
 * others; use `options.dispose` to clean up.
 */
export function runResolutionStoreConformance(makeStore: MakeResolutionStore, testApi: TestApi, options: ConformanceOptions = {}): void {
  testApi.describe('resolution store conformance', () => {
    for (const testCase of resolutionStoreCases()) {
      testApi.it(testCase.name, async () => {
        const made: ResolutionStore[] = [];
        const makeOne = async (): Promise<ResolutionStore> => {
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
