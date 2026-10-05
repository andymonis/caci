/**
 * The only file in the project that imports `node:sqlite`. Everything else in the SQLite adapter
 * talks to this small wrapper, so that moving to another driver later (for example `better-sqlite3`)
 * is a change to this file alone. `node:sqlite` is built into Node 22.13 and later and is still
 * marked experimental: it prints an `ExperimentalWarning` the first time it is loaded.
 */
import { closeSync, existsSync, openSync } from 'node:fs';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';

export type SqlValue = SQLInputValue;
export type SqlOutput = SQLOutputValue;

export type DbErrorCode =
  /** `node:sqlite` is not available (Node older than 22.13). */
  | 'DRIVER_UNAVAILABLE'
  /** The file could not be opened (missing directory, a directory, no permission...). */
  | 'OPEN_FAILED'
  /** The file exists but is not a SQLite database. It has not been changed. */
  | 'NOT_A_DATABASE'
  /** A SQLite database, but not one of ours (or an incomplete one). It has not been changed. */
  | 'NOT_A_GRAPH_DATABASE'
  /** One of ours, written by a newer version of the library. It has not been changed. */
  | 'NEWER_SCHEMA'
  | 'MIGRATION_FAILED'
  | 'CLOSED';

/** A problem with the database as a whole, as opposed to one statement failing. */
export class DbError extends Error {
  readonly code: DbErrorCode;
  constructor(code: DbErrorCode, message: string) {
    super(message);
    this.name = 'DbError';
    this.code = code;
  }
}

type Driver = { readonly ok: true; readonly DatabaseSync: typeof DatabaseSync } | { readonly ok: false; readonly reason: string };

async function loadDriver(): Promise<Driver> {
  try {
    const sqlite = await import('node:sqlite');
    return { ok: true, DatabaseSync: sqlite.DatabaseSync };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

// Loaded once when this module is first imported. If it fails, importing still works and `openDb`
// explains what is wrong, so only the SQLite adapter's own users are affected.
const driver = await loadDriver();

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const MAX_BUSY_TIMEOUT_MS = 600_000;
const SQLITE_NOTADB = 26;
const MAX_CACHED_STATEMENTS = 128;

export interface OpenOptions {
  /** A file path, or `:memory:` (the default) for a database that lives only as long as the connection. */
  readonly path?: string;
  /** How long a statement waits for another connection's lock before failing. Default 5,000 ms. */
  readonly busyTimeoutMs?: number;
}

export interface Db {
  readonly path: string;
  readonly isOpen: boolean;
  readonly inTransaction: boolean;
  /** How many prepared statements are cached (for tests). */
  readonly statementCount: number;
  /** Runs SQL that returns no rows and takes no parameters (several statements are fine). */
  exec(sql: string): void;
  /** Runs one statement and returns how many rows it changed. */
  run(sql: string, ...params: readonly SqlValue[]): number;
  get<T>(sql: string, ...params: readonly SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: readonly SqlValue[]): T[];
  /** `BEGIN IMMEDIATE`: takes the write lock now, so a transaction cannot fail half way for want of it. */
  begin(): void;
  commit(): void;
  rollback(): void;
  /** Reads a pragma's value (name letters and underscores only). */
  pragma(name: string): SqlOutput | undefined;
  /** Switches a file database to write-ahead logging (a persistent setting). A no-op in memory. */
  useWriteAheadLog(): void;
  /** Idempotent. Rolls back anything still open. */
  close(): void;
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * `node:sqlite` binds a zero-length byte array as NULL, which would silently turn an empty key into
 * "no value" (and make every comparison with it NULL). Refuse it loudly instead; keys are never empty
 * (see `keys.ts`).
 */
function checkParams(params: readonly SqlValue[]): void {
  for (const param of params) {
    if (ArrayBuffer.isView(param) && param.byteLength === 0) {
      throw new Error('an empty byte array cannot be bound as a parameter: node:sqlite would store it as NULL');
    }
  }
}

/**
 * A new database file holds the owner's notes in plain text, so it is created readable and writable
 * by its owner only (mode 0600, narrowed further by the umask; ignored on Windows). SQLite gives the
 * `-wal` and `-shm` files the same mode. A file that already exists is never touched here.
 */
function createOwnerOnly(path: string): void {
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (cause) {
    if ((cause as { code?: string }).code === 'EEXIST') return; // someone else created it a moment ago: use theirs
    throw new DbError('OPEN_FAILED', `could not create the database at "${path}": ${messageOf(cause)}`);
  }
}

/**
 * Opens a connection. It only reads at first, so a file that is not a SQLite database is refused
 * without being changed; settings that write to the file come later (`useWriteAheadLog`), after the
 * schema code has decided the file is ours. Per-connection settings (the busy timeout, foreign keys)
 * are applied here.
 */
export function openDb(options: OpenOptions = {}): Db {
  if (!driver.ok) {
    throw new DbError('DRIVER_UNAVAILABLE', `the SQLite adapter needs Node 22.13 or later, because it uses the built-in node:sqlite (${driver.reason})`);
  }
  const path = options.path ?? ':memory:';
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (typeof path !== 'string' || path === '' || path.includes('\0')) throw new DbError('OPEN_FAILED', 'the database path must be a non-empty text without NUL characters');
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
    throw new DbError('OPEN_FAILED', `busyTimeoutMs must be a whole number from 0 to ${MAX_BUSY_TIMEOUT_MS}`);
  }

  if (path !== ':memory:' && !existsSync(path)) createOwnerOnly(path);

  let raw: DatabaseSync;
  try {
    raw = new driver.DatabaseSync(path);
  } catch (cause) {
    throw new DbError('OPEN_FAILED', `could not open the database at "${path}": ${messageOf(cause)}`);
  }
  try {
    raw.prepare('SELECT count(*) AS n FROM sqlite_master').get(); // reads the file header; fails for a file that is not a database
  } catch (cause) {
    raw.close();
    const code = (cause as { errcode?: number }).errcode === SQLITE_NOTADB || /not a database/i.test(messageOf(cause)) ? 'NOT_A_DATABASE' : 'OPEN_FAILED';
    throw new DbError(code, `"${path}" ${code === 'NOT_A_DATABASE' ? 'is not a SQLite database' : 'could not be read'}: ${messageOf(cause)}`);
  }
  raw.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  raw.exec('PRAGMA foreign_keys = ON');

  const cache = new Map<string, StatementSync>();
  let open = true;

  const ensureOpen = (): DatabaseSync => {
    if (!open) throw new DbError('CLOSED', 'the database is closed');
    return raw;
  };
  const statement = (sql: string): StatementSync => {
    const found = cache.get(sql);
    if (found !== undefined) return found;
    if (cache.size >= MAX_CACHED_STATEMENTS) cache.clear();
    const made = ensureOpen().prepare(sql);
    cache.set(sql, made);
    return made;
  };

  return {
    path,
    get isOpen() {
      return open;
    },
    get inTransaction() {
      return open && raw.isTransaction;
    },
    get statementCount() {
      return cache.size;
    },
    exec: (sql) => ensureOpen().exec(sql),
    run: (sql, ...params) => (checkParams(params), Number(statement(sql).run(...params).changes)),
    get: <T>(sql: string, ...params: readonly SqlValue[]) => (checkParams(params), statement(sql).get(...params) as T | undefined),
    all: <T>(sql: string, ...params: readonly SqlValue[]) => (checkParams(params), statement(sql).all(...params) as T[]),
    begin: () => {
      if (ensureOpen().isTransaction) throw new Error('a transaction is already open on this connection');
      raw.exec('BEGIN IMMEDIATE');
    },
    commit: () => ensureOpen().exec('COMMIT'),
    rollback: () => ensureOpen().exec('ROLLBACK'),
    pragma: (name) => {
      if (!/^[a-z_]+$/.test(name)) throw new Error(`not a pragma name: ${name}`);
      const row = statement(`PRAGMA ${name}`).get() as Record<string, SqlOutput> | undefined;
      return row === undefined ? undefined : Object.values(row)[0];
    },
    useWriteAheadLog: () => {
      if (path !== ':memory:') {
        ensureOpen().exec('PRAGMA journal_mode = WAL');
        raw.exec('PRAGMA synchronous = NORMAL'); // safe with write-ahead logging, and much faster
      }
    },
    close: () => {
      if (!open) return;
      try {
        if (raw.isTransaction) raw.exec('ROLLBACK');
      } finally {
        open = false;
        cache.clear();
        raw.close();
      }
    },
  };
}
