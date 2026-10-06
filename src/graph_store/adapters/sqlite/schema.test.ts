import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DbError, openDb, type Db } from '../../../sqlite/db.js';
import { APPLICATION_ID, MIGRATIONS, SCHEMA_VERSION, prepareDatabase, type Migration } from './schema.js';

const dirs: string[] = [];
const opened: Db[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'caci-schema-'));
  dirs.push(dir);
  return join(dir, 'g.db');
}
function open(path?: string): Db {
  const db = openDb(path === undefined ? {} : { path });
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
const tables = (db: Db): string[] => db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);

describe('a new database', () => {
  it('gets the v1 tables, user_version and our application id', () => {
    const db = open();
    expect(prepareDatabase(db)).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(tables(db)).toEqual(['edges', 'graphs', 'nodes']);
    expect(db.pragma('user_version')).toBe(SCHEMA_VERSION);
    expect(db.pragma('application_id')).toBe(APPLICATION_ID);
    expect(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'edges_by_category'")).toBeDefined();
  });

  it('turns a file into write-ahead mode only after preparing it', () => {
    const path = tempFile();
    const db = open(path);
    prepareDatabase(db);
    expect(db.pragma('journal_mode')).toBe('wal');
  });

  it('preparing again is a no-op', () => {
    const db = open();
    prepareDatabase(db);
    db.exec("INSERT INTO graphs (graph_id) VALUES ('g')");
    expect(prepareDatabase(db)).toEqual({ from: 1, to: 1 });
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM graphs')?.n).toBe(1);
  });

  it('the constraints hold: partition values, graph references, cascade on drop, empty-free keys', () => {
    const db = open();
    prepareDatabase(db);
    db.exec("INSERT INTO graphs (graph_id) VALUES ('g')");
    expect(() => db.exec("INSERT INTO nodes (graph_id, partition, id_key) VALUES ('g', 'other', x'01')")).toThrow();
    expect(() => db.exec("INSERT INTO nodes (graph_id, partition, id_key) VALUES ('missing', 'item', x'01')")).toThrow();
    db.exec("INSERT INTO nodes (graph_id, partition, id_key) VALUES ('g', 'item', x'01')");
    db.exec("INSERT INTO edges (graph_id, item_key, category_key) VALUES ('g', x'0100', x'0101')"); // ends need not exist
    db.exec("DELETE FROM graphs WHERE graph_id = 'g'");
    expect(db.get<{ n: number }>('SELECT (SELECT count(*) FROM nodes) + (SELECT count(*) FROM edges) AS n')?.n).toBe(0);
  });
});

describe('a file that is not ours', () => {
  it('a SQLite database with other tables is refused and left untouched', () => {
    const path = tempFile();
    const other = open(path);
    other.exec('CREATE TABLE recipes (name TEXT)');
    other.close();
    const before = readFileSync(path);
    const db = open(path);
    expect(codeOf(() => prepareDatabase(db))).toBe('NOT_A_GRAPH_DATABASE');
    db.close();
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(tables(open(path))).toEqual(['recipes']);
  });

  it('a database with another application id is refused', () => {
    const db = open();
    db.exec('PRAGMA application_id = 12345');
    expect(codeOf(() => prepareDatabase(db))).toBe('NOT_A_GRAPH_DATABASE');
    expect(tables(db)).toEqual([]);
  });

  it('a database that looks like ours but carries another application id is refused', () => {
    const db = open();
    prepareDatabase(db);
    db.exec('PRAGMA application_id = 12345');
    expect(codeOf(() => prepareDatabase(db))).toBe('NOT_A_GRAPH_DATABASE');
    expect(db.pragma('application_id')).toBe(12345);
  });

  it('our application id without a version is refused', () => {
    const db = open();
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    expect(codeOf(() => prepareDatabase(db))).toBe('NOT_A_GRAPH_DATABASE');
  });

  it('one of ours that has lost a table is refused', () => {
    const db = open();
    prepareDatabase(db);
    db.exec('DROP TABLE edges');
    expect(codeOf(() => prepareDatabase(db))).toBe('NOT_A_GRAPH_DATABASE');
  });

  it('a file that is not SQLite at all is refused at open', () => {
    const path = tempFile();
    writeFileSync(path, 'x'.repeat(5000));
    expect(codeOf(() => open(path))).toBe('NOT_A_DATABASE');
    expect(readFileSync(path, 'utf8')).toBe('x'.repeat(5000));
  });
});

describe('a newer file', () => {
  it('is refused and left untouched', () => {
    const path = tempFile();
    const a = open(path);
    prepareDatabase(a);
    a.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    a.close();
    const before = readFileSync(path);
    const b = open(path);
    expect(codeOf(() => prepareDatabase(b))).toBe('NEWER_SCHEMA');
    expect(b.pragma('user_version')).toBe(SCHEMA_VERSION + 1);
    b.close();
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe('migrations', () => {
  const v2: Migration = { to: 2, sql: ['ALTER TABLE graphs ADD COLUMN note TEXT'] };

  it('an older file is upgraded step by step and keeps its data', () => {
    const db = open();
    prepareDatabase(db);
    db.exec("INSERT INTO graphs (graph_id) VALUES ('g')");
    expect(prepareDatabase(db, { migrations: [...MIGRATIONS, v2] })).toEqual({ from: 1, to: 2 });
    expect(db.pragma('user_version')).toBe(2);
    expect(db.get<{ graph_id: string; note: null }>('SELECT graph_id, note FROM graphs')).toEqual({ graph_id: 'g', note: null });
  });

  it('a failing step rolls the whole upgrade back and says what went wrong', () => {
    const db = open();
    prepareDatabase(db);
    const broken: Migration = { to: 2, sql: ['ALTER TABLE graphs ADD COLUMN note TEXT', 'THIS IS NOT SQL'] };
    expect(codeOf(() => prepareDatabase(db, { migrations: [...MIGRATIONS, broken] }))).toBe('MIGRATION_FAILED');
    expect(db.pragma('user_version')).toBe(1);
    expect(db.inTransaction).toBe(false);
    expect(db.all<{ name: string }>("SELECT name FROM pragma_table_info('graphs')").map((c) => c.name)).toEqual(['graph_id']);
  });

  it('a failing first creation leaves a new file empty', () => {
    const db = open();
    const broken: Migration = { to: 1, sql: ['CREATE TABLE a (x INTEGER)', 'THIS IS NOT SQL'] };
    expect(codeOf(() => prepareDatabase(db, { migrations: [broken] }))).toBe('MIGRATION_FAILED');
    expect(tables(db)).toEqual([]);
    expect(db.pragma('application_id')).toBe(0);
  });

  it('refuses a history that is not numbered 1, 2, 3...', () => {
    const db = open();
    expect(() => prepareDatabase(db, { migrations: [{ to: 2, sql: [] }] })).toThrow(/numbered/);
    expect(tables(db)).toEqual([]);
  });
});

describe('two connections opening the same new file', () => {
  it('both end up with a good database: the second waits for the first, then finds it done', () => {
    const path = tempFile();
    const a = open(path);
    const b = open(path);
    expect(prepareDatabase(a)).toEqual({ from: 0, to: 1 });
    expect(prepareDatabase(b)).toEqual({ from: 1, to: 1 });
  });
});
