// The change log (R-014): what was added, removed and updated in a brain, for review. A small store of its own; the graph store's
// format is unchanged. This entry point holds the types, the checks and the reference memory store; the SQLite store is
// `bipartite-graph/ledger/sqlite` and the shared conformance suite is `bipartite-graph/ledger/testing`.

export { LEDGER_ERROR_CODES, ledgerError } from './errors.js';
export type { LedgerError, LedgerErrorCode } from './errors.js';
export { LEDGER_ACTIONS, LEDGER_KINDS, SUBJECT_MAX, SUMMARY_MAX, TITLE_MAX } from './types.js';
export type { LedgerAction, LedgerEntry, LedgerKind, LedgerPage, LedgerScope } from './types.js';
export { isLedgerId, LEDGER_ID_PATTERN, newLedgerId } from './ids.js';
export { capText, copyEntry, entryProblem, scopeKey, scopeProblem } from './validate.js';
export type { Err, Ok, Result } from './result.js';
export type { LedgerPageRequest, LedgerStore } from './store.js';
export { createMemoryLedgerStore } from './memory-store.js';
