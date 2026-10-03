// The LLM component's public entry point. It talks to models only through the `ModelClient` port.
// Capabilities (categorise, and later others) live in `capabilities/`, one folder each.

export { CAPABILITIES, createLlmConfig, DEFAULT_ROUTES, DEFAULT_TIERS, MODEL_TIERS, resolveModel } from './config.js';
export type { Capability, CapabilityRoute, LlmConfig, LlmConfigInput, ModelChoice, ModelTier } from './config.js';
export { LLM_ERROR_CODES, llmError } from './errors.js';
export type { LlmError, LlmErrorCode, LlmErrorOptions } from './errors.js';
export type { ModelClient, ModelMessage, ModelOutput, ModelRequest, ModelResponse } from './model-client.js';
export { addUsage, isValidUsage, NO_USAGE, totalTokens } from './usage.js';
export type { TokenUsage } from './usage.js';
