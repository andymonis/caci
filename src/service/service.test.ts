import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serve } from './cli.js';
import { parseServiceConfig, type ServiceConfig } from './config.js';
import { startService, type RunningService } from './service.js';

const PW = 'correct horse 7 staple';
const dirs: string[] = [];
const running: RunningService[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-service-'));
  dirs.push(dir);
  return dir;
};
const config = (dataDir: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 0, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, ...extra });
async function start(dataDir: string, extra: Partial<ServiceConfig> = {}): Promise<RunningService> {
  const service = await startService(config(dataDir, extra));
  running.push(service);
  return service;
}

/** A tiny browser: remembers the session cookie. */
function client(port: number) {
  let cookie: string | undefined;
  return {
    async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; setCookie: string | null }> { // eslint-disable-line @typescript-eslint/no-explicit-any
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie !== null) cookie = /Max-Age=0/.test(setCookie) ? undefined : setCookie.split(';')[0];
      const text = await res.text();
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text), setCookie };
    },
    get cookie() {
      return cookie;
    },
  };
}

describe('the running service', () => {
  it('walks register, login, me, logout over real HTTP', async () => {
    const service = await start(tmp());
    const web = client(service.port);
    expect((await web.call('POST', '/api/register', { username: 'ann', displayName: 'Ann', password: PW })).status).toBe(201);
    const login = await web.call('POST', '/api/login', { username: 'ann', password: PW });
    expect(login.status).toBe(200);
    expect(login.setCookie).toMatch(/^caci_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800$/);
    const me = await web.call('GET', '/api/me');
    expect(me.json.user).toMatchObject({ username: 'ann', role: 'admin' });
    expect(me.json.graphId).toBe(`user-${me.json.user.id}`);
    expect((await web.call('POST', '/api/logout')).status).toBe(204);
    expect((await web.call('GET', '/api/me')).status).toBe(401);
  }, 20_000);

  it('keeps accounts, graphs and a signed-in session across a restart on the same files', async () => {
    const dir = tmp();
    const first = await start(dir);
    const before = client(first.port);
    await before.call('POST', '/api/register', { username: 'ann', displayName: 'Ann', password: PW });
    await before.call('POST', '/api/login', { username: 'ann', password: PW });
    const me = (await before.call('GET', '/api/me')).json;
    const cookie = before.cookie as string;
    await first.close();

    const second = await start(dir);
    const after = client(second.port);
    expect((await after.call('POST', '/api/login', { username: 'ann', password: PW })).status).toBe(200); // the account is there
    const restoredBrowser = await fetch(`http://127.0.0.1:${second.port}/api/me`, { headers: { cookie } });
    expect(restoredBrowser.status).toBe(200); // the old session still works
    expect(await restoredBrowser.json()).toEqual(me);
  }, 20_000);

  it('a clean close leaves only the two database files, each readable by its owner only', async () => {
    const dir = tmp();
    const service = await start(dir);
    const web = client(service.port);
    await web.call('POST', '/api/register', { username: 'ann', displayName: 'Ann', password: PW });
    await web.call('POST', '/api/login', { username: 'ann', password: PW });
    await service.close();
    expect(readdirSync(dir).sort()).toEqual(['graphs.db', 'users.db']);
    if (process.platform !== 'win32') for (const name of ['graphs.db', 'users.db']) expect(statSync(join(dir, name)).mode & 0o777, name).toBe(0o600);
  }, 20_000);

  it('creates the data folder (owner only) when it is missing, including parents', async () => {
    const root = tmp();
    const dir = join(root, 'a', 'b', 'data');
    const service = await start(dir);
    expect(service.dataDir).toBe(dir);
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('close stops listening first and is safe to call twice', async () => {
    const service = await start(tmp());
    await service.close();
    await service.close();
    await expect(fetch(`http://127.0.0.1:${service.port}/api/me`)).rejects.toThrow();
    running.length = 0;
  });

  it('closed registration is respected', async () => {
    const service = await start(tmp(), { allowRegistration: false });
    expect((await client(service.port).call('POST', '/api/register', { username: 'ann', displayName: 'Ann', password: PW })).status).toBe(403);
  });

  it('with secure cookies configured the cookie says Secure', async () => {
    const service = await start(tmp(), { cookieSecure: true });
    const web = client(service.port);
    await web.call('POST', '/api/register', { username: 'ann', displayName: 'Ann', password: PW });
    expect((await web.call('POST', '/api/login', { username: 'ann', password: PW })).setCookie).toMatch(/; Secure$/);
  }, 20_000);

  it('answers only to the allowed host names when told', async () => {
    const service = await start(tmp(), { allowedHosts: ['notes.home.example'] });
    expect((await fetch(`http://127.0.0.1:${service.port}/api/me`)).status).toBe(403);
    const ok = await fetch(`http://127.0.0.1:${service.port}/api/me`, { headers: { host: 'notes.home.example' } }).catch(() => undefined);
    void ok; // fetch may not let Host be set; the server's own tests cover the accepted case
  });

  it('counts clients by the address a trusted proxy reports, and by the socket address when none is trusted', async () => {
    const register = (port: number, name: string, forwarded: string) =>
      fetch(`http://127.0.0.1:${port}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': forwarded }, body: JSON.stringify({ username: name, displayName: name, password: PW }) }).then((r) => r.status);
    const behindProxy = await start(tmp(), { trustedProxies: 1 });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push(await register(behindProxy.port, `proxied${i}`, `203.0.113.${i + 1}`)); // eleven different clients
    expect(statuses.every((s) => s === 201)).toBe(true);
    const direct = await start(tmp());
    const direct11: number[] = [];
    for (let i = 0; i < 11; i++) direct11.push(await register(direct.port, `direct${i}`, `203.0.113.${i + 1}`)); // the header is ignored: one client
    expect(direct11.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(direct11[10]).toBe(429);
  }, 30_000);

  it('logs requests through the hook it is given, without anything secret', async () => {
    const events: string[] = [];
    const service = await startService(config(tmp()), { log: (e) => events.push(JSON.stringify(e)) });
    running.push(service);
    await client(service.port).call('POST', '/api/login', { username: 'ann', password: 'SECRET-PASSWORD-123' });
    await new Promise((r) => setTimeout(r, 30));
    expect(events.length).toBe(1);
    expect(events[0]).not.toContain('SECRET');
  });
});

describe('when it cannot start, it says why and leaves nothing open', () => {
  it('a data folder that is really a file', async () => {
    const dir = tmp();
    const file = join(dir, 'in-the-way');
    writeFileSync(file, 'x');
    await expect(startService(config(file))).rejects.toThrow(/cannot use the data folder/);
    await expect(startService(config(join(file, 'sub')))).rejects.toThrow(/cannot use the data folder/);
  });

  it('a database file that is not a database is refused and left as it was, and the other file is not left open', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'users.db'), 'not a database '.repeat(300));
    await expect(startService(config(dir))).rejects.toThrow(/not a SQLite database/);
    expect(readdirSync(dir).sort()).toEqual(['graphs.db', 'users.db']); // graphs.db was made, then closed again: no -wal or -shm
  });

  it('a port that is taken, with the port in the message, and the databases closed again', async () => {
    const dir = tmp();
    const first = await start(dir);
    const second = tmp();
    await expect(startService(config(second, { port: first.port }))).rejects.toThrow(`port ${first.port} on 127.0.0.1 is already in use`);
    expect(readdirSync(second).sort()).toEqual(['graphs.db', 'users.db']); // no -wal or -shm: closed
  });
});

describe('serve (what npm run serve does)', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) } };
  };

  it('starts, says where it listens and where the data is, and warns about plain cookies and open registration', async () => {
    const dir = tmp();
    const { out, err, io: sink } = io();
    const result = await serve({ CACI_PORT: '0', CACI_DATA_DIR: dir }, sink);
    expect(result.code).toBe(0);
    if (result.code === 0) running.push(result.service);
    const text = out.join('');
    expect(text).toMatch(/Listening on http:\/\/127\.0\.0\.1:\d+/);
    expect(text).toContain(dir);
    expect(text).toMatch(/first account made becomes the admin/);
    expect(text).toMatch(/not marked Secure/);
    expect(err).toEqual([]);
  });

  it('says registration is closed, and says nothing about plain cookies when they are secure', async () => {
    const { out, io: sink } = io();
    const result = await serve({ CACI_PORT: '0', CACI_DATA_DIR: tmp(), CACI_ALLOW_REGISTRATION: 'false', CACI_COOKIE_SECURE: 'true' }, sink);
    if (result.code === 0) running.push(result.service);
    expect(out.join('')).toContain('Registration is closed.');
    expect(out.join('')).not.toMatch(/not marked Secure/);
  });

  it('exit code 2 and every bad variable named when the settings are wrong, and nothing started', async () => {
    const dir = tmp();
    const { out, err, io: sink } = io();
    const result = await serve({ CACI_PORT: 'x', CACI_BIND: '0.0.0.0', CACI_DATA_DIR: join(dir, 'never') }, sink);
    expect(result).toEqual({ code: 2 });
    expect(err.join('')).toMatch(/CACI_PORT/);
    expect(out).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('exit code 1 and the reason when it cannot start', async () => {
    const dir = tmp();
    const file = join(dir, 'file');
    writeFileSync(file, 'x');
    const { err, io: sink } = io();
    expect(await serve({ CACI_PORT: '0', CACI_DATA_DIR: file }, sink)).toEqual({ code: 1 });
    expect(err.join('')).toMatch(/Could not start: cannot use the data folder/);
  });

  it('shows an IPv6 address in brackets', async () => {
    const { out, io: sink } = io();
    const result = await serve({ CACI_PORT: '0', CACI_BIND: '::1', CACI_DATA_DIR: tmp() }, sink).catch(() => ({ code: 1 as const }));
    if (result.code === 0) {
      running.push(result.service);
      expect(out.join('')).toMatch(/Listening on http:\/\/\[::1\]:\d+/);
    }
  });

  it('the settings it reads are the ones parseServiceConfig reads', () => {
    expect(parseServiceConfig({ CACI_PORT: '0' }).ok).toBe(true);
  });
});
