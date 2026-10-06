import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DbError, openDb, type Db } from './db.js';

const dirs: string[] = [];
const opened: Db[] = [];
function tempFile(name = 'test.db'): string {
  const dir = mkdtempSync(join(tmpdir(), 'caci-db-'));
  dirs.push(dir);
  return join(dir, name);
}
function open(options?: Parameters<typeof openDb>[0]): Db {
  const db = openDb(options);
  opened.push(db);
  return db;
}
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (cause) {
    return cause instanceof DbError ? cause.code : `other: ${String(cause)}`;
  }
  return undefined;
};

describe('openDb', () => {
  it('defaults to a private in-memory database', () => {
    const a = open();
    const b = open();
    a.exec('CREATE TABLE t (x INTEGER)');
    expect(a.path).toBe(':memory:');
    expect(() => b.get('SELECT * FROM t')).toThrow();
  });

  it('sets the busy timeout (default 5,000 ms, or as asked) and foreign keys on', () => {
    expect(open().pragma('busy_timeout')).toBe(5000);
    expect(open({ busyTimeoutMs: 123 }).pragma('busy_timeout')).toBe(123);
    expect(open().pragma('foreign_keys')).toBe(1);
  });

  it.each([[-1], [1.5], [Number.NaN], [600_001]])('refuses busyTimeoutMs %s', (ms) => {
    expect(codeOf(() => openDb({ busyTimeoutMs: ms }))).toBe('OPEN_FAILED');
  });

  it.each([[''], ['a\0b']])('refuses the path %j', (path) => {
    expect(codeOf(() => openDb({ path }))).toBe('OPEN_FAILED');
  });

  it('says OPEN_FAILED when the directory does not exist', () => {
    expect(codeOf(() => openDb({ path: join(tempFile(), 'no', 'such', 'dir.db') }))).toBe('OPEN_FAILED');
  });

  it('says OPEN_FAILED for a directory', () => {
    const file = tempFile();
    expect(codeOf(() => openDb({ path: join(file, '..') }))).toBe('OPEN_FAILED');
  });

  it('refuses a file that is not a SQLite database, and leaves it byte for byte as it was', () => {
    const path = tempFile('notes.txt');
    const content = 'these are my notes, not a database '.repeat(40);
    writeFileSync(path, content);
    expect(codeOf(() => openDb({ path }))).toBe('NOT_A_DATABASE');
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('opens a new file, keeps data across connections, and starts in the default journal mode until asked', () => {
    const path = tempFile();
    const a = open({ path });
    a.exec('CREATE TABLE t (x INTEGER)');
    a.run('INSERT INTO t (x) VALUES (?)', 7);
    a.close();
    const b = open({ path });
    expect(b.get<{ x: number }>('SELECT x FROM t')?.x).toBe(7);
    expect(b.pragma('journal_mode')).toBe('delete');
  });
});

describe('statements', () => {
  it('run returns the number of rows changed; get and all return rows', () => {
    const db = open();
    db.exec('CREATE TABLE t (x INTEGER)');
    expect(db.run('INSERT INTO t (x) VALUES (?), (?)', 1, 2)).toBe(2);
    expect(db.run('UPDATE t SET x = x + 1')).toBe(2);
    expect(db.run('DELETE FROM t WHERE x > ?', 100)).toBe(0);
    expect(db.get<{ x: number }>('SELECT x FROM t ORDER BY x')?.x).toBe(2);
    expect(db.get('SELECT x FROM t WHERE x = ?', 99)).toBeUndefined();
    expect(db.all<{ x: number }>('SELECT x FROM t ORDER BY x')).toEqual([{ x: 2 }, { x: 3 }]);
  });

  it('caches prepared statements by their text, and stays bounded', () => {
    const db = open();
    db.get('SELECT 1 AS a');
    db.get('SELECT 1 AS a');
    expect(db.statementCount).toBe(1);
    for (let i = 0; i < 400; i++) db.get(`SELECT ${i} AS a`);
    expect(db.statementCount).toBeLessThanOrEqual(128);
    expect(db.get<{ a: number }>('SELECT 1 AS a')?.a).toBe(1); // still works after the cache was cleared
  });

  it('pragma accepts only plain names', () => {
    const db = open();
    expect(() => db.pragma('user_version; DROP TABLE t')).toThrow(/not a pragma name/);
    expect(db.pragma('user_version')).toBe(0);
  });
});

describe('transactions', () => {
  it('begin / commit keeps the changes; begin / rollback discards them', () => {
    const db = open();
    db.exec('CREATE TABLE t (x INTEGER)');
    db.begin();
    expect(db.inTransaction).toBe(true);
    db.run('INSERT INTO t (x) VALUES (1)');
    db.commit();
    expect(db.inTransaction).toBe(false);
    db.begin();
    db.run('INSERT INTO t (x) VALUES (2)');
    db.rollback();
    expect(db.inTransaction).toBe(false);
    expect(db.all<{ x: number }>('SELECT x FROM t')).toEqual([{ x: 1 }]);
  });

  it('refuses a second begin on the same connection', () => {
    const db = open();
    db.begin();
    expect(() => db.begin()).toThrow(/already open/);
    db.rollback();
  });

  it('begin takes the write lock at once: a second connection waits and then fails for want of it', () => {
    const path = tempFile();
    const a = open({ path });
    a.exec('CREATE TABLE t (x INTEGER)');
    const b = open({ path, busyTimeoutMs: 0 });
    a.begin();
    expect(() => b.begin()).toThrow(/locked|busy/i);
    a.rollback();
    b.begin(); // free now
    b.rollback();
  });
});

describe('write-ahead logging', () => {
  it('is switched on for a file, with normal synchronous, and persists', () => {
    const path = tempFile();
    const a = open({ path });
    a.useWriteAheadLog();
    expect(a.pragma('journal_mode')).toBe('wal');
    expect(a.pragma('synchronous')).toBe(1);
    a.close();
    expect(open({ path }).pragma('journal_mode')).toBe('wal');
  });

  it('does nothing in memory', () => {
    const db = open();
    db.useWriteAheadLog();
    expect(db.pragma('journal_mode')).toBe('memory');
  });
});

describe('close', () => {
  it('is idempotent and makes later use a CLOSED error', () => {
    const db = open();
    db.close();
    db.close();
    expect(db.isOpen).toBe(false);
    expect(codeOf(() => db.exec('SELECT 1'))).toBe('CLOSED');
    expect(codeOf(() => db.get('SELECT 1'))).toBe('CLOSED');
    expect(codeOf(() => db.begin())).toBe('CLOSED');
    expect(db.inTransaction).toBe(false);
  });

  it('rolls back anything still open', () => {
    const path = tempFile();
    const a = open({ path });
    a.exec('CREATE TABLE t (x INTEGER)');
    a.begin();
    a.run('INSERT INTO t (x) VALUES (1)');
    a.close();
    expect(open({ path }).all('SELECT x FROM t')).toEqual([]);
  });
});
