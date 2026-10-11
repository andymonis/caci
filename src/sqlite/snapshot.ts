import { closeSync, existsSync, openSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { openDb, type Db } from './db.js';

// A consistent copy of a live database (R-010). `VACUUM INTO` reads the source in one read transaction, so a
// writer on another connection (or process) can never leave a half-written state in the copy, and the service
// does not have to stop. The copy is made under a temporary name, opened and checked, and only then renamed to the
// name asked for, so a name that exists is always a complete, verified snapshot.

export interface SnapshotOptions {
  /** The application ids a source may have (a CaCi graph or user database). Anything else is refused and left alone. */
  readonly applicationIds: readonly number[];
  /** How long to wait for a lock on the source. Default 10,000 ms. */
  readonly busyTimeoutMs?: number;
}

export type SnapshotResult =
  | { readonly ok: true; readonly applicationId: number; readonly version: number; readonly bytes: number }
  | { readonly ok: false; readonly reason: string };

const fail = (reason: string): SnapshotResult => ({ ok: false, reason });
const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

interface Facts {
  readonly applicationId: number;
  readonly version: number;
  readonly objects: number;
}

function factsOf(db: Db): Facts {
  return {
    applicationId: Number(db.pragma('application_id')),
    version: Number(db.pragma('user_version')),
    objects: Number(db.get<{ n: number }>('SELECT count(*) AS n FROM sqlite_master')?.n ?? 0),
  };
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // nothing there, or nothing we can do
  }
}

/**
 * Opens a file that must already exist (so that checking a snapshot never creates a database) and reports what it
 * is, or why it is not usable. The caller closes nothing: the connection is closed here.
 */
export function inspectDatabase(path: string, applicationIds: readonly number[], busyTimeoutMs = 10_000): { readonly ok: true; readonly applicationId: number; readonly version: number; readonly intact: boolean } | { readonly ok: false; readonly reason: string } {
  let isFile: boolean;
  try {
    isFile = existsSync(path) && statSync(path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return { ok: false, reason: `"${path}" is not an existing file` };
  let db: Db | undefined;
  try {
    db = openDb({ path, busyTimeoutMs });
    const facts = factsOf(db);
    if (!applicationIds.includes(facts.applicationId)) return { ok: false, reason: `"${path}" is not one of this application's databases` };
    const check = db.pragma('integrity_check');
    return { ok: true, applicationId: facts.applicationId, version: facts.version, intact: check === 'ok' };
  } catch (cause) {
    return { ok: false, reason: `"${path}" could not be read as a database: ${messageOf(cause)}` };
  } finally {
    db?.close();
  }
}

/**
 * Copies `source` to the new file `destination` (its folder must exist; the file must not). The copy is created
 * owner-only (mode 0600) and checked against the source (integrity, application id, schema version, number of
 * objects) before it gets its name; on any failure nothing is left behind.
 */
export function snapshotDatabase(source: string, destination: string, options: SnapshotOptions): SnapshotResult {
  const busyTimeoutMs = options.busyTimeoutMs ?? 10_000;
  if (typeof source !== 'string' || typeof destination !== 'string' || source === '' || destination === '' || source.includes('\0') || destination.includes('\0')) return fail('the source and the destination must be non-empty paths');
  if (existsSync(destination)) return fail(`"${destination}" already exists; a snapshot never overwrites anything`);
  if (!existsSync(dirname(destination))) return fail(`the folder for "${destination}" does not exist`);

  const first = inspectDatabase(source, options.applicationIds, busyTimeoutMs);
  if (!first.ok) return fail(first.reason);

  const temporary = join(dirname(destination), `.${basename(destination)}.partial`);
  removeQuietly(temporary);
  let src: Db | undefined;
  try {
    closeSync(openSync(temporary, 'wx', 0o600)); // owner-only before any byte of the copy is written
    src = openDb({ path: source, busyTimeoutMs });
    const before = factsOf(src);
    src.run('VACUUM INTO ?', temporary);
    src.close();
    src = undefined;

    const copy = inspectDatabase(temporary, options.applicationIds, busyTimeoutMs);
    if (!copy.ok) throw new Error(copy.reason);
    if (!copy.intact) throw new Error('the copy failed its integrity check');
    if (copy.applicationId !== before.applicationId || copy.version !== before.version) throw new Error('the copy does not have the source\'s application id and schema version');
    const check = openDb({ path: temporary });
    let objects: number;
    try {
      objects = factsOf(check).objects;
    } finally {
      check.close();
    }
    if (objects !== before.objects) throw new Error('the copy does not hold the same tables and indexes as the source');
    renameSync(temporary, destination);
    return { ok: true, applicationId: before.applicationId, version: before.version, bytes: statSync(destination).size };
  } catch (cause) {
    src?.close();
    removeQuietly(temporary);
    return fail(`could not snapshot "${source}": ${messageOf(cause)}`);
  }
}
