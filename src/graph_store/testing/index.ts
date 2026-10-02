import type { StorageAdapter } from '../adapter.js';
import { conformanceGroups } from './cases.js';
import type { ConformanceOptions, MakeAdapter, TestApi } from './types.js';

export type { ConformanceOptions, MakeAdapter, TestApi } from './types.js';

/**
 * Registers the adapter conformance suite with your test runner. Every adapter must pass it:
 * the core keeps all graph rules, so adapters behave identically only if they honour this contract.
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * runAdapterConformance(() => createMyAdapter(), { describe, it });
 * ```
 *
 * `makeAdapter` is called at least once per test (some cases need two adapters) and each call must
 * return a fresh, empty adapter that shares nothing with the others; use `options.dispose` to clean
 * up whatever it created.
 */
export function runAdapterConformance(
  makeAdapter: MakeAdapter,
  testApi: TestApi,
  options: ConformanceOptions = {},
): void {
  testApi.describe('adapter conformance', () => {
    for (const group of conformanceGroups()) {
      testApi.describe(group.name, () => {
        for (const testCase of group.cases) {
          testApi.it(testCase.name, async () => {
            const made: StorageAdapter[] = [];
            const makeOne = async (): Promise<StorageAdapter> => {
              const adapter = await makeAdapter();
              made.push(adapter);
              return adapter;
            };
            try {
              await testCase.run(await makeOne(), makeOne);
            } finally {
              for (const adapter of made) await options.dispose?.(adapter);
            }
          });
        }
      });
    }
  });
}
