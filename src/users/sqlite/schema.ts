import type { Db } from '../../sqlite/db.js';
import { prepareSchema, type Migration, type PrepareResult } from '../../sqlite/prepare.js';

/** The schema version this component writes, recorded with `PRAGMA user_version`. */
export const USERS_SCHEMA_VERSION = 2;

/** "CaUs": says "this is a CaCi user database" in the file header, so it is never mistaken for the graph database (or any other). */
export const USERS_APPLICATION_ID = 0x43615573;

/**
 * Version 1. The username is stored already lower-cased and the database checks it, so a plain
 * `UNIQUE` is a case-insensitive uniqueness without a collation. `WITHOUT ROWID` keeps the table in
 * primary key order.
 */
const V1: Migration = Object.freeze({
  to: 1,
  creates: Object.freeze(['users']),
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

/**
 * Version 2: sessions. Only the SHA-256 of a token is stored. A trigger removes a user's sessions
 * when the user goes, so no store has to remember to; sessions deliberately have no foreign key,
 * so the session store works without a user row (the controller is what knows about users).
 */
const V2: Migration = Object.freeze({
  to: 2,
  creates: Object.freeze(['sessions']),
  sql: Object.freeze([
    `CREATE TABLE sessions (
       token_hash TEXT NOT NULL PRIMARY KEY,
       user_id TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       last_used_at INTEGER NOT NULL
     ) WITHOUT ROWID`,
    'CREATE INDEX sessions_by_user ON sessions (user_id, last_used_at)',
    `CREATE TRIGGER sessions_end_with_user AFTER DELETE ON users
     BEGIN
       DELETE FROM sessions WHERE user_id = old.id;
     END`,
  ]),
});

export const USERS_MIGRATIONS: readonly Migration[] = Object.freeze([V1, V2]);

export function prepareUsersDatabase(db: Db): PrepareResult {
  return prepareSchema(db, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS, foreignCode: 'NOT_A_USERS_DATABASE' });
}
