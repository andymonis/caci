import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './db.js';
import { inspectDatabase, snapshotDatabase } from './snapshot.js';

const here = dirname(fileURLToPath(import.meta.url));
const APP = 0x43614369;
const OTHER = 0x12345678;
const dirs: string[] = [];
const folder = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'caci-snap-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A small database of ours: application id, schema version 3, two tables, write-ahead log on. */
function make(path: string, applicationId = APP): void {
  const db = openDb({ path });
  db.exec(`PRAGMA application_id = ${applicationId}; PRAGMA user_version = 3; CREATE TABLE a (v INTEGER); CREATE TABLE b (v INTEGER); CREATE TABLE notes (id BLOB PRIMARY KEY, text TEXT) WITHOUT ROWID`);
  db.useWriteAheadLog();
  db.close();
}
const OPTIONS = { applicationIds: [APP] };
const rows = (path: string, table: string): number => {
  const db = openDb({ path });
  try {
    return Number(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n);
  } finally {
    db.close();
  }
};
const mode = (path: string): number => statSync(path).mode & 0o777;

describe('a snapshot of a database', () => {
  it('is a complete, verified copy with the same application id and version, created owner-only', () => {
    const d = folder();
    make(join(d, 'src.db'));
    const db = openDb({ path: join(d, 'src.db') });
    db.run('INSERT INTO notes (id, text) VALUES (?, ?)', new Uint8Array([1, 2, 3]), 'hello');
    db.run('INSERT INTO a (v) VALUES (1)');
    db.close();
    const result = snapshotDatabase(join(d, 'src.db'), join(d, 'copy.db'), OPTIONS);
    expect(result).toMatchObject({ ok: true, applicationId: APP, version: 3 });
    expect(result.ok && result.bytes).toBeGreaterThan(0);
    expect(rows(join(d, 'copy.db'), 'notes')).toBe(1);
    expect(rows(join(d, 'copy.db'), 'a')).toBe(1);
    expect(inspectDatabase(join(d, 'copy.db'), [APP])).toEqual({ ok: true, applicationId: APP, version: 3, intact: true });
    if (process.platform !== 'win32') expect(mode(join(d, 'copy.db'))).toBe(0o600);
  });

  it('includes what is committed but still only in the write-ahead log, and leaves no side files behind', () => {
    const d = folder();
    make(join(d, 'src.db'));
    const open = openDb({ path: join(d, 'src.db') }); // stays open, so the log is not folded back into the file
    for (let i = 0; i < 50; i++) open.run('INSERT INTO a (v) VALUES (?)', i);
    expect(existsSync(join(d, 'src.db-wal'))).toBe(true);
    const result = snapshotDatabase(join(d, 'src.db'), join(d, 'copy.db'), OPTIONS);
    open.close();
    expect(result.ok).toBe(true);
    expect(rows(join(d, 'copy.db'), 'a')).toBe(50);
    expect(readdirSync(d).filter((f) => f.startsWith('.') || f.includes('partial')).sort()).toEqual([]);
  });

  it('keeps ids that are not valid text (a lone surrogate, as bytes) exactly', () => {
    const d = folder();
    make(join(d, 'src.db'));
    const db = openDb({ path: join(d, 'src.db') });
    const key = new Uint8Array([0x01, 0xd8, 0x00, 0x00, 0x41]);
    db.run('INSERT INTO notes (id, text) VALUES (?, ?)', key, 'x');
    db.close();
    expect(snapshotDatabase(join(d, 'src.db'), join(d, 'copy.db'), OPTIONS).ok).toBe(true);
    const copy = openDb({ path: join(d, 'copy.db') });
    const row = copy.get<{ id: Uint8Array }>('SELECT id FROM notes');
    copy.close();
    expect([...(row?.id ?? [])]).toEqual([...key]);
  });

  it('is a consistent state while another process writes in transactions, every time', async () => {
    const d = folder();
    make(join(d, 'src.db'));
    const child = spawn(process.execPath, ['--import', join(here, 'ts-loader.mjs'), join(here, 'snapshot-child.mjs'), join(d, 'src.db'), '4000'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`child exited early with ${code}`)));
    });
    const sizes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const copy = join(d, `copy-${i}.db`);
      const result = snapshotDatabase(join(d, 'src.db'), copy, OPTIONS);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const a = rows(copy, 'a');
      const b = rows(copy, 'b');
      expect(a).toBe(b);
      sizes.push(a);
    }
    child.kill('SIGKILL');
    expect(sizes.at(-1)).toBeGreaterThan(0);
    expect(new Set(sizes).size).toBeGreaterThan(1); // the writer really was moving while we copied
  }, 60_000);
});

describe('what a snapshot refuses', () => {
  const nothingElse = (d: string, before: string[]): void => expect(readdirSync(d).sort()).toEqual(before.sort());

  it('a destination that exists, and one whose folder is missing', () => {
    const d = folder();
    make(join(d, 'src.db'));
    writeFileSync(join(d, 'taken.db'), 'precious');
    expect(snapshotDatabase(join(d, 'src.db'), join(d, 'taken.db'), OPTIONS)).toMatchObject({ ok: false });
    expect(readFileSync(join(d, 'taken.db'), 'utf8')).toBe('precious');
    expect(snapshotDatabase(join(d, 'src.db'), join(d, 'nope', 'copy.db'), OPTIONS)).toMatchObject({ ok: false });
    expect(existsSync(join(d, 'nope'))).toBe(false);
  });

  it('a missing source, a directory, a file that is not a database, and a database of another application, each leaving everything as it was', () => {
    const d = folder();
    writeFileSync(join(d, 'junk.db'), 'this is not a database, it is just text that is long enough to look like one'.repeat(5));
    make(join(d, 'foreign.db'), OTHER);
    mkdirSync(join(d, 'dir.db'));
    const before = readdirSync(d);
    const junk = readFileSync(join(d, 'junk.db'));
    for (const name of ['missing.db', 'junk.db', 'foreign.db', 'dir.db']) {
      const result = snapshotDatabase(join(d, name), join(d, 'copy.db'), OPTIONS);
      expect(result.ok, name).toBe(false);
    }
    expect(existsSync(join(d, 'missing.db'))).toBe(false); // checking never creates a database
    expect(readFileSync(join(d, 'junk.db'))).toEqual(junk);
    nothingElse(d, before);
  });

  it('empty or odd paths', () => {
    const d = folder();
    make(join(d, 'src.db'));
    expect(snapshotDatabase('', join(d, 'c.db'), OPTIONS).ok).toBe(false);
    expect(snapshotDatabase(join(d, 'src.db'), '', OPTIONS).ok).toBe(false);
    expect(snapshotDatabase(join(d, 'src.db'), join(d, 'c\0.db'), OPTIONS).ok).toBe(false);
  });

  it('a source that no application id is allowed for (an empty list allows nothing)', () => {
    const d = folder();
    make(join(d, 'src.db'));
    expect(snapshotDatabase(join(d, 'src.db'), join(d, 'copy.db'), { applicationIds: [] }).ok).toBe(false);
    expect(existsSync(join(d, 'copy.db'))).toBe(false);
  });

  it('a destination that cannot be written leaves no partial file', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const d = folder();
    make(join(d, 'src.db'));
    mkdirSync(join(d, 'ro'));
    chmodSync(join(d, 'ro'), 0o500);
    const result = snapshotDatabase(join(d, 'src.db'), join(d, 'ro', 'copy.db'), OPTIONS);
    chmodSync(join(d, 'ro'), 0o700);
    expect(result.ok).toBe(false);
    expect(readdirSync(join(d, 'ro'))).toEqual([]);
  });
});

describe('inspecting a database', () => {
  it('does not call a damaged file intact', () => {
    const d = folder();
    make(join(d, 'a.db'));
    const db = openDb({ path: join(d, 'a.db') });
    for (let i = 0; i < 3000; i++) db.run('INSERT INTO notes (id, text) VALUES (?, ?)', new Uint8Array([1, i % 256, Math.floor(i / 256)]), 'x'.repeat(40));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const bytes = readFileSync(join(d, 'a.db'));
    for (let at = 8192; at < bytes.length - 100; at += 4096) bytes.fill(0xff, at + 50, at + 80);
    writeFileSync(join(d, 'bad.db'), bytes);
    const result = inspectDatabase(join(d, 'bad.db'), [APP]);
    expect(result.ok && result.intact).toBe(false);
  });

  it('says what it is without changing it, and refuses what is not ours or does not exist', () => {
    const d = folder();
    make(join(d, 'a.db'));
    make(join(d, 'f.db'), OTHER);
    const bytes = readFileSync(join(d, 'a.db'));
    expect(inspectDatabase(join(d, 'a.db'), [APP])).toEqual({ ok: true, applicationId: APP, version: 3, intact: true });
    expect(readFileSync(join(d, 'a.db'))).toEqual(bytes);
    expect(inspectDatabase(join(d, 'f.db'), [APP]).ok).toBe(false);
    expect(inspectDatabase(join(d, 'none.db'), [APP]).ok).toBe(false);
    expect(existsSync(join(d, 'none.db'))).toBe(false);
  });
});
