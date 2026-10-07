import type { CircleStore } from '../store.js';
import { circleStoreCases } from './cases.js';
import type { ConformanceOptions, MakeCircleStore, TestApi } from './types.js';

export type { CircleStoreCase, ConformanceOptions, MakeCircleStore, TestApi } from './types.js';

/**
 * Registers the circle store conformance suite with your test runner. Every `CircleStore` must pass it.
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * runCircleStoreConformance(() => createMyCircleStore(), { describe, it });
 * ```
 *
 * `makeStore` is called at least once per test (some cases need two) and each call must return a
 * fresh, empty store that shares nothing with the others; use `options.dispose` to clean up.
 */
export function runCircleStoreConformance(makeStore: MakeCircleStore, testApi: TestApi, options: ConformanceOptions = {}): void {
  testApi.describe('circle store conformance', () => {
    for (const testCase of circleStoreCases()) {
      testApi.it(testCase.name, async () => {
        const made: CircleStore[] = [];
        const makeOne = async (): Promise<CircleStore> => {
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
