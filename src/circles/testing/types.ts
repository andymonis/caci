import type { CircleStore } from '../store.js';

/** The two functions of a test runner that the harness needs (Vitest's, Jest's and `node:test`'s fit). */
export interface TestApi {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void> | void): void;
}

export interface ConformanceOptions {
  /** Called after every test with each store it used, e.g. to close a database or delete a temp folder. */
  dispose?: (store: CircleStore) => Promise<void> | void;
  /**
   * Which groups of cases to run; every group by default. A store that does not keep grants yet (R-008) can leave `grants` out,
   * and must not once it does.
   */
  groups?: readonly CaseGroup[];
}

export type CaseGroup = 'core' | 'grants';

/** Creates a fresh, empty store that shares nothing with any other one it has made. Called at least once per test. */
export type MakeCircleStore = () => Promise<CircleStore> | CircleStore;

export interface CircleStoreCase {
  readonly name: string;
  /** `core` (the default) or `grants`. */
  readonly group?: CaseGroup;
  /** Throws (an assertion error) when the store does not behave. `makeAnother` gives a further fresh store. */
  readonly run: (store: CircleStore, makeAnother: () => Promise<CircleStore>) => Promise<void>;
}
