import type { ModelClient } from '../model-client.js';
import { modelClientCases } from './cases.js';
import type { ClientScenario } from './scenarios.js';
import type { MakeClient, ModelClientConformanceOptions, TestApi } from './types.js';

export { createScriptedModelClient } from './scripted-client.js';
export type { Script, ScriptStep, ScriptedModelClient, ScriptedOptions } from './scripted-client.js';
export { scriptFor } from './scenarios.js';
export type { ClientScenario } from './scenarios.js';
export type { MakeClient, ModelClientConformanceOptions, TestApi } from './types.js';
export { modelClientCases };

/**
 * Registers the model-client contract with your test runner. Every `ModelClient` must pass it, so
 * code built on the port behaves the same whichever client is behind it.
 *
 * ```ts
 * runModelClientConformance((scenario) => createMyClient(fakeProviderFor(scenario)), { describe, it });
 * ```
 *
 * The suite cannot make a real provider refuse or hang, so `makeClient` is told which scenario to
 * produce and returns a client whose provider (a mocked HTTP layer, say) behaves that way.
 */
export function runModelClientConformance(makeClient: MakeClient, testApi: TestApi, options: ModelClientConformanceOptions = {}): void {
  testApi.describe('model client conformance', () => {
    for (const testCase of modelClientCases()) {
      testApi.it(testCase.name, async () => {
        const made: ModelClient[] = [];
        const make = async (scenario: ClientScenario): Promise<ModelClient> => {
          const client = await makeClient(scenario);
          made.push(client);
          return client;
        };
        try {
          await testCase.run(make);
        } finally {
          for (const client of made) await options.dispose?.(client);
        }
      });
    }
  });
}
