// Chooses the store the explorer uses: memory (the default) or, with `--db <file>`, a SQLite file.
// Kept apart from server.mjs so it can be tested without the built library. Local development only.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** The file named by `--db`, `null` if the flag is absent; throws a clear Error if it has no value. */
export function dbPathFrom(argv) {
  const at = argv.indexOf('--db');
  if (at === -1) return null;
  const value = argv[at + 1];
  if (value === undefined || value === '' || value.startsWith('--')) throw new Error('--db needs a file path, for example --db ./data/caci.db');
  return value;
}

/**
 * @returns { adapter, storage, note } where `note` is the sentence to print.
 * Throws an Error whose message says what is wrong; nothing has been started by then.
 */
export function openStorage(lib, argv) {
  const path = dbPathFrom(argv);
  if (path === null) {
    return { adapter: lib.createMemoryAdapter(), storage: { kind: 'memory' }, note: 'Data lives in memory and is lost when this stops.' };
  }
  const file = resolve(path);
  const dir = dirname(file);
  let made = false;
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      made = true;
    }
    const adapter = lib.createSqliteAdapter({ path: file });
    return {
      adapter,
      storage: { kind: 'sqlite', path: file },
      note: `Data is kept in ${file}${made ? ` (created ${dir})` : ''} and is still there after a restart. The file is not encrypted.`,
    };
  } catch (cause) {
    throw new Error(`cannot use the database "${path}": ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
