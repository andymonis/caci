import { createLlmConfig, type LlmConfig } from './config.js';
import { categorise, type CategoriseInput, type CategoriseOptions, type Proposal } from './capabilities/categorise/index.js';
import type { LlmError } from './errors.js';
import type { ModelClient } from './model-client.js';
import type { Result } from '../graph_store/index.js';

export interface LlmInit {
  /** The only way the component reaches a model. */
  readonly client: ModelClient;
  /** Which model each capability uses; from `createLlmConfig`. Defaults to the built-in routes. */
  readonly config?: LlmConfig;
  /** The clock in milliseconds, for tests. */
  readonly now?: () => number;
}

/** The LLM component: one method per capability. New capabilities are added here without changing the others. */
export interface Llm {
  /** Suggests how to file one note, as a proposal to preview. Writes nothing. */
  categorise(input: CategoriseInput, options?: CategoriseOptions): Promise<Result<Proposal, LlmError>>;
}

/**
 * Builds the component around a model client. A missing client or a malformed config is a coding
 * mistake and throws a `TypeError`, like `createGraphClient`; every call afterwards returns a result.
 */
export function createLlm(init: LlmInit): Llm {
  if (typeof init !== 'object' || init === null || typeof init.client?.complete !== 'function') {
    throw new TypeError('createLlm: `client` must be a ModelClient with a complete() method');
  }
  let config = init.config;
  if (config === undefined) {
    const defaults = createLlmConfig();
    if (!defaults.ok) throw new TypeError(`createLlm: ${defaults.error.message}`);
    config = defaults.value;
  }
  const deps = { client: init.client, config, now: init.now ?? Date.now };
  return Object.freeze({ categorise: (input: CategoriseInput, options?: CategoriseOptions) => categorise(deps, input, options) });
}
