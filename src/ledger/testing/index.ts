import type { LedgerStore } from '../store.js';
import { ledgerStoreCases } from './cases.js';
import type { ConformanceOptions, MakeLedgerStore, TestApi } from './types.js';

export type { ConformanceOptions, LedgerStoreCase, MakeLedgerStore, TestApi } from './types.js';

/**
 * Registers the ledger store conformance suite with your test runner. Every `LedgerStore` must pass it.
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * runLedgerStoreConformance(() => createMyLedgerStore(), { describe, it });
 * ```
 *
 * `makeStore` is called at least once per test (some cases need two) and each call must return a fresh, empty store that shares
 * nothing with the others; use `options.dispose` to clean up.
 */
export function runLedgerStoreConformance(makeStore: MakeLedgerStore, testApi: TestApi, options: ConformanceOptions = {}): void {
  testApi.describe('ledger store conformance', () => {
    for (const testCase of ledgerStoreCases()) {
      testApi.it(testCase.name, async () => {
        const made: LedgerStore[] = [];
        const makeOne = async (): Promise<LedgerStore> => {
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
