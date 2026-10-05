import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { StorageAdapter } from '../../adapter.js';
import { write } from '../../endpoints.js';
import { describeGraph } from '../../graphs.js';
import { link, mutation, snapshot, upsert } from '../../testing/helpers.js';
import { runAdapterConformance } from '../../testing/index.js';
import { DbError, createSqliteAdapter, type SqliteAdapter } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
const open: SqliteAdapter[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'caci-files-'));
  dirs.push(dir);
  return dir;
}
function adapterAt(path: string): SqliteAdapter {
  const adapter = createSqliteAdapter({ path });
  open.push(adapter);
  return adapter;
}
afterEach(async () => {
  for (const adapter of open.splice(0)) await adapter.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const leftovers = (path: string): string[] => ['-wal', '-shm', '-journal'].filter((suffix) => existsSync(path + suffix));
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (cause) {
    return cause instanceof DbError ? cause.code : `other: ${String(cause)}`;
  }
  return undefined;
};

// The whole storage contract again, on a real database file per test.
{
  const homes = new Map<StorageAdapter, string>();
  runAdapterConformance(
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'caci-conf-'));
      const adapter = createSqliteAdapter({ path: join(dir, 'graphs.db') });
      homes.set(adapter, dir);
      return adapter;
    },
    { describe, it },
    {
      dispose: async (adapter) => {
        await (adapter as SqliteAdapter).close();
        rmSync(homes.get(adapter) as string, { recursive: true, force: true });
      },
    },
  );
}

async function fill(adapter: SqliteAdapter): Promise<void> {
  expect(
    await write(
      adapter,
      mutation(
        [
          upsert('item', 'note-1', { title: 'Blood test', tags: ['a', 'b'], n: 1.5, nested: { ok: true, none: null } }),
          upsert('item', 'x\uD800y'), // a lone surrogate must survive the file
          upsert('item', 'note-3', { title: '😀' }),
          upsert('category', 'health', { name: 'Health' }),
          upsert('category', '～', { name: 'wide' }),
          link('note-1', 'health', { weight: 0.9, data: { why: 'doctor' } }),
          link('note-3', 'health'),
          link('x\uD800y', '～', { weight: 0 }),
        ],
        { createIfMissing: true },
      ),
    ),
  ).toMatchObject({ ok: true });
}

describe('a database file', () => {
  it('keeps everything across close and reopen, identical and in the same order', async () => {
    const path = join(tempDir(), 'g.db');
    const first = adapterAt(path);
    await fill(first);
    await first.graphs.create('other');
    const before = await snapshot(first);
    await first.close();

    const second = adapterAt(path);
    expect(await snapshot(second)).toEqual(before);
    expect((await second.graphs.list({ limit: 10, cursor: null })).items).toEqual(['g', 'other']);
    expect(before.items.map((i) => i.id)).toEqual(['note-1', 'note-3', 'x\uD800y']);
    expect(before.items[0]?.data).toEqual({ title: 'Blood test', tags: ['a', 'b'], n: 1.5, nested: { ok: true, none: null } });
    expect(before.edgesFromItems.find((e) => e.item === 'x\uD800y')).toMatchObject({ weight: 0 });
  });

  it('opening it again does not recreate the schema or lose data written after the first open', async () => {
    const path = join(tempDir(), 'g.db');
    const first = adapterAt(path);
    await fill(first);
    await first.close();
    const second = adapterAt(path);
    await write(second, mutation([upsert('item', 'later')]));
    await second.close();
    const third = adapterAt(path);
    expect((await snapshot(third)).items.map((i) => i.id)).toEqual(['later', 'note-1', 'note-3', 'x\uD800y']);
  });

  it('a transaction that failed, or was rolled back, leaves nothing after reopening', async () => {
    const path = join(tempDir(), 'g.db');
    const first = adapterAt(path);
    await fill(first);
    const before = await snapshot(first);
    await expect(
      first.transaction('g', async (tx) => {
        await tx.putNodes([{ partition: 'item', id: 'ghost' }]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const failed = await write(first, mutation([upsert('item', 'half'), link('half', 'no-such-category')]));
    expect(failed.ok).toBe(false);
    await first.close();
    expect(await snapshot(adapterAt(path))).toEqual(before);
  });

  it('survives a process killed part-way through a write transaction: it opens intact, without the partial write', async () => {
    const path = join(tempDir(), 'g.db');
    const child = spawn(process.execPath, ['--import', join(here, 'ts-loader.mjs'), join(here, 'kill-child.mjs'), path, 'hang'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    await new Promise<void>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes('ready')) resolve();
      });
      child.on('exit', () => reject(new Error(`the child ended before it was ready: ${stderr}`)));
    });
    const ended = new Promise<string | null>((resolve) => child.on('exit', (_code, signal) => resolve(signal)));
    child.kill('SIGKILL');
    expect(await ended).toBe('SIGKILL');

    const reopened = adapterAt(path); // would throw if the file were damaged
    const after = await snapshot(reopened);
    expect(after.items.map((i) => i.id)).toEqual(['committed']);
    expect(after.edgesFromItems).toEqual([]);
    expect(after.edgesFromCategories).toEqual([]);
    expect((await reopened.graphs.list({ limit: 10, cursor: null })).items).toEqual(['g']);
    // and it is fully usable afterwards
    expect(await write(reopened, mutation([upsert('item', 'after-crash')]))).toMatchObject({ ok: true });
  });

  it('the killed run really did write before it was killed (the test would prove nothing otherwise)', async () => {
    const path = join(tempDir(), 'g.db');
    const child = spawn(process.execPath, ['--import', join(here, 'ts-loader.mjs'), join(here, 'kill-child.mjs'), path, 'finish'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`the child failed with ${code}`))));
    });
    expect(await describeGraph(adapterAt(path), 'g')).toMatchObject({ ok: true, value: { itemCount: 2001, edgeCount: 2000 } });
  });
});

describe('the file on disk', () => {
  it.skipIf(process.platform === 'win32')('a new file is readable and writable by its owner only', async () => {
    const path = join(tempDir(), 'g.db');
    const adapter = adapterAt(path);
    await adapter.graphs.create('g');
    await write(adapter, mutation([upsert('item', 'a')]));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) expect(statSync(path + suffix).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('an existing file keeps the mode its owner gave it', () => {
    const path = join(tempDir(), 'g.db');
    createSqliteAdapter({ path }).close();
    chmodSync(path, 0o640);
    adapterAt(path);
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it('a clean close leaves one file: no -wal, -shm or journal', async () => {
    const dir = tempDir();
    const path = join(dir, 'g.db');
    const adapter = adapterAt(path);
    await fill(adapter);
    expect(leftovers(path)).not.toEqual([]); // write-ahead logging is really in use while open
    await adapter.close();
    expect(leftovers(path)).toEqual([]);
    expect(readdirSync(dir)).toEqual(['g.db']);
  });

  it('is in write-ahead mode, and that is remembered by the file', async () => {
    const path = join(tempDir(), 'g.db');
    await adapterAt(path).close();
    const text = readFileSync(path);
    expect(text.subarray(18, 20)).toEqual(Buffer.from([2, 2])); // header bytes 18 and 19: 2 means write-ahead log
  });
});

describe('a path that cannot be used', () => {
  it('a missing directory is an error that names the path, and creates nothing', () => {
    const dir = tempDir();
    const path = join(dir, 'no', 'such', 'g.db');
    expect(codeOf(() => createSqliteAdapter({ path }))).toBe('OPEN_FAILED');
    expect(() => createSqliteAdapter({ path })).toThrow(path);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a directory is an error', () => {
    expect(codeOf(() => createSqliteAdapter({ path: tempDir() }))).toBe('OPEN_FAILED');
  });

  it('a file that is not a database is refused and left exactly as it was', () => {
    const dir = tempDir();
    const path = join(dir, 'notes.txt');
    const content = 'my private notes, not a database '.repeat(50);
    writeFileSync(path, content);
    expect(codeOf(() => createSqliteAdapter({ path }))).toBe('NOT_A_DATABASE');
    expect(readFileSync(path, 'utf8')).toBe(content);
    expect(readdirSync(dir)).toEqual(['notes.txt']);
  });

  it('someone else\'s SQLite database is refused and left exactly as it was', async () => {
    const dir = tempDir();
    const path = join(dir, 'other.db');
    const { openDb } = await import('./db.js');
    const other = openDb({ path });
    other.exec('CREATE TABLE recipes (name TEXT)');
    other.close();
    const before = readFileSync(path);
    expect(codeOf(() => createSqliteAdapter({ path }))).toBe('NOT_A_GRAPH_DATABASE');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(leftovers(path)).toEqual([]);
  });

  it('a database written by a newer version is refused and left exactly as it was', async () => {
    const dir = tempDir();
    const path = join(dir, 'g.db');
    await adapterAt(path).close();
    const { openDb } = await import('./db.js');
    const db = openDb({ path });
    db.exec('PRAGMA user_version = 99');
    db.close();
    const before = readFileSync(path);
    expect(codeOf(() => createSqliteAdapter({ path }))).toBe('NEWER_SCHEMA');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(leftovers(path)).toEqual([]);
  });
});
