// Resolutions (R-025): one small private record per person and fact, saying "I have dealt with this". It is a store of its
// own and holds no text. This entry point holds the types, the checks and the reference memory store; the SQLite store is
// `bipartite-graph/resolutions/sqlite` and the shared conformance suite is `bipartite-graph/resolutions/testing`.

export { RESOLUTION_ERROR_CODES, resolutionError } from './errors.js';
export type { ResolutionError, ResolutionErrorCode } from './errors.js';
export { FACT_ID_MAX, MAX_LIST_FOR, MAX_RESOLUTION_PAGE, MAX_RESOLUTIONS_PER_USER } from './types.js';
export type { Resolution, ResolutionPage, ResolutionPageInput, ResolutionScope, ResolvedFact } from './types.js';
export { CIRCLE_ID, checkFactIds, checkKey, checkPage, compareFacts, copyFact, copyResolution, copyScope, isFactId, resolutionProblem, scopeKey, scopeProblem, VERB_NAME } from './validate.js';
export type { Err, Ok, Result } from './result.js';
export type { ResolutionStore } from './store.js';
export { createMemoryResolutionStore } from './memory-store.js';
