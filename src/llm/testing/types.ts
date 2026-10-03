import type { ModelClient } from '../model-client.js';
import type { ClientScenario } from './scenarios.js';

/** The two functions of a test runner the suite needs (the same shape as the graph store's suite). */
export interface TestApi {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void> | void): void;
}

/** Makes a client that behaves as the scenario says. Called once per scenario per test. */
export type MakeClient = (scenario: ClientScenario) => Promise<ModelClient> | ModelClient;

export interface ModelClientConformanceOptions {
  /** Called after every test with each client it made, e.g. to restore a patched global. */
  dispose?: (client: ModelClient) => Promise<void> | void;
}

export interface ClientCase {
  readonly name: string;
  readonly run: (make: (scenario: ClientScenario) => Promise<ModelClient>) => Promise<void>;
}
