// The Anthropic model client. This entry point is the only place in the package that depends on
// `@anthropic-ai/sdk`; the graph store, the rest of the LLM component and the application never import it.

export { ANTHROPIC_KEY_VARIABLE, createAnthropicClient, readAnthropicKey } from './client.js';
export type { AnthropicClientOptions } from './client.js';
export { toProviderSchema } from './schema.js';
