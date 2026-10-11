import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { GRAPH_SCHEMA_VERSION } from '../graph_store/adapters/sqlite/index.js';
import { openDb } from '../sqlite/db.js';
import { inspectDatabase } from '../sqlite/snapshot.js';
import { USERS_SCHEMA_VERSION } from '../users/sqlite/index.js';
import { APPLICATION_IDS, dataDirOf, isInside, SNAPSHOT_FILES, snapshotNameAt } from './backup.js';

// Puts a snapshot back (R-010): `npm run restore -- <snapshot folder> --yes`, with the service stopped. Everything
// is checked before the first change; the files being replaced are copied aside first; each file is written
// under a temporary name and renamed into place; stale write-ahead files are removed so they cannot be applied
// to the restored database.

export interface RestoreIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => number;
}

export const RESTORE_USAGE = 'Usage: npm run restore -- <snapshot folder> --yes   (stop the service first; the files being replaced are copied aside)';
const SIDE_FILES = ['', '-wal', '-shm', '-journal'] as const;
const VERSIONS: Readonly<Record<(typeof SNAPSHOT_FILES)[number], number>> = Object.freeze({ 'graphs.db': GRAPH_SCHEMA_VERSION, 'users.db': USERS_SCHEMA_VERSION });

type Env = Readonly<Record<string, string | undefined>>;

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Why the snapshot cannot be used, or `undefined` if both files are good and not newer than this build understands. */
function problemWith(snapshot: string): string | undefined {
  if (!isDirectory(snapshot)) return `${snapshot} is not a folder`;
  for (const file of SNAPSHOT_FILES) {
    const inspected = inspectDatabase(join(snapshot, file), [APPLICATION_IDS[file]]);
    if (!inspected.ok) return inspected.reason;
    if (!inspected.intact) return `${join(snapshot, file)} failed its integrity check`;
    if (inspected.version > VERSIONS[file]) return `${join(snapshot, file)} was written by a newer version (schema ${inspected.version}; this build understands up to ${VERSIONS[file]}). Update the application first`;
  }
  return undefined;
}

/** Whether another connection holds a write lock on a database file (a second line of defence; the service must be stopped). */
function lockedBy(path: string): boolean {
  if (!existsSync(path)) return false;
  let db;
  try {
    db = openDb({ path, busyTimeoutMs: 300 });
    db.begin();
    db.rollback();
    return false;
  } catch {
    return true;
  } finally {
    db?.close();
  }
}

/**
 * Replaces `graphs.db` and `users.db` in `CACI_DATA_DIR` with those of a snapshot.
 *
 * @returns 0 done, 1 could not (nothing replaced unless the message says otherwise), 2 wrong arguments or `--yes` missing
 */
export function restoreData(args: readonly string[], env: Env, io: RestoreIo): 0 | 1 | 2 {
  const positional = args.filter((a) => !a.startsWith('--'));
  const flags = args.filter((a) => a.startsWith('--'));
  if (positional.length !== 1 || positional[0] === '' || flags.some((f) => f !== '--yes') || flags.length > 1) {
    io.stderr(`${RESTORE_USAGE}\n`);
    return 2;
  }
  const snapshot = resolve(positional[0] as string);
  const data = dataDirOf(env);
  if (isInside(snapshot, data)) {
    io.stderr(`The snapshot ${snapshot} is inside the data folder ${data}; it would be replaced while being read. Nothing was changed.\n`);
    return 1;
  }
  const problem = problemWith(snapshot);
  if (problem !== undefined) {
    io.stderr(`The snapshot cannot be used: ${problem}. Nothing was changed.\n`);
    return 1;
  }
  if (!flags.includes('--yes')) {
    io.stderr(`The snapshot ${snapshot} is good. It would replace the databases in ${data}. Stop the service, then run again with --yes. Nothing was changed.\n`);
    return 2;
  }
  for (const file of SNAPSHOT_FILES) {
    if (lockedBy(join(data, file))) {
      io.stderr(`${join(data, file)} is in use. Stop the service first. Nothing was changed.\n`);
      return 1;
    }
  }

  const stamp = snapshotNameAt((io.now ?? Date.now)());
  let aside: string | undefined;
  try {
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const current = SNAPSHOT_FILES.filter((file) => existsSync(join(data, file)));
    if (current.length > 0) {
      let name = `pre-restore-${stamp}`;
      for (let n = 2; existsSync(join(dirname(snapshot), name)); n++) name = `pre-restore-${stamp}-${n}`;
      aside = join(dirname(snapshot), name);
      mkdirSync(aside, { mode: 0o700 });
      for (const file of SNAPSHOT_FILES) {
        for (const side of SIDE_FILES) {
          const from = join(data, file + side);
          if (!existsSync(from)) continue;
          const to = join(aside, file + side);
          closeSync(openSync(to, 'wx', 0o600));
          copyFileSync(from, to);
          chmodSync(to, 0o600);
        }
      }
    }
    // Every replacement is written beside its target first, so a failure here leaves the data as it was.
    for (const file of SNAPSHOT_FILES) {
      const temporary = join(data, `${file}.restoring`);
      rmSync(temporary, { force: true });
      closeSync(openSync(temporary, 'wx', 0o600));
      copyFileSync(join(snapshot, file), temporary);
      chmodSync(temporary, 0o600);
      const check = inspectDatabase(temporary, [APPLICATION_IDS[file]]);
      if (!check.ok || !check.intact) throw new Error(`the copy of ${file} did not verify`);
    }
    for (const file of SNAPSHOT_FILES) for (const side of SIDE_FILES.slice(1)) rmSync(join(data, file + side), { force: true });
    for (const file of SNAPSHOT_FILES) renameSync(join(data, `${file}.restoring`), join(data, file));
  } catch (cause) {
    for (const file of SNAPSHOT_FILES) rmSync(join(data, `${file}.restoring`), { force: true });
    io.stderr(`The restore failed: ${cause instanceof Error ? cause.message : String(cause)}.${aside === undefined ? '' : ` The files that were there are copied in ${aside}.`} Check the data folder before starting the service.\n`);
    return 1;
  }
  io.stdout(`Restored ${basename(snapshot)} into ${data}.${aside === undefined ? '' : `\nThe files that were there are copied in ${aside}.`}\nStart the service again.\n`);
  return 0;
}
