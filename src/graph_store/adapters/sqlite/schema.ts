import { DbError, type Db } from './db.js';

/** The schema version this library writes. Recorded in the file with `PRAGMA user_version`. */
export const SCHEMA_VERSION = 1;

/**
 * A number stored in the file's header (`PRAGMA application_id`) that says "this is a CaCi graph
 * database": the bytes of "CaCi". It lets the library tell its own files from any other SQLite file,
 * and refuse to put tables into someone else's database.
 */
export const APPLICATION_ID = 0x43614369;

/** One step of the schema's history: the statements that take a database to version `to`. */
export interface Migration {
  readonly to: number;
  readonly sql: readonly string[];
}

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

export interface PrepareResult {
  /** The version the file was at: 0 for a new one. */
  readonly from: number;
  readonly to: number;
}

export interface PrepareOptions {
  /** The schema's history, oldest first and with no gaps. Tests supply their own. */
  readonly migrations?: readonly Migration[];
}

const asNumber = (value: unknown): number => (typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : Number.NaN);

/**
 * Makes sure the database is one of ours at the newest schema, creating or upgrading it if needed.
 * Everything happens inside one write transaction, so a crash or a failing step leaves the file as
 * it was; a second process opening the same new file at the same moment waits and then finds it done.
 *
 * Refuses, without changing the file, a database that is not ours (`NOT_A_GRAPH_DATABASE`) or was
 * written by a newer library (`NEWER_SCHEMA`). Only after that does it switch a file to write-ahead
 * logging, because that setting is stored in the file.
 */
export function prepareDatabase(db: Db, options: PrepareOptions = {}): PrepareResult {
  const migrations = options.migrations ?? MIGRATIONS;
  migrations.forEach((m, i) => {
    if (m.to !== i + 1) throw new Error(`the migrations must be numbered 1, 2, 3... in order; found ${m.to} at position ${i + 1}`);
  });
  const latest = migrations.length;

  let result: PrepareResult;
  db.begin();
  try {
    const applicationId = asNumber(db.pragma('application_id'));
    const version = asNumber(db.pragma('user_version'));
    const tableCount = asNumber(db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")?.n);

    const fresh = applicationId === 0 && version === 0 && tableCount === 0;
    if (!fresh) {
      if (applicationId !== APPLICATION_ID) {
        throw new DbError('NOT_A_GRAPH_DATABASE', `"${db.path}" is a SQLite database that does not belong to this library (application id ${applicationId}); it was left untouched`);
      }
      if (version > latest) {
        throw new DbError('NEWER_SCHEMA', `"${db.path}" was written by a newer version of this library (schema ${version}, this one knows up to ${latest}); it was left untouched`);
      }
      if (version < 1) {
        throw new DbError('NOT_A_GRAPH_DATABASE', `"${db.path}" is marked as ours but has no schema version; it was left untouched`);
      }
      for (const table of TABLES) {
        if (version >= 1 && db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", table) === undefined) {
          throw new DbError('NOT_A_GRAPH_DATABASE', `"${db.path}" is missing its "${table}" table; it was left untouched`);
        }
      }
    }

    const from = fresh ? 0 : version;
    try {
      for (const migration of migrations.filter((m) => m.to > from)) {
        for (const statement of migration.sql) db.exec(statement);
        db.exec(`PRAGMA user_version = ${migration.to}`);
      }
      if (fresh) db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    } catch (cause) {
      if (cause instanceof DbError) throw cause;
      throw new DbError('MIGRATION_FAILED', `could not bring "${db.path}" from schema ${from} to ${latest}: ${cause instanceof Error ? cause.message : String(cause)}; nothing was changed`);
    }
    db.commit();
    result = { from, to: Math.max(from, latest) };
  } catch (cause) {
    if (db.inTransaction) db.rollback();
    throw cause;
  }
  db.useWriteAheadLog();
  return result;
}
