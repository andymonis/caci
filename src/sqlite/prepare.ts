import { DbError, type Db, type DbErrorCode } from './db.js';

/** One step of a schema's history: the statements that take a database to version `to`. */
export interface Migration {
  readonly to: number;
  readonly sql: readonly string[];
}

export interface PrepareResult {
  /** The version the file was at: 0 for a new one. */
  readonly from: number;
  readonly to: number;
}

export interface SchemaSpec {
  /** Stored in the file's header (`PRAGMA application_id`): says "this file is ours" and tells our databases apart. */
  readonly applicationId: number;
  /** The schema's history, oldest first and with no gaps. */
  readonly migrations: readonly Migration[];
  /** Tables that must exist in a database of ours (a file missing one is refused). */
  readonly tables: readonly string[];
  /** The error code for a database that is not ours. */
  readonly foreignCode: DbErrorCode;
}

const asNumber = (value: unknown): number => (typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : Number.NaN);

/**
 * Makes sure the database is one of ours at the newest schema, creating or upgrading it if needed.
 * Everything happens inside one write transaction, so a crash or a failing step leaves the file as
 * it was; a second process opening the same new file at the same moment waits and then finds it done.
 *
 * Refuses, without changing the file, a database that is not ours (`spec.foreignCode`) or was
 * written by a newer version (`NEWER_SCHEMA`). Only after that does it switch a file to write-ahead
 * logging, because that setting is stored in the file.
 */
export function prepareSchema(db: Db, spec: SchemaSpec): PrepareResult {
  const { migrations, applicationId: ours } = spec;
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
      if (applicationId !== ours) {
        throw new DbError(spec.foreignCode, `"${db.path}" is a SQLite database that does not belong to this library (application id ${applicationId}); it was left untouched`);
      }
      if (version > latest) {
        throw new DbError('NEWER_SCHEMA', `"${db.path}" was written by a newer version of this library (schema ${version}, this one knows up to ${latest}); it was left untouched`);
      }
      if (version < 1) {
        throw new DbError(spec.foreignCode, `"${db.path}" is marked as ours but has no schema version; it was left untouched`);
      }
      for (const table of spec.tables) {
        if (db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", table) === undefined) {
          throw new DbError(spec.foreignCode, `"${db.path}" is missing its "${table}" table; it was left untouched`);
        }
      }
    }

    const from = fresh ? 0 : version;
    try {
      for (const migration of migrations.filter((m) => m.to > from)) {
        for (const statement of migration.sql) db.exec(statement);
        db.exec(`PRAGMA user_version = ${migration.to}`);
      }
      if (fresh) db.exec(`PRAGMA application_id = ${ours}`);
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
