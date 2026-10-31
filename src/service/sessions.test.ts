import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baseConfig } from './service.test-util.js';
import type { ServiceConfig } from './config.js';
import { startService, type RunningService } from './service.js';

const PW = 'correct horse battery staple';
const DAY = 86_400_000;
const running: RunningService[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(extra: Partial<ServiceConfig> = {}, now: { value: number } = { value: Date.now() }): Promise<{ service: RunningService; now: { value: number }; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'caci-sessions-'));
  dirs.push(dir);
  const service = await startService({ ...baseConfig(dir), ...extra }, { clock: () => now.value });
  running.push(service);
  return { service, now, dir };
}
async function signIn(port: number): Promise<{ cookie: string; maxAge: number }> {
  const post = (path: string, body: unknown): Promise<Response> => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post('/api/register', { username: 'ann', displayName: 'Ann', password: PW });
  const res = await post('/api/login', { username: 'ann', password: PW });
  const set = res.headers.get('set-cookie') ?? '';
  return { cookie: set.split(';')[0] ?? '', maxAge: Number(/Max-Age=(\d+)/.exec(set)?.[1]) };
}
const me = async (port: number, cookie: string): Promise<number> => (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { cookie } })).status;

describe('how long a login lasts (the shipped defaults and the two settings)', () => {
  it('with the shipped settings a phone used every few days stays signed in, well past 30 minutes', async () => {
    const { service, now } = await start();
    const { cookie } = await signIn(service.port);
    now.value += 3 * DAY;
    expect(await me(service.port, cookie)).toBe(200);
    now.value += 6 * DAY; // 9 days after login, never idle for more than 6
    expect(await me(service.port, cookie)).toBe(200);
  });

  it('is signed out after the idle days without use, and after the session days whatever the use', async () => {
    const idle = await start({ sessionIdleDays: 2, sessionDays: 10 });
    const a = await signIn(idle.service.port);
    idle.now.value += 2 * DAY + 1;
    expect(await me(idle.service.port, a.cookie)).toBe(401);

    const abs = await start({ sessionIdleDays: 2, sessionDays: 5 });
    const b = await signIn(abs.service.port);
    for (let i = 0; i < 4; i += 1) {
      abs.now.value += DAY + DAY / 2;
      const status = await me(abs.service.port, b.cookie);
      expect(status, `step ${i}`).toBe(i < 3 ? 200 : 401); // 1.5, 3, 4.5 days are inside 5; 6 days is not
    }
  });

  it('the cookie lives as long as the session days', async () => {
    expect((await signIn((await start()).service.port)).maxAge).toBe(30 * 86_400);
    expect((await signIn((await start({ sessionDays: 3, sessionIdleDays: 1 })).service.port)).maxAge).toBe(3 * 86_400);
  });

  it('changing the password still ends the other logins', async () => {
    const { service } = await start();
    const first = await signIn(service.port);
    const login = await fetch(`http://127.0.0.1:${service.port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ann', password: PW }) });
    const second = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const change = await fetch(`http://127.0.0.1:${service.port}/api/me/password`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: second }, body: JSON.stringify({ currentPassword: PW, newPassword: 'another long passphrase 42' }) });
    expect([200, 204]).toContain(change.status);
    expect(await me(service.port, first.cookie)).toBe(401);
    expect(await me(service.port, second)).toBe(200);
  });
});
