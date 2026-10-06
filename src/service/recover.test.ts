import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverAdmin, USAGE, type RecoverIo } from './recover.js';
import { startService, type RunningService } from './service.js';
import type { ServiceConfig } from './config.js';

const PW = 'correct horse 7 staple';
const NEW_PW = 'brand new long passphrase 5';
const dirs: string[] = [];
const running: RunningService[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const config = (dataDir: string): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 0, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10 });
const post = async (port: number, path: string, body: unknown, cookie?: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) }, body: JSON.stringify(body) });
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], json: res.status === 204 ? undefined : await res.json() };
};

/** A data folder with an admin (ann), an ordinary user (bob), and one signed-in session each; the service is then stopped. */
async function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'caci-recover-'));
  dirs.push(dir);
  const service = await startService(config(dir));
  for (const name of ['ann', 'bob']) await post(service.port, '/api/register', { username: name, displayName: name, password: PW });
  const ann = await post(service.port, '/api/login', { username: 'ann', password: PW });
  const bob = await post(service.port, '/api/login', { username: 'bob', password: PW });
  await service.close();
  return { dir, annCookie: ann.cookie as string, bobCookie: bob.cookie as string };
}

function io(password: string | (() => Promise<string>) = NEW_PW) {
  const out: string[] = [];
  const err: string[] = [];
  let asked = 0;
  const sink: RecoverIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readPassword: async () => {
      asked++;
      return typeof password === 'string' ? password : password();
    },
  };
  return { out, err, sink, asked: () => asked };
}

describe('recover-admin', () => {
  it('sets a new password for the admin, ends their sessions, and leaves everyone else alone', async () => {
    const { dir, annCookie, bobCookie } = await folder();
    const { out, err, sink } = io();
    expect(await recoverAdmin(['ann'], { CACI_DATA_DIR: dir }, sink)).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('')).toBe('The password for admin ann has been reset; 1 session was ended. Nobody else was affected.\n');

    const service = await startService(config(dir));
    running.push(service);
    expect((await post(service.port, '/api/login', { username: 'ann', password: NEW_PW })).status).toBe(200);
    expect((await post(service.port, '/api/login', { username: 'ann', password: PW })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${service.port}/api/me`, { headers: { cookie: annCookie } })).status).toBe(401); // ann's old session ended
    expect((await fetch(`http://127.0.0.1:${service.port}/api/me`, { headers: { cookie: bobCookie } })).status).toBe(200); // bob's did not
    expect((await post(service.port, '/api/login', { username: 'bob', password: PW })).status).toBe(200); // nor his password
  }, 30_000);

  it('never prints the password, in any outcome', async () => {
    const { dir } = await folder();
    const all = io();
    await recoverAdmin(['ann'], { CACI_DATA_DIR: dir }, all.sink);
    const weak = io('short');
    await recoverAdmin(['ann'], { CACI_DATA_DIR: dir }, weak.sink);
    for (const text of [...all.out, ...all.err, ...weak.out, ...weak.err]) {
      expect(text).not.toContain(NEW_PW);
      expect(text).not.toContain('short');
    }
  }, 30_000);

  it('works while the service is running (the database serialises the two)', async () => {
    const { dir } = await folder();
    const service = await startService(config(dir));
    running.push(service);
    expect(await recoverAdmin(['ann'], { CACI_DATA_DIR: dir }, io().sink)).toBe(0);
    expect((await post(service.port, '/api/login', { username: 'ann', password: NEW_PW })).status).toBe(200);
  }, 30_000);

  it('applies the password policy and changes nothing when it is not met', async () => {
    const { dir } = await folder();
    for (const bad of ['short', 'qwertyuiop12', 'ann', '']) {
      const { err, sink } = io(bad);
      expect(await recoverAdmin(['ann'], { CACI_DATA_DIR: dir }, sink), bad).toBe(1);
      expect(err.join('')).toMatch(/refused.*Nothing was changed/);
    }
    const service = await startService(config(dir));
    running.push(service);
    expect((await post(service.port, '/api/login', { username: 'ann', password: PW })).status).toBe(200);
  }, 30_000);

  it('refuses a new password equal to the admin\'s own username', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caci-recover-long-'));
    dirs.push(dir);
    const service = await startService(config(dir));
    await post(service.port, '/api/register', { username: 'administrator-account', displayName: 'Admin', password: PW });
    await service.close();
    const { err, sink } = io('administrator-account');
    expect(await recoverAdmin(['administrator-account'], { CACI_DATA_DIR: dir }, sink)).toBe(1);
    expect(err.join('')).toMatch(/same as the username/);
  }, 30_000);

  it('refuses a user who is not an admin and a name that does not exist, with the same words, asking for no password', async () => {
    const { dir } = await folder();
    const ordinary = io();
    const missing = io();
    expect(await recoverAdmin(['bob'], { CACI_DATA_DIR: dir }, ordinary.sink)).toBe(1);
    expect(await recoverAdmin(['nobody'], { CACI_DATA_DIR: dir }, missing.sink)).toBe(1);
    expect(ordinary.err).toEqual(missing.err);
    expect(ordinary.err.join('')).toBe('There is no admin account with that username. Nothing was changed.\n');
    expect(ordinary.asked()).toBe(0);
    expect(missing.asked()).toBe(0);
    const service = await startService(config(dir));
    running.push(service);
    expect((await post(service.port, '/api/login', { username: 'bob', password: PW })).status).toBe(200); // bob's password is untouched
  }, 30_000);

  it('accepts the username in any case, and refuses a malformed one like a missing one', async () => {
    const { dir } = await folder();
    expect(await recoverAdmin(['ANN'], { CACI_DATA_DIR: dir }, io().sink)).toBe(0);
    for (const odd of ['', 'a b', '../x', 'x'.repeat(100)]) expect(await recoverAdmin([odd], { CACI_DATA_DIR: dir }, io().sink), odd).toBe(1);
  }, 30_000);

  it('asks for the password only once the account is found', async () => {
    const { dir } = await folder();
    const found = io();
    await recoverAdmin(['ann'], { CACI_DATA_DIR: dir }, found.sink);
    expect(found.asked()).toBe(1);
  }, 30_000);

  it('uses exit code 2 and the usage for the wrong arguments, touching nothing', async () => {
    const { dir } = await folder();
    for (const args of [[], ['ann', 'extra'], ['ann', '--password', 'x']]) {
      const { err, sink, asked } = io();
      expect(await recoverAdmin(args, { CACI_DATA_DIR: dir }, sink)).toBe(2);
      expect(err.join('')).toBe(`${USAGE}\n`);
      expect(asked()).toBe(0);
    }
  }, 30_000);

  it('uses exit code 2 and names the variable when the settings are wrong', async () => {
    const { err, sink } = io();
    expect(await recoverAdmin(['ann'], { CACI_PORT: 'x' }, sink)).toBe(2);
    expect(err.join('')).toMatch(/CACI_PORT/);
  });

  it('says so, and creates nothing, when there is no user database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caci-recover-empty-'));
    dirs.push(dir);
    const { err, sink } = io();
    expect(await recoverAdmin(['ann'], { CACI_DATA_DIR: dir }, sink)).toBe(1);
    expect(err.join('')).toContain(join(dir, 'users.db'));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reports a failure to read the password, and changes nothing', async () => {
    const { dir } = await folder();
    const { err, sink } = io(async () => {
      throw new Error('the two entries differ');
    });
    expect(await recoverAdmin(['ann'], { CACI_DATA_DIR: dir }, sink)).toBe(1);
    expect(err.join('')).toContain('the two entries differ');
    expect(readdirSync(dir).sort()).toEqual(['graphs.db', 'users.db']); // closed cleanly: no -wal or -shm left
  }, 30_000);

  it('leaves the folder with just the two files after a successful run', async () => {
    const { dir } = await folder();
    await recoverAdmin(['ann'], { CACI_DATA_DIR: dir }, io().sink);
    expect(readdirSync(dir).sort()).toEqual(['graphs.db', 'users.db']);
  }, 30_000);

  it('the command script takes no password argument (checked in the source)', () => {
    const script = readFileSync(new URL('../../scripts/users.mjs', import.meta.url), 'utf8');
    expect(script).toContain('readPassword');
    expect(script).not.toMatch(/process\.argv[^\n]*password/i);
  });
});
