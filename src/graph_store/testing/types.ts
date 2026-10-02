import type { StorageAdapter } from '../adapter.js';

/**
 * The two functions of a test runner that the harness needs. Vitest's, Jest's and
 * `node:test`'s `describe` and `it` all fit, so adapter authors pick their own runner.
 */
export interface TestApi {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void> | void): void;
}

export interface ConformanceOptions {
  /** Called after every test with the adapter it used, e.g. to delete a temp directory. */
  dispose?: (adapter: StorageAdapter) => Promise<void> | void;
}

/**
 * Creates a fresh, empty adapter that shares no state with any other one it has made (e.g. its own
 * temp directory). Called at least once per test, so tests never share state.
 */
export type MakeAdapter = () => Promise<StorageAdapter> | StorageAdapter;

/**
 * One behaviour an adapter must have. Throws (an assertion error) when it does not.
 * `makeAnother` returns a further fresh adapter for cases that need two independent ones;
 * the harness disposes every adapter it hands out.
 */
export interface ConformanceCase {
  readonly name: string;
  readonly run: (adapter: StorageAdapter, makeAnother: () => Promise<StorageAdapter>) => Promise<void>;
}

export interface ConformanceGroup {
  readonly name: string;
  readonly cases: readonly ConformanceCase[];
}
