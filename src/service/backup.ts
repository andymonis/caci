import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { GRAPH_APPLICATION_ID } from '../graph_store/adapters/sqlite/index.js';
import { snapshotDatabase } from '../sqlite/snapshot.js';
import { USERS_APPLICATION_ID } from '../users/sqlite/index.js';

// Snapshots of the two databases (R-010): `npm run backup -- --dest DIR [--keep N]`. A snapshot is a folder named
// by its UTC time that holds `graphs.db` and `users.db`, each a verified `VACUUM INTO` copy made while the service
// runs. Only complete snapshots count. A backup that fails never deletes anything, so a failing night cannot
// shorten the history. The key is not in either database, so it is not in a snapshot.

export interface BackupIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Milliseconds since 1970. Default `Date.now`. */
  readonly now?: () => number;
}

export const BACKUP_USAGE = 'Usage: npm run backup -- --dest DIR [--keep N]   (DIR is outside the data folder; N is how many snapshots to keep, 1 to 1000, default 14)';
export const DEFAULT_KEEP = 14;
export const MAX_KEEP = 1000;
export const SNAPSHOT_FILES = Object.freeze(['graphs.db', 'users.db'] as const);
export const SNAPSHOT_NAME = /^\d{8}T\d{6}Z(?:-\d{1,3})?$/;
export const APPLICATION_IDS: Readonly<Record<(typeof SNAPSHOT_FILES)[number], number>> = Object.freeze({ 'graphs.db': GRAPH_APPLICATION_ID, 'users.db': USERS_APPLICATION_ID });

type Env = Readonly<Record<string, string | undefined>>;

/** The data folder from the environment, as the service reads it (`CACI_DATA_DIR`, default `./data`). */
export function dataDirOf(env: Env): string {
  const given = env['CACI_DATA_DIR'];
  return resolve(given === undefined || given.trim() === '' ? './data' : given);
}

/** `20261011T020000Z` for a time in milliseconds. */
export function snapshotNameAt(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Resolves symbolic links in the part of a path that exists, so a link cannot hide a folder inside another. */
function real(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(existing.slice(dirname(existing).length + 1));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...rest);
}

export function isInside(inner: string, outer: string): boolean {
  const a = real(inner);
  const b = real(outer);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The snapshot folders in `dest` (by name pattern), newest first, with whether each holds both files. */
export function listSnapshots(dest: string): { readonly name: string; readonly complete: boolean }[] {
  if (!isDirectory(dest)) return [];
  return readdirSync(dest)
    .filter((name) => SNAPSHOT_NAME.test(name) && isDirectory(join(dest, name)))
    .sort()
    .reverse()
    .map((name) => ({ name, complete: SNAPSHOT_FILES.every((file) => existsSync(join(dest, name, file))) }));
}

interface Parsed {
  readonly dest: string;
  readonly keep: number;
}

function parseArgs(args: readonly string[]): Parsed | string {
  let dest: string | undefined;
  let keep = DEFAULT_KEEP;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === '--dest') {
      if (value === undefined || value.startsWith('--') || value === '' || dest !== undefined) return '--dest needs one folder';
      dest = value;
      i++;
    } else if (arg === '--keep') {
      if (value === undefined || !/^\d{1,4}$/.test(value)) return '--keep needs a whole number';
      keep = Number(value);
      if (keep < 1 || keep > MAX_KEEP) return `--keep must be from 1 to ${MAX_KEEP}`;
      i++;
    } else {
      return `unknown argument "${String(arg).slice(0, 40)}"`;
    }
  }
  return dest === undefined ? '--dest is required' : { dest, keep };
}

/**
 * Takes a snapshot of both databases in `CACI_DATA_DIR` into `<dest>/<UTC time>/` and then keeps only the newest
 * `keep` complete snapshots. Never creates a database, never writes inside the data folder, never prints a secret.
 *
 * @returns 0 done, 1 could not, 2 wrong arguments
 */
export function backupData(args: readonly string[], env: Env, io: BackupIo): 0 | 1 | 2 {
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') {
    io.stderr(`${parsed}\n${BACKUP_USAGE}\n`);
    return 2;
  }
  const data = dataDirOf(env);
  const dest = resolve(parsed.dest);
  for (const file of SNAPSHOT_FILES) {
    if (!existsSync(join(data, file))) {
      io.stderr(`There is no ${file} in ${data}. Check CACI_DATA_DIR. Nothing was changed.\n`);
      return 1;
    }
  }
  if (isInside(dest, data)) {
    io.stderr(`The destination ${dest} is inside the data folder ${data}. Choose a folder outside it. Nothing was changed.\n`);
    return 1;
  }
  try {
    if (existsSync(dest) && !isDirectory(dest)) {
      io.stderr(`${dest} exists and is not a folder. Nothing was changed.\n`);
      return 1;
    }
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    const base = snapshotNameAt((io.now ?? Date.now)());
    let name = base;
    for (let n = 2; existsSync(join(dest, name)); n++) name = `${base}-${n}`;
    const partial = join(dest, `.${name}.partial`);
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { mode: 0o700 });
    const lines: string[] = [];
    for (const file of SNAPSHOT_FILES) {
      const result = snapshotDatabase(join(data, file), join(partial, file), { applicationIds: [APPLICATION_IDS[file]] });
      if (!result.ok) {
        rmSync(partial, { recursive: true, force: true });
        io.stderr(`The snapshot failed: ${result.reason}. Nothing was removed.\n`);
        return 1;
      }
      lines.push(`  ${file}: ${result.bytes} bytes, schema version ${result.version}`);
    }
    renameSync(partial, join(dest, name));

    // Only now, with a good new snapshot, is anything removed: leftovers of failed runs, incomplete folders, the oldest complete ones.
    for (const entry of readdirSync(dest)) if (/^\..*\.partial$/.test(entry)) rmSync(join(dest, entry), { recursive: true, force: true });
    const snapshots = listSnapshots(dest);
    for (const s of snapshots.filter((x) => !x.complete)) rmSync(join(dest, s.name), { recursive: true, force: true });
    const complete = snapshots.filter((s) => s.complete);
    const removed = complete.slice(parsed.keep);
    for (const s of removed) rmSync(join(dest, s.name), { recursive: true, force: true });
    io.stdout(`Snapshot ${join(dest, name)}\n${lines.join('\n')}\nKept ${Math.min(complete.length, parsed.keep)} snapshot${Math.min(complete.length, parsed.keep) === 1 ? '' : 's'}${removed.length > 0 ? `; removed ${removed.length} older` : ''}.\n`);
    return 0;
  } catch (cause) {
    io.stderr(`The backup failed: ${cause instanceof Error ? cause.message : String(cause)}. Nothing was removed.\n`);
    return 1;
  }
}
