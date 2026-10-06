// The SQLite user store. A separate entry point so that `bipartite-graph/users` itself never loads
// `node:sqlite`.
export { createSqliteUserStore } from './sqlite-store.js';
export type { SqliteUserStore, SqliteUserStoreOptions } from './sqlite-store.js';
export { USERS_APPLICATION_ID, USERS_SCHEMA_VERSION } from './schema.js';
export { DbError } from '../../sqlite/db.js';
export type { DbErrorCode } from '../../sqlite/db.js';
