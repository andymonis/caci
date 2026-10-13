import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceConfig } from './config.js';
import { startService, type RunningService } from './service.js';

// Grants through the running service: real SQLite files, real HTTP, the demo model to fill a brain.

const PW = 'correct horse 7 staple';
const dirs: string[] = [];
const running: RunningService[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-sharing-svc-'));
  dirs.push(dir);
  return dir;
};
const config = (dataDir: string, cookieSecure = false): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure, trustedProxies: 0, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, maxBrainScopes: 25, statusPerHour: 20 });
async function start(dataDir: string, cookieSecure = false): Promise<RunningService> {
  const service = await startService(config(dataDir, cookieSecure));
  running.push(service);
  return service;
}
async function stop(service: RunningService): Promise<void> {
  running.splice(running.indexOf(service), 1);
  await service.close();
}

interface Reply {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
/** One person's browser: a cookie jar and a port that can change (a restart). */
function browser(getPort: () => number) {
  let cookie: string | undefined;
  return {
    async call(method: string, path: string, body?: unknown): Promise<Reply> {
      const res = await fetch(`http://127.0.0.1:${getPort()}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text) };
    },
    async signIn(name: string): Promise<void> {
      await this.call('POST', '/api/register', { username: name, displayName: name, password: PW });
      await this.call('POST', '/api/login', { username: name, password: PW });
    },
  };
}

async function setup(service: { port: number }) {
  const port = { value: service.port };
  const get = () => port.value;
  const ann = browser(get);
  const bob = browser(get);
  const cat = browser(get);
  await ann.signIn('ann');
  await bob.signIn('bob');
  await cat.signIn('cat');
  const circle = (await ann.call('POST', '/api/circles', { name: 'Club' })).json.circle.id as string;
  for (const [who, name] of [[bob, 'bob'], [cat, 'cat']] as const) {
    await ann.call('POST', `/api/circles/${circle}/invitations`, { username: name, role: 'member' });
    const inv = (await who.call('GET', '/api/invitations')).json.items[0].id as string;
    await who.call('POST', `/api/invitations/${inv}/accept`);
  }
  const members = (await ann.call('GET', `/api/circles/${circle}/members`)).json.items as Array<{ username: string; userId: string }>;
  const idOf = (name: string) => members.find((m) => m.username === name)?.userId as string;
  const note = await ann.call('POST', '/api/capture/propose', { text: 'Booked dentist appointment for Tuesday' });
  expect((await ann.call('POST', `/api/capture/proposals/${note.json.proposal.id}/approve`)).status).toBe(200);
  const categories = (await ann.call('GET', '/api/graph/categories')).json.items as Array<{ id: string }>;
  return { port, ann, bob, cat, circle, idOf, category: categories[0]?.id as string };
}

describe('grants in the running service', () => {
  it('are set and withdrawn over HTTP, kept across a restart, and a stranger and the administrator read nothing', async () => {
    const dir = tmp();
    let service = await start(dir);
    const { port, ann, bob, circle, idOf, category } = await setup(service);
    const set = await ann.call('PUT', `/api/circles/${circle}/grants/${idOf('bob')}`, { categories: [category] });
    expect(set.status).toBe(200);
    expect(set.json.grant.categories).toHaveLength(1);

    await stop(service);
    service = await start(dir);
    port.value = service.port;
    const after = await ann.call('GET', `/api/circles/${circle}/grants`);
    expect(after.json.items.map((g: { userId: string }) => g.userId)).toEqual([idOf('bob')]);

    // bob (a member with no grant of his own) lists nothing; a stranger gets the made-up-circle answer
    expect((await bob.call('GET', `/api/circles/${circle}/grants`)).json.items).toEqual([]);
    const stranger = browser(() => port.value);
    await stranger.signIn('dan');
    expect((await stranger.call('GET', `/api/circles/${circle}/grants`)).json.error).toEqual({ code: 'NOT_FOUND', message: 'no such circle' });
    expect((await ann.call('DELETE', `/api/circles/${circle}/grants/${idOf('bob')}`)).status).toBe(204);
    expect((await ann.call('GET', `/api/circles/${circle}/grants`)).json.items).toEqual([]);
  });

  it('end when the person is removed, leaves or deletes the account, and with the circle', async () => {
    const service = await start(tmp());
    const { ann, bob, cat, circle, idOf, category } = await setup(service);
    for (const who of ['bob', 'cat']) await ann.call('PUT', `/api/circles/${circle}/grants/${idOf(who)}`, { categories: [category] });
    expect((await ann.call('GET', `/api/circles/${circle}/grants`)).json.items).toHaveLength(2);

    expect((await ann.call('DELETE', `/api/circles/${circle}/members/${idOf('bob')}`)).status).toBe(204);
    expect((await ann.call('GET', `/api/circles/${circle}/grants`)).json.items.map((g: { userId: string }) => g.userId)).toEqual([idOf('cat')]);
    expect((await bob.call('GET', `/api/circles/${circle}/grants`)).status).toBe(404);

    // cat deletes the account: the grant to cat goes with it
    expect((await cat.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    expect((await ann.call('GET', `/api/circles/${circle}/grants`)).json.items).toEqual([]);

    // a grant, then the circle goes: nothing is left, and a new circle starts clean
    await ann.call('POST', `/api/circles/${circle}/invitations`, { username: 'bob', role: 'member' });
    const inv = (await bob.call('GET', '/api/invitations')).json.items[0].id as string;
    await bob.call('POST', `/api/invitations/${inv}/accept`);
    await ann.call('PUT', `/api/circles/${circle}/grants/${idOf('bob')}`, { categories: [category] });
    expect((await ann.call('DELETE', `/api/circles/${circle}`)).status).toBe(204);
    expect((await ann.call('GET', `/api/circles/${circle}/grants`)).status).toBe(404);
  });

  it('clears a stale cookie with the Secure attribute when secure cookies are on', async () => {
    const service = await start(tmp(), true);
    const res = await fetch(`http://127.0.0.1:${service.port}/api/circles/c0000000000000000/grants`, { headers: { cookie: 'caci_session=stale' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0.*Secure|Secure.*Max-Age=0/);
  });
});
