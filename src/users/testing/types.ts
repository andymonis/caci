import type { UserStore } from '../store.js';

/** The two functions of a test runner that the harness needs (Vitest's, Jest's and `node:test`'s fit). */
export interface TestApi {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void> | void): void;
}

export interface ConformanceOptions {
  /** Called after every test with each store it used, e.g. to close a database or delete a temp folder. */
  dispose?: (store: UserStore) => Promise<void> | void;
}

/** Creates a fresh, empty store that shares nothing with any other one it has made. Called at least once per test. */
export type MakeUserStore = () => Promise<UserStore> | UserStore;

export interface UserStoreCase {
  readonly name: string;
  /** Throws (an assertion error) when the store does not behave. `makeAnother` gives a further fresh store. */
  readonly run: (store: UserStore, makeAnother: () => Promise<UserStore>) => Promise<void>;
}
