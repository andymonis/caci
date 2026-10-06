import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { write } from '../../endpoints.js';
import { link, mutation, snapshot, upsert } from '../../testing/helpers.js';
import { DbError, createSqliteAdapter, type SqliteAdapter } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
const open: SqliteAdapter[] = [];
const adapterAt = (path: string, busyTimeoutMs?: number): SqliteAdapter => {
  const adapter = createSqliteAdapter(busyTimeoutMs === undefined ? { path } : { path, busyTimeoutMs });
  open.push(adapter);
  return adapter;
};
const newPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-share-'));
  dirs.push(dir);
  return join(dir, 'g.db');
};
afterEach(async () => {
  for (const adapter of open.splice(0)) await adapter.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const countOf = async (adapter: SqliteAdapter): Promise<unknown> =>
  adapter.transaction('g', async (tx) => (await tx.getNodes('item', ['counter']))[0]?.data?.count);

function runChild(path: string, n: number): Promise<void> {
  const child = spawn(process.execPath, ['--import', join(here, '..', '..', '..', 'sqlite', 'ts-loader.mjs'), join(here, 'rmw-child.mjs'), path, String(n)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child failed (${code}): ${stderr}`)))));
}

describe('two adapters on one file', () => {
  it('each sees what the other has committed, as soon as it is committed', async () => {
    const path = newPath();
    const a = adapterAt(path);
    const b = adapterAt(path); // opened before anything was written
    expect(await write(a, mutation([upsert('item', 'from-a'), upsert('category', 'c'), link('from-a', 'c')], { createIfMissing: true }))).toMatchObject({ ok: true });
    expect((await snapshot(b)).items.map((i) => i.id)).toEqual(['from-a']);
    expect(await write(b, mutation([upsert('item', 'from-b'), link('from-b', 'c')]))).toMatchObject({ ok: true });
    const seen = await snapshot(a);
    expect(seen.items.map((i) => i.id)).toEqual(['from-a', 'from-b']);
    expect(seen.edgesFromCategories.length).toBe(2);
    await b.graphs.create('second');
    expect((await a.graphs.list({ limit: 10, cursor: null })).items).toEqual(['g', 'second']);
    await a.graphs.drop('second');
    expect(await b.graphs.exists('second')).toBe(false);
  });

  it('an uncommitted transaction of one is invisible to the other, and a rolled-back one never appears', async () => {
    const path = newPath();
    const a = adapterAt(path);
    const b = adapterAt(path);
    await a.graphs.create('g');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    const slow = a.transaction('g', async (tx) => {
      await tx.putNodes([{ partition: 'item', id: 'pending' }]);
      started();
      await held;
      throw new Error('changed my mind');
    });
    await begun;
    // reading does not need the write lock (write-ahead logging), and sees only committed data
    expect(await b.graphs.exists('g')).toBe(true);
    release();
    await expect(slow).rejects.toThrow('changed my mind');
    expect((await snapshot(b)).items).toEqual([]);
  });

  it('100 read-modify-write updates, 50 from each of two processes at once, lose none', async () => {
    const path = newPath();
    const setup = adapterAt(path);
    await write(setup, mutation([upsert('item', 'counter', { count: 0 })], { createIfMissing: true }));
    await setup.close();
    await Promise.all([runChild(path, 50), runChild(path, 50)]);
    expect(await countOf(adapterAt(path))).toBe(100);
  }, 60_000);

  it('the same, plus 50 from this process while the two children run: 150 in total', async () => {
    const path = newPath();
    const mine = adapterAt(path, 60_000);
    await write(mine, mutation([upsert('item', 'counter', { count: 0 })], { createIfMissing: true }));
    const children = Promise.all([runChild(path, 50), runChild(path, 50)]);
    for (let i = 0; i < 50; i++) {
      await mine.transaction('g', async (tx) => {
        const [counter] = await tx.getNodes('item', ['counter']);
        await tx.putNodes([{ partition: 'item', id: 'counter', data: { count: ((counter?.data?.count as number | undefined) ?? 0) + 1 } }]);
      });
    }
    await children;
    expect(await countOf(mine)).toBe(150);
  }, 60_000);
});

describe('a lock held too long', () => {
  it('surfaces as a BUSY error that says what happened, and as STORAGE_ERROR through write()', async () => {
    const path = newPath();
    const holder = adapterAt(path);
    const waiter = adapterAt(path, 100);
    await holder.graphs.create('g');

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    const long = holder.transaction('g', async () => {
      started();
      await held;
    });
    await begun;

    const t0 = Date.now();
    const direct = await waiter.transaction('g', async () => 1).catch((cause: unknown) => cause);
    expect(direct).toBeInstanceOf(DbError);
    expect((direct as DbError).code).toBe('BUSY');
    expect((direct as DbError).message).toMatch(/locked by another connection or process; gave up after waiting 100 ms/);
    expect((direct as DbError).message).toContain(path);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90); // it really waited for the timeout

    const viaCore = await write(waiter, mutation([upsert('item', 'a')]));
    expect(viaCore).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(JSON.stringify(viaCore)).toContain('locked by another connection');

    release();
    await long;
    // nothing was lost or half-done, and the waiter works again once the lock is free
    expect(await write(waiter, mutation([upsert('item', 'a')]))).toMatchObject({ ok: true });
    expect((await snapshot(holder)).items.map((i) => i.id)).toEqual(['a']);
  });

  it('a creating call that cannot get the lock fails the same way, without changing anything', async () => {
    const path = newPath();
    const holder = adapterAt(path);
    const waiter = adapterAt(path, 50);
    await holder.graphs.create('g');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    const long = holder.transaction('g', async () => {
      started();
      await held;
    });
    await begun;
    await expect(waiter.graphs.create('other')).rejects.toMatchObject({ code: 'BUSY' });
    release();
    await long;
    expect(await waiter.graphs.exists('other')).toBe(false);
  });
});
