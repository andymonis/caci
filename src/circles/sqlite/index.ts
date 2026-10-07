// The SQLite circle store. A separate entry point so that `bipartite-graph/circles` itself never
// loads `node:sqlite`. Circles live in the user database, beside the accounts.
export { createSqliteCircleStore } from './sqlite-store.js';
export type { SqliteCircleStore, SqliteCircleStoreOptions } from './sqlite-store.js';
export { DbError } from '../../sqlite/db.js';
export type { DbErrorCode } from '../../sqlite/db.js';
