import type { Db } from '../../sqlite/db.js';
import { prepareSchema, type Migration, type PrepareResult } from '../../sqlite/prepare.js';

/** The schema version this component writes, recorded with `PRAGMA user_version`. */
export const USERS_SCHEMA_VERSION = 1;

/** "CaUs": says "this is a CaCi user database" in the file header, so it is never mistaken for the graph database (or any other). */
export const USERS_APPLICATION_ID = 0x43615573;

/**
 * Version 1. The username is stored already lower-cased and the database checks it, so a plain
 * `UNIQUE` is a case-insensitive uniqueness without a collation. `WITHOUT ROWID` keeps the table in
 * primary key order.
 */
const V1: Migration = Object.freeze({
  to: 1,
  sql: Object.freeze([
    `CREATE TABLE users (
       id TEXT NOT NULL PRIMARY KEY,
       username TEXT NOT NULL UNIQUE CHECK (username <> '' AND username = lower(username)),
       display_name TEXT NOT NULL,
       email TEXT,
       role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
       password_hash TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     ) WITHOUT ROWID`,
    'CREATE INDEX users_by_role ON users (role)',
  ]),
});

export const USERS_MIGRATIONS: readonly Migration[] = Object.freeze([V1]);

const TABLES: readonly string[] = Object.freeze(['users']);

export function prepareUsersDatabase(db: Db): PrepareResult {
  return prepareSchema(db, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS, tables: TABLES, foreignCode: 'NOT_A_USERS_DATABASE' });
}
