import type { UserStore } from '../store.js';
import { userStoreCases } from './cases.js';
import type { ConformanceOptions, MakeUserStore, TestApi } from './types.js';

export type { ConformanceOptions, MakeUserStore, TestApi, UserStoreCase } from './types.js';

/**
 * Registers the user store conformance suite with your test runner. Every `UserStore` must pass it.
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * runUserStoreConformance(() => createMyUserStore(), { describe, it });
 * ```
 *
 * `makeStore` is called at least once per test (some cases need two) and each call must return a
 * fresh, empty store that shares nothing with the others; use `options.dispose` to clean up.
 */
export function runUserStoreConformance(makeStore: MakeUserStore, testApi: TestApi, options: ConformanceOptions = {}): void {
  testApi.describe('user store conformance', () => {
    for (const testCase of userStoreCases()) {
      testApi.it(testCase.name, async () => {
        const made: UserStore[] = [];
        const makeOne = async (): Promise<UserStore> => {
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
