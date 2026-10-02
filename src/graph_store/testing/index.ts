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
 * `makeAdapter` is called once per test and must return a fresh, empty adapter; use
 * `options.dispose` to clean up whatever it created.
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
            const adapter = await makeAdapter();
            try {
              await testCase.run(adapter);
            } finally {
              await options.dispose?.(adapter);
            }
          });
        }
      });
    }
  });
}
