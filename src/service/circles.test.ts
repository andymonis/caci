import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ServiceConfig } from './config.js';
import { startService, type RunningService } from './service.js';

// Circles through the running service: real SQLite files, real HTTP, nothing mocked.

const PW = 'correct horse 7 staple';
const DAY = 86_400_000;
const dirs: string[] = [];
const running: RunningService[] = [];
const seen: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  const all = seen.join('\n');
  expect(seen.length).toBeGreaterThan(30);
  for (const leak of [PW, 'scrypt$', 'passwordHash', 'example.com']) expect(all.includes(leak), leak).toBe(false);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-circles-svc-'));
  dirs.push(dir);
  return dir;
};
const config = (dataDir: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 0, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, ...extra });
async function start(dataDir: string, extra: Partial<ServiceConfig> = {}): Promise<RunningService> {
  const service = await startService(config(dataDir, extra));
  running.push(service);
  return service;
}

interface Reply {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
}
function browser(port: number) {
  let cookie: string | undefined;
  return {
    async call(method: string, path: string, body?: unknown): Promise<Reply> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      if (path.startsWith('/api/circles') || path.startsWith('/api/invitations')) seen.push(text);
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text), text };
    },
    async signIn(name: string): Promise<void> {
      await this.call('POST', '/api/register', { username: name, displayName: name, password: PW });
      await this.call('POST', '/api/login', { username: name, password: PW });
    },
  };
}
/** Two people and a circle ann owns, with bob invited as `role` and having accepted. */
async function circleOf(service: RunningService, role = 'manager') {
  const ann = browser(service.port);
  const bob = browser(service.port);
  await ann.signIn('ann');
  await bob.signIn('bob');
  const id = (await ann.call('POST', '/api/circles', { name: 'Neighbours', description: 'Next door' })).json.circle.id as string;
  expect((await ann.call('POST', `/api/circles/${id}/invitations`, { username: 'bob', role })).status).toBe(202);
  const invitation = (await bob.call('GET', '/api/invitations')).json.items[0].id as string;
  expect((await bob.call('POST', `/api/invitations/${invitation}/accept`)).status).toBe(200);
  return { ann, bob, id };
}

describe('circles in the running service', () => {
  it('create, invite, accept, change a role, remove and leave, over real HTTP and real files', async () => {
    const service = await start(tmp());
    const { ann, bob, id } = await circleOf(service);
    const roster = (await ann.call('GET', `/api/circles/${id}/members`)).json.items as Array<{ username: string; role: string }>;
    expect(Object.fromEntries(roster.map((m) => [m.username, m.role]))).toEqual({ ann: 'owner', bob: 'manager' });
    const cat = browser(service.port);
    await cat.signIn('cat');
    await bob.call('POST', `/api/circles/${id}/invitations`, { username: 'cat', role: 'member' });
    const invitation = (await cat.call('GET', '/api/invitations')).json.items[0].id as string;
    expect((await cat.call('POST', `/api/invitations/${invitation}/accept`)).json.circle).toMatchObject({ name: 'Neighbours', role: 'member', memberCount: 3 });
    const catId = (await ann.call('GET', `/api/circles/${id}/members`)).json.items.find((m: { username: string }) => m.username === 'cat').userId as string;
    expect((await bob.call('PATCH', `/api/circles/${id}/members/${catId}`, { role: 'observer' })).json.member.role).toBe('observer');
    expect((await ann.call('DELETE', `/api/circles/${id}/members/${catId}`)).status).toBe(204);
    expect((await cat.call('GET', `/api/circles/${id}`)).status).toBe(404);
    expect((await bob.call('POST', `/api/circles/${id}/leave`)).status).toBe(204);
    expect((await ann.call('POST', `/api/circles/${id}/leave`)).status).toBe(409); // the only owner
  });

  it('a stranger is told the circle does not exist, and the platform admin is a stranger too', async () => {
    const service = await start(tmp());
    const root = browser(service.port);
    await root.signIn('root'); // the first account is the admin
    const { id } = await circleOf(service);
    for (const [method, path] of [['GET', `/api/circles/${id}`], ['GET', `/api/circles/${id}/members`], ['GET', `/api/circles/${id}/invitations`], ['DELETE', `/api/circles/${id}`]] as const) {
      const r = await root.call(method, path);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json).toEqual({ error: { code: 'NOT_FOUND', message: 'no such circle' } });
    }
    expect((await root.call('GET', '/api/circles')).json.items).toEqual([]);
  });

  it('a restart keeps circles, members and open invitations', async () => {
    const dir = tmp();
    const first = await start(dir);
    const { ann, id } = await circleOf(first);
    await ann.call('POST', `/api/circles/${id}/invitations`, { username: 'zed', role: 'observer' });
    await first.close();
    running.splice(running.indexOf(first), 1);

    const second = await start(dir);
    const again = browser(second.port);
    await again.call('POST', '/api/login', { username: 'ann', password: PW });
    expect((await again.call('GET', '/api/circles')).json.items).toMatchObject([{ id, name: 'Neighbours', description: 'Next door', role: 'owner', memberCount: 2 }]);
    const open = (await again.call('GET', `/api/circles/${id}/invitations`)).json.items as Array<{ username: string; role: string }>;
    expect(open.map((i) => [i.username, i.role])).toEqual([['zed', 'observer']]);
    const roster = (await again.call('GET', `/api/circles/${id}/members`)).json.items as Array<{ username: string }>;
    expect(roster.map((m) => m.username).sort()).toEqual(['ann', 'bob']);
  });

  it('a clean close still leaves only the two database files', async () => {
    const dir = tmp();
    const service = await start(dir);
    await circleOf(service);
    await service.close();
    running.splice(running.indexOf(service), 1);
    expect(readdirSync(dir).sort()).toEqual(['graphs.db', 'users.db']);
  });

  it('the settings are used: the circles a person may be in, the people in a circle, and how long an invitation lasts', async () => {
    const service = await start(tmp(), { maxCirclesPerUser: 1, maxMembersPerCircle: 2, invitationDays: 2 });
    const ann = browser(service.port);
    const bob = browser(service.port);
    const cat = browser(service.port);
    for (const [who, name] of [[ann, 'ann'], [bob, 'bob'], [cat, 'cat']] as const) await who.signIn(name);
    const id = (await ann.call('POST', '/api/circles', { name: 'One' })).json.circle.id as string;
    const second = await ann.call('POST', '/api/circles', { name: 'Two' });
    expect(second.status).toBe(429);
    expect(second.json.error.code).toBe('LIMIT_REACHED');
    await ann.call('POST', `/api/circles/${id}/invitations`, { username: 'bob', role: 'member' });
    await ann.call('POST', `/api/circles/${id}/invitations`, { username: 'cat', role: 'member' });
    const mineBob = (await bob.call('GET', '/api/invitations')).json.items[0] as { id: string; createdAt: number; expiresAt: number };
    expect(mineBob.expiresAt - mineBob.createdAt).toBe(2 * DAY);
    expect((await bob.call('POST', `/api/invitations/${mineBob.id}/accept`)).status).toBe(200);
    const mineCat = (await cat.call('GET', '/api/invitations')).json.items[0] as { id: string };
    const full = await cat.call('POST', `/api/invitations/${mineCat.id}/accept`);
    expect(full.status).toBe(429);
    expect(full.json.error.code).toBe('LIMIT_REACHED');
    expect((await cat.call('GET', '/api/invitations')).json.items).toHaveLength(1); // still open
  });

  it('two accounts, same circle names, stay apart', async () => {
    const service = await start(tmp());
    const ann = browser(service.port);
    const bob = browser(service.port);
    await ann.signIn('ann');
    await bob.signIn('bob');
    const one = (await ann.call('POST', '/api/circles', { name: 'Same' })).json.circle.id as string;
    const two = (await bob.call('POST', '/api/circles', { name: 'Same' })).json.circle.id as string;
    expect(one).not.toBe(two);
    expect((await ann.call('GET', '/api/circles')).json.items.map((c: { id: string }) => c.id)).toEqual([one]);
    expect((await bob.call('GET', `/api/circles/${one}`)).status).toBe(404);
  });
});

describe('secure cookies', () => {
  it('with secure cookies, a stale session on the circle and invitation routes is cleared with the Secure attribute too', async () => {
    const service = await start(tmp(), { cookieSecure: true });
    for (const [method, path] of [['GET', '/api/circles'], ['POST', '/api/circles/cx/leave'], ['GET', '/api/invitations'], ['POST', '/api/invitations/ix/accept']] as const) {
      const res = await fetch(`http://127.0.0.1:${service.port}${path}`, { method, headers: { cookie: `caci_session=${'A'.repeat(43)}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) } });
      expect(res.status, path).toBe(401);
      expect(res.headers.get('set-cookie'), path).toMatch(/Max-Age=0.*; Secure|Secure.*Max-Age=0/);
    }
  });
});

describe('deleting an account', () => {
  it('through the real service, a person who deletes their account leaves every circle and a circle they solely owned passes on', async () => {
    const service = await start(tmp());
    await browser(service.port).signIn('root'); // the first account is the admin, so ann (the only admin would be refused) is an ordinary user
    const { ann, bob, id } = await circleOf(service, 'member');
    await bob.call('POST', `/api/circles/${id}/leave`);
    const alone = (await ann.call('POST', '/api/circles', { name: 'Alone' })).json.circle.id as string;
    // bob rejoins as a plain member, so ann is the sole owner of two circles: one with bob, one alone
    await ann.call('POST', `/api/circles/${id}/invitations`, { username: 'bob', role: 'observer' });
    await bob.call('POST', `/api/invitations/${(await bob.call('GET', '/api/invitations')).json.items[0].id}/accept`);
    await ann.call('POST', `/api/circles/${alone}/invitations`, { username: 'bob', role: 'member' }); // an open invitation to bob
    const deleted = await ann.call('DELETE', '/api/me', { password: PW });
    expect(deleted.status).toBe(204);
    expect((await bob.call('GET', `/api/circles/${id}`)).json.circle).toMatchObject({ role: 'owner', memberCount: 1 }); // handed over to the only other person
    expect((await bob.call('GET', `/api/circles/${alone}`)).status).toBe(404); // she was alone in it: it no longer exists
    expect((await bob.call('GET', '/api/invitations')).json.items).toEqual([]); // her invitation to bob went with her
  });

  it('an admin deleting someone else\'s account does the same', async () => {
    const service = await start(tmp());
    const root = browser(service.port);
    await root.signIn('root'); // the first account is the admin
    const { ann, bob, id } = await circleOf(service, 'manager');
    const annId = (await bob.call('GET', `/api/circles/${id}/members`)).json.items.find((m: { username: string }) => m.username === 'ann').userId as string;
    expect((await root.call('DELETE', `/api/users/${annId}`)).status).toBe(204);
    expect((await bob.call('GET', `/api/circles/${id}`)).json.circle).toMatchObject({ role: 'owner', memberCount: 1 });
    expect((await ann.call('GET', '/api/circles')).status).toBe(401); // her sessions went too
  });
});
