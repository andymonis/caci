import type { Db } from '../../../sqlite/db.js';
import { prepareSchema, type Migration, type PrepareResult } from '../../../sqlite/prepare.js';

/** The schema version this library writes. Recorded in the file with `PRAGMA user_version`. */
export const SCHEMA_VERSION = 1;

/**
 * A number stored in the file's header (`PRAGMA application_id`) that says "this is a CaCi graph
 * database": the bytes of "CaCi". It lets the library tell its own files from any other SQLite file,
 * and refuse to put tables into someone else's database.
 */
export const APPLICATION_ID = 0x43614369;

/**
 * Version 1. Node ids are BLOB keys (see `keys.ts`). There are deliberately no foreign keys between
 * edges and nodes: the adapter does not check that an edge's ends exist and does not cascade; the
 * core does both (FR-07). The only foreign keys are to `graphs`, so dropping a graph removes
 * everything in it in one statement. `WITHOUT ROWID` stores each table in its primary key's order,
 * which is the listing order.
 */
const V1: Migration = Object.freeze({
  to: 1,
  sql: Object.freeze([
    `CREATE TABLE graphs (
       graph_id TEXT NOT NULL PRIMARY KEY
     ) WITHOUT ROWID`,
    `CREATE TABLE nodes (
       graph_id TEXT NOT NULL REFERENCES graphs (graph_id) ON DELETE CASCADE,
       partition TEXT NOT NULL CHECK (partition IN ('item', 'category')),
       id_key BLOB NOT NULL,
       data TEXT,
       PRIMARY KEY (graph_id, partition, id_key)
     ) WITHOUT ROWID`,
    `CREATE TABLE edges (
       graph_id TEXT NOT NULL REFERENCES graphs (graph_id) ON DELETE CASCADE,
       item_key BLOB NOT NULL,
       category_key BLOB NOT NULL,
       weight REAL,
       data TEXT,
       PRIMARY KEY (graph_id, item_key, category_key)
     ) WITHOUT ROWID`,
    // the same edges seen from the category end, so both directions page by keyset
    'CREATE INDEX edges_by_category ON edges (graph_id, category_key, item_key)',
  ]),
});

export const MIGRATIONS: readonly Migration[] = Object.freeze([V1]);

const TABLES: readonly string[] = Object.freeze(['graphs', 'nodes', 'edges']);

export type { Migration, PrepareResult };

export interface PrepareOptions {
  /** The schema's history, oldest first and with no gaps. Tests supply their own. */
  readonly migrations?: readonly Migration[];
}

/** Makes sure the database is one of ours (a graph database) at the newest schema; see `prepareSchema`. */
export function prepareDatabase(db: Db, options: PrepareOptions = {}): PrepareResult {
  return prepareSchema(db, { applicationId: APPLICATION_ID, migrations: options.migrations ?? MIGRATIONS, tables: TABLES, foreignCode: 'NOT_A_GRAPH_DATABASE' });
}
