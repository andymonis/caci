// Usage metering (R-024): one record per model attempt, so the operator can see what each account's calls cost. A small store of its
// own; it holds no text. This entry point holds the types, the checks and the reference memory store; the SQLite store is
// `bipartite-graph/usage/sqlite` and the shared conformance suite is `bipartite-graph/usage/testing`.

export { USAGE_ERROR_CODES, usageError } from './errors.js';
export type { UsageError, UsageErrorCode } from './errors.js';
export { LATENCY_MAX, MODEL_MAX, TOKENS_MAX, USAGE_CAPABILITIES, USAGE_RESULTS } from './types.js';
export type { UsageAggregate, UsageCapability, UsageRange, UsageRecord, UsageResult, UsageScope } from './types.js';
export { aggregateRecords, CIRCLE_ID, checkRange, compareAggregates, copyRecord, dayOf, recordProblem, scopeKey, scopeProblem } from './validate.js';
export type { Err, Ok, Result } from './result.js';
export type { UsageStore } from './store.js';
export { createMemoryUsageStore } from './memory-store.js';
