import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GRAPH_SCHEMA_VERSION } from '../graph_store/adapters/sqlite/index.js';
import { openDb } from '../sqlite/db.js';
import { USERS_SCHEMA_VERSION } from '../users/sqlite/index.js';
import { backupData } from './backup.js';
import { restoreData } from './restore.js';
import { startService, type RunningService } from './service.js';
import { baseConfig } from './service.test-util.js';

const PW = 'correct horse 7 staple';
const dirs: string[] = [];
const running: RunningService[] = [];
const folder = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'caci-restore-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const out = () => {
  const o: string[] = [];
  const e: string[] = [];
  return { o, e, io: { stdout: (t: string) => o.push(t), stderr: (t: string) => e.push(t), now: () => Date.UTC(2026, 9, 11, 3, 0, 0) } };
};
function restore(args: string[], data: string) {
  const sink = out();
  const code = restoreData(args, { CACI_DATA_DIR: data }, sink.io);
  return { code, out: sink.o.join(''), err: sink.e.join('') };
}
function backup(data: string, dest: string, now = Date.UTC(2026, 9, 11, 2, 0, 0)): string {
  const sink = out();
  const code = backupData(['--dest', dest], { CACI_DATA_DIR: data }, { ...sink.io, now: () => now });
  expect(code, sink.e.join('')).toBe(0);
  return join(dest, readdirSync(dest).filter((n) => /^\d/.test(n)).sort().at(-1) as string);
}
async function request(port: number, method: string, path: string, body?: unknown, cookie?: string) {
  const origin = `http://127.0.0.1:${port}`;
  const res = await fetch(origin + path, { method, headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], json: res.status === 204 ? undefined : ((await res.json()) as Record<string, unknown>) };
}
const mode = (p: string): number => statSync(p).mode & 0o777;
const same = (a: string, b: string): boolean => readFileSync(a).equals(readFileSync(b));

/** A data folder made by the real service: an account, a circle (so a circle graph), and one approved note. Then stopped. */
async function story() {
  const data = join(folder(), 'data');
  const service = await startService(baseConfig(data));
  const p = service.port;
  await request(p, 'POST', '/api/register', { username: 'ann', displayName: 'Ann', password: PW });
  const login = await request(p, 'POST', '/api/login', { username: 'ann', password: PW });
  const cookie = login.cookie as string;
  const circle = await request(p, 'POST', '/api/circles', { name: 'Club' }, cookie);
  const proposal = await request(p, 'POST', '/api/capture/propose', { text: 'Dentist appointment on Friday morning' }, cookie);
  await request(p, 'POST', `/api/capture/proposals/${(proposal.json?.proposal as { id: string }).id}/approve`, undefined, cookie);
  return { data, service, cookie, circleId: (circle.json?.circle as { id: string }).id };
}
const categories = async (port: number, cookie: string): Promise<number> => ((await request(port, 'GET', '/api/graph/categories', undefined, cookie)).json?.items as unknown[]).length;

describe('restoring a snapshot into a service that has been stopped', () => {
  it('brings back the accounts, circles and notes of the snapshot, and keeps what was there copied aside', async () => {
    const s = await story();
    const dest = join(folder(), 'backups');
    const snapshot = backup(s.data, dest);
    const before = await categories(s.service.port, s.cookie);
    expect(before).toBeGreaterThan(0);
    // afterwards: a second account, the circle gone, another note
    await request(s.service.port, 'POST', '/api/register', { username: 'carol', displayName: 'Carol', password: PW });
    await request(s.service.port, 'DELETE', `/api/circles/${s.circleId}`, undefined, s.cookie);
    const proposal = await request(s.service.port, 'POST', '/api/capture/propose', { text: 'Flight to Lisbon next month' }, s.cookie);
    await request(s.service.port, 'POST', `/api/capture/proposals/${(proposal.json?.proposal as { id: string }).id}/approve`, undefined, s.cookie);
    expect(await categories(s.service.port, s.cookie)).toBeGreaterThan(before);
    await s.service.close();

    const r = restore([snapshot, '--yes'], s.data);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Start the service again');

    const again = await startService(baseConfig(s.data));
    running.push(again);
    const login = await request(again.port, 'POST', '/api/login', { username: 'ann', password: PW });
    expect(login.status).toBe(200);
    expect((await request(again.port, 'POST', '/api/login', { username: 'carol', password: PW })).status).toBe(401);
    expect(await categories(again.port, login.cookie as string)).toBe(before);
    const circles = await request(again.port, 'GET', '/api/circles', undefined, login.cookie);
    expect((circles.json?.items as { id: string }[]).map((c) => c.id)).toEqual([s.circleId]);

    // what was there is kept, beside the snapshots, owner-only, and holds carol
    const asides = readdirSync(dest).filter((n) => n.startsWith('pre-restore-'));
    expect(asides).toEqual(['pre-restore-20261011T030000Z']);
    const aside = join(dest, asides[0] as string);
    expect(readdirSync(aside).sort()).toEqual(['graphs.db', 'users.db']);
    if (process.platform !== 'win32') {
      expect(mode(aside)).toBe(0o700);
      expect(mode(join(aside, 'users.db'))).toBe(0o600);
    }
    const db = openDb({ path: join(aside, 'users.db') });
    expect(Number(db.get<{ n: number }>("SELECT count(*) AS n FROM users WHERE username = 'carol'")?.n)).toBe(1);
    db.close();
  }, 60_000);

  it('leaves the restored files owner-only, with no temporary or stale side files', async () => {
    const s = await story();
    const snapshot = backup(s.data, join(folder(), 'b'));
    await s.service.close();
    writeFileSync(join(s.data, 'graphs.db-wal'), 'stale garbage that must never be applied');
    writeFileSync(join(s.data, 'users.db-shm'), 'stale');
    expect(restore([snapshot, '--yes'], s.data).code).toBe(0);
    expect(readdirSync(s.data).sort()).toEqual(['graphs.db', 'users.db']);
    if (process.platform !== 'win32') expect(mode(join(s.data, 'users.db'))).toBe(0o600);
    expect(same(join(snapshot, 'users.db'), join(s.data, 'users.db'))).toBe(true);
  }, 60_000);

  it('works on a machine that has no data folder yet, creating it owner-only', async () => {
    const s = await story();
    const snapshot = backup(s.data, join(folder(), 'b'));
    await s.service.close();
    const fresh = join(folder(), 'newdata');
    expect(restore([snapshot, '--yes'], fresh).code).toBe(0);
    if (process.platform !== 'win32') expect(mode(fresh)).toBe(0o700);
    expect(readdirSync(fresh).sort()).toEqual(['graphs.db', 'users.db']);
    expect(readdirSync(join(snapshot, '..')).filter((n) => n.startsWith('pre-restore-'))).toEqual([]); // nothing to put aside
    const service = await startService(baseConfig(fresh));
    running.push(service);
    expect((await request(service.port, 'POST', '/api/login', { username: 'ann', password: PW })).status).toBe(200);
  }, 60_000);

  it('a second restore in the same second keeps both sets aside', async () => {
    const s = await story();
    const dest = join(folder(), 'b');
    const snapshot = backup(s.data, dest);
    await s.service.close();
    expect(restore([snapshot, '--yes'], s.data).code).toBe(0);
    expect(restore([snapshot, '--yes'], s.data).code).toBe(0);
    expect(readdirSync(dest).filter((n) => n.startsWith('pre-restore-')).sort()).toEqual(['pre-restore-20261011T030000Z', 'pre-restore-20261011T030000Z-2']);
  }, 60_000);
});

describe('what a restore refuses, changing nothing', () => {
  async function setup() {
    const s = await story();
    const dest = join(folder(), 'b');
    const snapshot = backup(s.data, dest);
    await s.service.close();
    const bytes = { g: readFileSync(join(s.data, 'graphs.db')), u: readFileSync(join(s.data, 'users.db')) };
    const untouched = (): void => {
      expect(readFileSync(join(s.data, 'graphs.db')).equals(bytes.g)).toBe(true);
      expect(readFileSync(join(s.data, 'users.db')).equals(bytes.u)).toBe(true);
      expect(readdirSync(s.data).sort()).toEqual(['graphs.db', 'users.db']);
      expect(readdirSync(dest).filter((n) => n.startsWith('pre-restore-'))).toEqual([]);
    };
    return { s, dest, snapshot, untouched };
  }

  it('without --yes: says the snapshot is good and exits 2', async () => {
    const { s, snapshot, untouched } = await setup();
    const r = restore([snapshot], s.data);
    expect(r.code).toBe(2);
    expect(r.err).toContain('is good');
    expect(r.err).toContain('--yes');
    untouched();
  }, 60_000);

  it('a snapshot that is missing a file, damaged, foreign, swapped, or not a folder', async () => {
    const { s, snapshot, dest, untouched } = await setup();
    const bad = (name: string, edit: (dir: string) => void): void => {
      const copy = join(dest, name);
      mkdirSync(copy);
      writeFileSync(join(copy, 'graphs.db'), readFileSync(join(snapshot, 'graphs.db')));
      writeFileSync(join(copy, 'users.db'), readFileSync(join(snapshot, 'users.db')));
      edit(copy);
      const r = restore([copy, '--yes'], s.data);
      expect(r.code, name).toBe(1);
      expect(r.err, name).toContain('Nothing was changed');
    };
    bad('missing', (d) => rmSync(join(d, 'users.db')));
    bad('junk', (d) => writeFileSync(join(d, 'graphs.db'), 'junk '.repeat(500)));
    bad('swapped', (d) => {
      writeFileSync(join(d, 'graphs.db'), readFileSync(join(snapshot, 'users.db')));
      writeFileSync(join(d, 'users.db'), readFileSync(join(snapshot, 'graphs.db')));
    });
    bad('foreign with a low version', (d) => {
      writeFileSync(join(d, 'graphs.db'), readFileSync(join(snapshot, 'users.db')));
      const db = openDb({ path: join(d, 'graphs.db') });
      db.exec(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`);
      db.close();
    });
    bad('damaged', (d) => {
      rmSync(join(d, 'graphs.db'));
      const fresh = openDb({ path: join(d, 'graphs.db') });
      fresh.exec(`PRAGMA application_id = ${0x43614369}; PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}; CREATE TABLE filler (id INTEGER PRIMARY KEY, text TEXT)`);
      fresh.begin();
      for (let i = 0; i < 4000; i++) fresh.run('INSERT INTO filler (text) VALUES (?)', 'x'.repeat(60));
      fresh.commit();
      fresh.close();
      const bytes = readFileSync(join(d, 'graphs.db'));
      for (let at = 8192; at < bytes.length - 100; at += 4096) bytes.fill(0xff, at + 50, at + 80);
      writeFileSync(join(d, 'graphs.db'), bytes);
    });
    expect(restore([join(dest, 'nothing-here'), '--yes'], s.data).code).toBe(1);
    expect(restore([join(snapshot, 'users.db'), '--yes'], s.data).code).toBe(1);
    untouched();
  }, 60_000);

  it('a snapshot written by a newer version than this build understands', async () => {
    const { s, snapshot, dest, untouched } = await setup();
    for (const [file, newest] of [['users.db', USERS_SCHEMA_VERSION], ['graphs.db', GRAPH_SCHEMA_VERSION]] as const) {
      const copy = join(dest, `newer-${file}`);
      mkdirSync(copy);
      for (const f of ['graphs.db', 'users.db']) writeFileSync(join(copy, f), readFileSync(join(snapshot, f)));
      const db = openDb({ path: join(copy, file) });
      db.exec(`PRAGMA user_version = ${newest + 1}`);
      db.close();
      const r = restore([copy, '--yes'], s.data);
      expect(r.code, file).toBe(1);
      expect(r.err, file).toContain('newer version');
    }
    // exactly the current version is fine
    expect(restore([snapshot, '--yes'], s.data).code).toBe(0);
    void untouched;
  }, 60_000);

  it('a snapshot inside the data folder', async () => {
    const { s, snapshot, untouched } = await setup();
    mkdirSync(join(s.data, 'snap'));
    for (const f of ['graphs.db', 'users.db']) writeFileSync(join(s.data, 'snap', f), readFileSync(join(snapshot, f)));
    const r = restore([join(s.data, 'snap'), '--yes'], s.data);
    expect(r.code).toBe(1);
    expect(readdirSync(s.data).sort()).toEqual(['graphs.db', 'snap', 'users.db']);
    void untouched;
  }, 60_000);

  it('a database that another connection holds locked, as a second line of defence', async () => {
    const { s, untouched, snapshot } = await setup();
    const holder = openDb({ path: join(s.data, 'users.db') });
    holder.begin();
    const r = restore([snapshot, '--yes'], s.data);
    holder.rollback();
    holder.close();
    expect(r.code).toBe(1);
    expect(r.err).toContain('in use');
    untouched();
  }, 60_000);

  it('a destination folder that cannot take the copies aside: nothing is replaced', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const { s, dest, snapshot, untouched } = await setup();
    chmodSync(dest, 0o500);
    const r = restore([snapshot, '--yes'], s.data);
    chmodSync(dest, 0o700);
    expect(r.code).toBe(1);
    expect(r.err).toContain('The restore failed');
    untouched();
  }, 60_000);

  it.each([[[]], [['--yes']], [['a', 'b', '--yes']], [['a', '--force']], [['a', '--yes', '--yes']], [['', '--yes']]])('arguments %j are refused with the usage and exit 2', async (args) => {
    const data = join(folder(), 'data');
    const r = restore(args as string[], data);
    expect(r.code).toBe(2);
    expect(r.err).toContain('Usage: npm run restore');
    expect(existsSync(data)).toBe(false);
  });
});
