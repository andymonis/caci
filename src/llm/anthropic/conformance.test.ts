import { describe, it } from 'vitest';
import { runModelClientConformance } from '../testing/index.js';
import { createAnthropicClient } from './client.js';
import { providerFor } from './fake-provider.test-util.js';

// The real client is held to the same contract as the scripted one, over a fake provider that
// speaks the Messages API's HTTP shapes.
runModelClientConformance(
  (scenario) => createAnthropicClient({ apiKey: 'sk-ant-test-key-0001', fetch: providerFor(scenario).fetch }),
  { describe, it },
);
