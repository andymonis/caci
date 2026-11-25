// The SQLite resolution store. A separate entry point so that `bipartite-graph/resolutions` itself never loads `node:sqlite`. The records
// live in the user database, beside the accounts and the circles, so a trigger can clear them when a person or a circle goes.
export { createSqliteResolutionStore } from './sqlite-store.js';
export type { SqliteResolutionStore, SqliteResolutionStoreOptions } from './sqlite-store.js';
export { DbError } from '../../sqlite/db.js';
export type { DbErrorCode } from '../../sqlite/db.js';
