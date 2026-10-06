import type { SessionOptions, SessionStore } from '../session-store.js';
import type { UserStore } from '../store.js';
import { userStoreCases } from './cases.js';
import { SUITE_OPTIONS, sessionCases } from './session-cases.js';
import type { ConformanceOptions, MakeSessionStore, MakeUserStore, SessionConformanceOptions, TestApi } from './types.js';

export type { ConformanceOptions, MakeSessionStore, MakeUserStore, SessionConformanceOptions, TestApi, UserStoreCase } from './types.js';

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

/**
 * Registers the session store conformance suite with your test runner. Every `SessionStore` must pass it.
 * `makeStore` is called with the settings a case needs (the suite's default is an idle time of 100 s, an
 * absolute lifetime of 1,000 s, renewal every 60 s and three sessions per user) and must return a fresh,
 * empty store each time.
 */
export function runSessionStoreConformance(makeStore: MakeSessionStore, testApi: TestApi, options: SessionConformanceOptions = {}): void {
  testApi.describe('session store conformance', () => {
    for (const testCase of sessionCases()) {
      testApi.it(testCase.name, async () => {
        const made: SessionStore[] = [];
        const makeOne = async (settings: SessionOptions = SUITE_OPTIONS): Promise<SessionStore> => {
          const store = await makeStore(settings);
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
