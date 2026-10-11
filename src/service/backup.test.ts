import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js';
import { openDb } from '../sqlite/db.js';
import { createSqliteUserStore } from '../users/sqlite/index.js';
import { backupData, dataDirOf, DEFAULT_KEEP, isInside, listSnapshots, snapshotNameAt } from './backup.js';
import { startService } from './service.js';
import { baseConfig } from './service.test-util.js';

const dirs: string[] = [];
const folder = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'caci-backup-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A data folder with real, empty graph and user databases. */
async function dataFolder(): Promise<string> {
  const data = join(folder(), 'data');
  mkdirSync(data, { mode: 0o700 });
  const graphs = createSqliteAdapter({ path: join(data, 'graphs.db') });
  await graphs.graphs.create('g1');
  await graphs.close();
  createSqliteUserStore({ path: join(data, 'users.db') }).close();
  return data;
}
function run(args: string[], env: Record<string, string | undefined>, now = Date.UTC(2026, 9, 11, 2, 0, 0)) {
  const out: string[] = [];
  const err: string[] = [];
  const code = backupData(args, env, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), now: () => now });
  return { code, out: out.join(''), err: err.join('') };
}
const mode = (p: string): number => statSync(p).mode & 0o777;
const count = (path: string, table: string): number => {
  const db = openDb({ path });
  try {
    return Number(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n);
  } finally {
    db.close();
  }
};
const names = (dest: string): string[] => readdirSync(dest).sort();

describe('a backup', () => {
  it('makes a folder named by UTC time with both databases, owner-only, and says what it did', async () => {
    const data = await dataFolder();
    const dest = join(folder(), 'backups');
    const r = run(['--dest', dest], { CACI_DATA_DIR: data });
    expect(r.code).toBe(0);
    expect(names(dest)).toEqual(['20261011T020000Z']);
    const snap = join(dest, '20261011T020000Z');
    expect(names(snap)).toEqual(['graphs.db', 'users.db']);
    if (process.platform !== 'win32') {
      expect(mode(dest)).toBe(0o700);
      expect(mode(snap)).toBe(0o700);
      expect(mode(join(snap, 'graphs.db'))).toBe(0o600);
      expect(mode(join(snap, 'users.db'))).toBe(0o600);
    }
    expect(count(join(snap, 'graphs.db'), 'sqlite_master')).toBeGreaterThan(0);
    expect(r.out).toContain(snap);
    expect(r.out).toContain('graphs.db');
    expect(r.out).toContain('Kept 1 snapshot.');
    expect(r.err).toBe('');
  });

  it('works while the real service is running and holds what it had at that moment', async () => {
    const data = join(folder(), 'data');
    const service = await startService(baseConfig(data));
    try {
      const origin = `http://127.0.0.1:${service.port}`;
      for (const name of ['ann', 'bob']) {
        const res = await fetch(`${origin}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ username: name, displayName: name, password: 'correct horse 7 staple' }) });
        expect(res.status).toBe(201);
      }
      const dest = join(folder(), 'backups');
      const r = run(['--dest', dest], { CACI_DATA_DIR: data });
      expect(r.code, r.err).toBe(0);
      expect(count(join(dest, '20261011T020000Z', 'users.db'), 'users')).toBe(2);
    } finally {
      await service.close();
    }
  });

  it('never prints a secret from the environment, and needs only the data folder setting', async () => {
    const data = await dataFolder();
    const dest = join(folder(), 'b');
    const secret = 'sk-ant-api03-thisIsASecretKeyThatMustNeverBePrinted0123456789';
    const r = run(['--dest', dest], { CACI_DATA_DIR: data, ANTHROPIC_API_KEY: secret, CACI_LLM: 'anthropic' });
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toContain(secret);
    const bad = run(['--dest', dest, '--keep', 'x'], { CACI_DATA_DIR: data, ANTHROPIC_API_KEY: secret });
    expect(bad.out + bad.err).not.toContain(secret);
  });
});

describe('keeping only the newest complete snapshots', () => {
  it('removes the oldest beyond --keep, only after a good new one exists', async () => {
    const data = await dataFolder();
    const dest = join(folder(), 'b');
    for (let day = 1; day <= 5; day++) expect(run(['--dest', dest, '--keep', '3'], { CACI_DATA_DIR: data }, Date.UTC(2026, 9, day, 2, 0, 0)).code).toBe(0);
    expect(names(dest)).toEqual(['20261003T020000Z', '20261004T020000Z', '20261005T020000Z']);
    const r = run(['--dest', dest, '--keep', '1'], { CACI_DATA_DIR: data }, Date.UTC(2026, 9, 6, 2, 0, 0));
    expect(names(dest)).toEqual(['20261006T020000Z']);
    expect(r.out).toContain('removed 3 older');
  });

  it('keeps 14 by default', async () => {
    expect(DEFAULT_KEEP).toBe(14);
    const data = await dataFolder();
    const dest = join(folder(), 'b');
    for (let day = 1; day <= 16; day++) run(['--dest', dest], { CACI_DATA_DIR: data }, Date.UTC(2026, 8, day, 2, 0, 0));
    expect(names(dest)).toHaveLength(14);
    expect(names(dest)[0]).toBe('20260903T020000Z');
  });

  it('a second backup in the same second gets its own folder and sorts after the first', async () => {
    const data = await dataFolder();
    const dest = join(folder(), 'b');
    run(['--dest', dest], { CACI_DATA_DIR: data });
    run(['--dest', dest], { CACI_DATA_DIR: data });
    run(['--dest', dest], { CACI_DATA_DIR: data });
    expect(names(dest)).toEqual(['20261011T020000Z', '20261011T020000Z-2', '20261011T020000Z-3']);
    expect(listSnapshots(dest).map((s) => s.name)).toEqual(['20261011T020000Z-3', '20261011T020000Z-2', '20261011T020000Z']);
    run(['--dest', dest, '--keep', '2'], { CACI_DATA_DIR: data });
    expect(names(dest)).toEqual(['20261011T020000Z-3', '20261011T020000Z-4']);
  });

  it('removes incomplete snapshot folders and leftovers of failed runs, and leaves anything else alone', async () => {
    const data = await dataFolder();
    const dest = join(folder(), 'b');
    mkdirSync(join(dest, '20260101T000000Z'), { recursive: true });
    writeFileSync(join(dest, '20260101T000000Z', 'graphs.db'), 'half');
    mkdirSync(join(dest, '.20260102T000000Z.partial'));
    mkdirSync(join(dest, 'pre-restore-20260103'));
    writeFileSync(join(dest, 'notes.txt'), 'mine');
    expect(run(['--dest', dest], { CACI_DATA_DIR: data }).code).toBe(0);
    expect(names(dest)).toEqual(['20261011T020000Z', 'notes.txt', 'pre-restore-20260103']);
  });
});

describe('a backup that fails removes nothing', () => {
  it('a database that is not ours: exit 1, the old snapshots intact, no partial folder left', async () => {
    const data = await dataFolder();
    const dest = join(folder(), 'b');
    run(['--dest', dest], { CACI_DATA_DIR: data }, Date.UTC(2026, 9, 1, 2, 0, 0));
    writeFileSync(join(data, 'users.db'), 'not a database '.repeat(50));
    const before = names(dest);
    const r = run(['--dest', dest, '--keep', '1'], { CACI_DATA_DIR: data });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Nothing was removed');
    expect(names(dest)).toEqual(before);
    expect(listSnapshots(dest).every((s) => s.complete)).toBe(true);
  });

  it('a graph database and a user database swapped: each is refused for the other\'s name', async () => {
    const data = await dataFolder();
    const g = readFileSync(join(data, 'graphs.db'));
    const u = readFileSync(join(data, 'users.db'));
    writeFileSync(join(data, 'graphs.db'), u);
    writeFileSync(join(data, 'users.db'), g);
    const dest = join(folder(), 'b');
    const r = run(['--dest', dest], { CACI_DATA_DIR: data });
    expect(r.code).toBe(1);
    expect(names(dest)).toEqual([]);
  });

  it('a missing database: exit 1, nothing created (not the database, not the destination)', async () => {
    const data = await dataFolder();
    rmSync(join(data, 'users.db'));
    const dest = join(folder(), 'b');
    const r = run(['--dest', dest], { CACI_DATA_DIR: data });
    expect(r.code).toBe(1);
    expect(existsSync(join(data, 'users.db'))).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  it('a destination inside the data folder, directly or through a link, or that is a file', async () => {
    const data = await dataFolder();
    expect(run(['--dest', join(data, 'backups')], { CACI_DATA_DIR: data }).code).toBe(1);
    expect(run(['--dest', data], { CACI_DATA_DIR: data }).code).toBe(1);
    expect(existsSync(join(data, 'backups'))).toBe(false);
    if (process.platform !== 'win32') {
      const link = join(folder(), 'link');
      symlinkSync(data, link);
      expect(run(['--dest', join(link, 'backups')], { CACI_DATA_DIR: data }).code).toBe(1);
    }
    const file = join(folder(), 'afile');
    writeFileSync(file, 'x');
    expect(run(['--dest', file], { CACI_DATA_DIR: data }).code).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('x');
  });

  it('a destination that cannot be written', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const data = await dataFolder();
    const base = folder();
    chmodSync(base, 0o500);
    const r = run(['--dest', join(base, 'b')], { CACI_DATA_DIR: data });
    chmodSync(base, 0o700);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Nothing was removed');
  });
});

describe('arguments', () => {
  it.each([
    [[]],
    [['--keep', '3']],
    [['--dest']],
    [['--dest', '--keep', '3']],
    [['--dest', 'a', '--dest', 'b']],
    [['--dest', 'a', '--keep']],
    [['--dest', 'a', '--keep', '0']],
    [['--dest', 'a', '--keep', '1001']],
    [['--dest', 'a', '--keep', 'many']],
    [['--dest', 'a', '--keep', '-1']],
    [['--dest', 'a', '--force']],
    [['dest']],
    [['--dest', '--keep']],
  ])('%j is refused with the usage and exit 2, and changes nothing', async (args) => {
    const data = await dataFolder();
    const before = names(join(data, '..'));
    const r = run(args, { CACI_DATA_DIR: data });
    expect(r.code).toBe(2);
    expect(r.err).toContain('Usage: npm run backup');
    expect(names(join(data, '..'))).toEqual(before);
  });

  it('--keep 1000 is allowed', async () => {
    const data = await dataFolder();
    expect(run(['--dest', join(folder(), 'b'), '--keep', '1000'], { CACI_DATA_DIR: data }).code).toBe(0);
  });
});

describe('small pieces', () => {
  it('names a snapshot by UTC time, sortably', () => {
    expect(snapshotNameAt(Date.UTC(2026, 9, 11, 2, 3, 4, 567))).toBe('20261011T020304Z');
    expect(snapshotNameAt(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('20260101T000000Z');
  });
  it('reads the data folder like the service: CACI_DATA_DIR, else ./data, empty counting as unset', () => {
    expect(dataDirOf({ CACI_DATA_DIR: '/x/y' })).toBe('/x/y');
    expect(dataDirOf({})).toBe(join(process.cwd(), 'data'));
    expect(dataDirOf({ CACI_DATA_DIR: '  ' })).toBe(join(process.cwd(), 'data'));
  });
  it('knows what is inside a folder, and that a sibling with the same prefix is not', () => {
    expect(isInside('/tmp/a/b', '/tmp/a')).toBe(true);
    expect(isInside('/tmp/a', '/tmp/a')).toBe(true);
    expect(isInside('/tmp/ab', '/tmp/a')).toBe(false);
    expect(isInside('/tmp', '/tmp/a')).toBe(false);
  });
});
