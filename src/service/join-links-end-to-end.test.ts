import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { ServiceConfig } from './config.js';
import { startService, type RunningService, type ServiceOptions } from './service.js';

// Join links as people would use them: the real service on real SQLite files, over real HTTP. Each person is a browser with
// an address of their own (behind a simulated proxy), so no per-address limit gets in the way. Nothing is mocked.

vi.setConfig({ testTimeout: 60_000 }); // each test starts a service and makes up to sixteen accounts, which is slow when the whole gate runs at once

const PW = 'correct horse 7 staple';
const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
const dirs: string[] = [];
const running: RunningService[] = [];
const responses: string[] = [];
const tokens: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  const all = responses.join('\n');
  expect(responses.length).toBeGreaterThan(120);
  for (const leak of [PW, 'scrypt$', 'passwordHash', 'example.com', 'graphId', 'user-u', 'caci_session', 'tokenHash']) expect(all.includes(leak), `a response held "${leak}"`).toBe(false);
  expect(tokens.length).toBeGreaterThan(8);
});

const config = (dataDir: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 1, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, maxBrainScopes: 25, statusPerHour: 20, ledgerDays: 90, usageDays: 400, sessionIdleDays: 7, sessionDays: 30, agentAccess: false, joinLinks: true, ...extra });

interface Reply {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  headers: Headers;
}
let addressCounter = 0;
function browser(port: number) {
  let cookie: string | undefined;
  const address = `10.9.${Math.floor(++addressCounter / 250)}.${addressCounter % 250}`;
  return {
    async call(method: string, path: string, body?: unknown): Promise<Reply> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-forwarded-for': address, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      if (path !== '/api/login' && path !== '/api/register') responses.push(text); // those two answer with the person's own graph id
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text), text, headers: res.headers };
    },
    async register(name: string): Promise<string> {
      const registered = await this.call('POST', '/api/register', { username: name, displayName: `Display ${name}`, password: PW });
      await this.call('POST', '/api/login', { username: name, password: PW });
      return registered.json.user.id as string;
    },
    async login(name: string): Promise<void> {
      await this.call('POST', '/api/login', { username: name, password: PW });
    },
  };
}
type Browser = ReturnType<typeof browser>;
const NAMES = ['root', 'ann', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus'] as const;
type Name = (typeof NAMES)[number];

interface World {
  service: RunningService;
  dir: string;
  p: Record<Name, Browser>;
  ids: Record<string, string>;
  now: { value: number };
}
const clocked = (now: { value: number }): ServiceOptions => ({ clock: () => now.value });
async function world(extra: Partial<ServiceConfig> = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'caci-join-e2e-'));
  dirs.push(dir);
  const now = { value: T0 };
  const service = await startService(config(dir, extra), clocked(now));
  running.push(service);
  const p = Object.fromEntries(NAMES.map((n) => [n, browser(service.port)])) as Record<Name, Browser>;
  const ids: Record<string, string> = {};
  for (const n of NAMES) ids[n] = await p[n].register(n);
  return { service, dir, p, ids, now };
}
async function bring(w: World, circle: string, by: Name, name: Name, role: string): Promise<void> {
  expect((await w.p[by].call('POST', `/api/circles/${circle}/invitations`, { username: name, role })).status).toBe(202);
  const invitation = (await w.p[name].call('GET', '/api/invitations')).json.items.find((i: { circle: { id: string } }) => i.circle.id === circle).id as string;
  expect((await w.p[name].call('POST', `/api/invitations/${invitation}/accept`)).status).toBe(200);
}
/** Ann owns a circle with bob (manager), cat (member) and dan (observer). */
async function team(w: World): Promise<string> {
  const id = (await w.p.ann.call('POST', '/api/circles', { name: 'Neighbours' })).json.circle.id as string;
  await bring(w, id, 'ann', 'bob', 'manager');
  await bring(w, id, 'bob', 'cat', 'member');
  await bring(w, id, 'bob', 'dan', 'observer');
  return id;
}
const makeLink = async (w: World, id: string, by: Name, body: Record<string, unknown> = {}) => {
  const r = await w.p[by].call('POST', `/api/circles/${id}/join-links`, { label: 'Group chat', ...body });
  if (r.status === 201) tokens.push(r.json.token as string);
  return r;
};
const roster = async (w: World, id: string): Promise<Record<string, string>> => Object.fromEntries(((await w.p.ann.call('GET', `/api/circles/${id}/members`)).json.items as Array<{ username: string; role: string }>).map((m) => [m.username, m.role]));
const waiting = async (w: World, id: string): Promise<Array<{ id: string; person: { displayName?: string }; role: string }>> => (await w.p.ann.call('GET', `/api/circles/${id}/join-requests`)).json.items;
const NO_LINK = { code: 'NOT_FOUND', message: 'no such join link' };

describe('the switch', () => {
  it('with join links off (the default) every join route is a plain 404, even for a signed-in owner', async () => {
    const w = await world({ joinLinks: false });
    const id = await team(w);
    const probes: Array<[string, string, unknown?]> = [
      ['POST', `/api/circles/${id}/join-links`, { label: 'x' }],
      ['GET', `/api/circles/${id}/join-links`],
      ['DELETE', `/api/circles/${id}/join-links/j0000000000000000`],
      ['POST', '/api/join/preview', { token: 'x' }],
      ['POST', '/api/join', { token: 'x' }],
      ['GET', `/api/circles/${id}/join-requests`],
      ['POST', `/api/circles/${id}/join-requests/r0000000000000000/approve`],
      ['POST', `/api/circles/${id}/join-requests/r0000000000000000/decline`],
      ['GET', '/api/join-requests'],
    ];
    for (const [method, path, body] of probes) {
      const r = await w.p.ann.call(method, path, body);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json.error.code).toBe('NOT_FOUND');
    }
    expect((await w.p.ann.call('PUT', '/api/join', {})).status).toBe(404); // not even a 405: the routes are not there
  });

  it('with it on the routes answer, and the setting is read from CACI_JOIN_LINKS (default false)', async () => {
    const w = await world();
    const id = await team(w);
    expect((await w.p.ann.call('GET', `/api/circles/${id}/join-links`)).status).toBe(200);
    const { parseServiceConfig } = await import('./config.js');
    expect(parseServiceConfig({ CACI_JOIN_LINKS: 'true' })).toMatchObject({ ok: true, value: { joinLinks: true } });
    expect(parseServiceConfig({})).toMatchObject({ ok: true, value: { joinLinks: false } });
  });
});

describe('one link, from making it to joining', () => {
  it('a link made with the defaults allows one use and needs approval: preview, ask, wait, then approval makes a member at the link\'s role', async () => {
    const w = await world();
    const id = await team(w);
    const made = await makeLink(w, id, 'ann');
    expect(made.json.link).toMatchObject({ role: 'observer', maxUses: 1, uses: 0, approval: true, expiresAt: T0 + 7 * DAY });
    expect(made.json.token).toMatch(/^cjoin_[A-Za-z0-9_-]{43}$/);
    const preview = await w.p.eve.call('POST', '/api/join/preview', { token: made.json.token });
    expect(preview.json).toEqual({ preview: { circle: { name: 'Neighbours' }, role: 'observer', createdBy: { displayName: 'Display ann' } } });
    const asked = await w.p.eve.call('POST', '/api/join', { token: made.json.token });
    expect(asked.json).toEqual({ result: { state: 'requested', circle: { name: 'Neighbours' }, role: 'observer', expiresAt: T0 + 7 * DAY } });
    expect((await w.p.eve.call('GET', `/api/circles/${id}`)).status).toBe(404); // asked is not joined
    expect(await roster(w, id)).not.toHaveProperty('eve');
    expect((await w.p.eve.call('GET', '/api/join-requests')).json.items).toEqual([{ id: expect.any(String), circle: { name: 'Neighbours' }, role: 'observer', createdAt: T0, expiresAt: T0 + 7 * DAY }]);
    // the one use was spent by asking, so clicking the link again is the same miss as for a made-up link; the person finds the request in their own list
    const again = await w.p.eve.call('POST', '/api/join', { token: made.json.token });
    expect([again.status, again.json.error]).toEqual([404, NO_LINK]);
    const list = await waiting(w, id);
    expect(list).toEqual([{ id: expect.any(String), person: { displayName: 'Display eve' }, role: 'observer', createdAt: T0, expiresAt: T0 + 7 * DAY }]);
    const approved = await w.p.bob.call('POST', `/api/circles/${id}/join-requests/${list[0]?.id}/approve`);
    expect(approved.json.member).toMatchObject({ username: 'eve', role: 'observer' });
    expect((await roster(w, id)).eve).toBe('observer');
    expect((await w.p.eve.call('GET', `/api/circles/${id}`)).json.circle.role).toBe('observer');
    expect((await w.p.eve.call('GET', '/api/join-requests')).json.items).toEqual([]);
    // the one use is spent: the next person gets the same answer as for a made-up link
    const next = await w.p.fay.call('POST', '/api/join', { token: made.json.token });
    expect([next.status, next.json.error]).toEqual([404, NO_LINK]);
  });

  it('with uses to spare, clicking the link again while waiting says waiting and counts nothing', async () => {
    const w = await world();
    const id = await team(w);
    const made = await makeLink(w, id, 'ann', { uses: 3 });
    expect((await w.p.eve.call('POST', '/api/join', { token: made.json.token })).json.result.state).toBe('requested');
    expect((await w.p.eve.call('POST', '/api/join', { token: made.json.token })).json.result.state).toBe('waiting');
    expect((await w.p.ann.call('GET', `/api/circles/${id}/join-links`)).json.items[0].uses).toBe(1);
    expect(await waiting(w, id)).toHaveLength(1);
  });

  it('declining leaves nothing behind and the use is not given back', async () => {
    const w = await world();
    const id = await team(w);
    const made = await makeLink(w, id, 'ann', { role: 'member' });
    await w.p.eve.call('POST', '/api/join', { token: made.json.token });
    const request = (await waiting(w, id))[0]?.id;
    expect((await w.p.ann.call('POST', `/api/circles/${id}/join-requests/${request}/decline`)).status).toBe(204);
    expect(await roster(w, id)).not.toHaveProperty('eve');
    expect((await w.p.eve.call('GET', '/api/join-requests')).json.items).toEqual([]);
    expect((await w.p.eve.call('POST', '/api/join', { token: made.json.token })).status).toBe(404);
  });

  it('a link with approval off joins at once at the role it offers; someone already in is told so and spends nothing', async () => {
    const w = await world();
    const id = await team(w);
    const made = await makeLink(w, id, 'bob', { role: 'member', approval: false, uses: 3 });
    const joined = await w.p.eve.call('POST', '/api/join', { token: made.json.token });
    expect(joined.json.result).toMatchObject({ state: 'joined', circle: { id, name: 'Neighbours', role: 'member', memberCount: 5 } });
    expect((await roster(w, id)).eve).toBe('member');
    for (const who of ['ann', 'cat', 'eve'] as const) expect((await w.p[who].call('POST', '/api/join', { token: made.json.token })).json.result.state).toBe('member');
    expect((await roster(w, id)).ann).toBe('owner');
    const links = (await w.p.ann.call('GET', `/api/circles/${id}/join-links`)).json.items;
    expect(links[0]).toMatchObject({ uses: 1, maxUses: 3, createdBy: { displayName: 'Display bob' } });
  });

  it('a request lapses after a week and cannot be approved; a link expires at its time', async () => {
    const w = await world();
    const id = await team(w);
    const asks = await makeLink(w, id, 'ann', { uses: 5, days: 30 });
    const short = await makeLink(w, id, 'ann', { days: 1, approval: false });
    await w.p.eve.call('POST', '/api/join', { token: asks.json.token });
    const request = (await waiting(w, id))[0]?.id;
    w.now.value = T0 + 7 * DAY + 1;
    for (const n of NAMES) await w.p[n].login(n); // sessions idle out, so everyone signs in again
    expect(await waiting(w, id)).toEqual([]);
    const late = await w.p.ann.call('POST', `/api/circles/${id}/join-requests/${request}/approve`);
    expect([late.status, late.json.error.message]).toEqual([404, 'no such join request']);
    expect((await w.p.eve.call('GET', '/api/join-requests')).json.items).toEqual([]);
    const expired = await w.p.fay.call('POST', '/api/join', { token: short.json.token });
    expect([expired.status, expired.json.error]).toEqual([404, NO_LINK]);
    expect((await w.p.eve.call('POST', '/api/join', { token: asks.json.token })).json.result.state).toBe('requested'); // may ask again
  });

  it('a revoked link no longer works, but a request already made can still be approved', async () => {
    const w = await world();
    const id = await team(w);
    const made = await makeLink(w, id, 'ann', { uses: 5 });
    await w.p.eve.call('POST', '/api/join', { token: made.json.token });
    expect((await w.p.bob.call('DELETE', `/api/circles/${id}/join-links/${made.json.link.id}`)).status).toBe(204);
    expect((await w.p.fay.call('POST', '/api/join/preview', { token: made.json.token })).json.error).toEqual(NO_LINK);
    expect((await w.p.fay.call('POST', '/api/join', { token: made.json.token })).json.error).toEqual(NO_LINK);
    const request = (await waiting(w, id))[0]?.id;
    expect((await w.p.ann.call('POST', `/api/circles/${id}/join-requests/${request}/approve`)).status).toBe(200);
  });

  it('a full circle refuses to approve, leaves the request waiting, and works when someone leaves', async () => {
    const w = await world({ maxMembersPerCircle: 4 });
    const id = await team(w);
    const made = await makeLink(w, id, 'ann', { uses: 3 });
    await w.p.eve.call('POST', '/api/join', { token: made.json.token });
    const request = (await waiting(w, id))[0]?.id;
    const full = await w.p.ann.call('POST', `/api/circles/${id}/join-requests/${request}/approve`);
    expect([full.status, full.json.error.code]).toEqual([429, 'LIMIT_REACHED']);
    expect(await waiting(w, id)).toHaveLength(1);
    expect((await w.p.dan.call('POST', `/api/circles/${id}/leave`)).status).toBe(204);
    expect((await w.p.ann.call('POST', `/api/circles/${id}/join-requests/${request}/approve`)).status).toBe(200);
  });
});

describe('cookies', () => {
  it('a stale session on a join route is a 401 that clears the cookie, with Secure when the service is configured for it', async () => {
    for (const secure of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), 'caci-join-e2e-'));
      dirs.push(dir);
      const service = await startService(config(dir, { cookieSecure: secure, allowInsecure: secure }));
      running.push(service);
      for (const [method, path] of [['GET', '/api/join-requests'], ['POST', '/api/join']] as const) {
        const res = await fetch(`http://127.0.0.1:${service.port}${path}`, { method, headers: { cookie: `caci_session=${'A'.repeat(43)}`, 'x-forwarded-for': '10.8.0.1', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify({ token: 'x' }) } : {}) });
        expect(res.status, `${method} ${path}`).toBe(401);
        const set = res.headers.get('set-cookie') ?? '';
        expect(set).toMatch(/Max-Age=0/);
        expect(/;\s*Secure/i.test(set), `${method} ${path} secure=${secure}`).toBe(secure);
      }
    }
  });
});

describe('who may do what', () => {
  it('owners and managers manage links and requests; members and observers are forbidden; a stranger and the platform admin get the made-up-circle answer', async () => {
    const w = await world();
    const id = await team(w);
    const made = await makeLink(w, id, 'ann', { uses: 5 });
    await w.p.fay.call('POST', '/api/join', { token: made.json.token });
    const request = (await waiting(w, id))[0]?.id;
    const mine: Array<[string, string, unknown?]> = [
      ['POST', `/api/circles/${id}/join-links`, { label: 'x' }],
      ['GET', `/api/circles/${id}/join-links`],
      ['DELETE', `/api/circles/${id}/join-links/${made.json.link.id}`],
      ['GET', `/api/circles/${id}/join-requests`],
      ['POST', `/api/circles/${id}/join-requests/${request}/approve`],
      ['POST', `/api/circles/${id}/join-requests/${request}/decline`],
    ];
    for (const who of ['cat', 'dan'] as const) {
      for (const [method, path, body] of mine) {
        const r = await w.p[who].call(method, path, body);
        expect([r.status, r.json.error.code], `${who} ${method} ${path}`).toEqual([403, 'FORBIDDEN']);
      }
    }
    const made2 = await w.p.gus.call('POST', '/api/circles', { name: 'Fake' });
    const fake = 'c0000000000000000';
    for (const who of ['gus', 'root'] as const) {
      for (const [method, path, body] of mine) {
        const r = await w.p[who].call(method, path, body);
        expect([r.status, r.json.error], `${who} ${method} ${path}`).toEqual([404, { code: 'NOT_FOUND', message: 'no such circle' }]);
        const r2 = await w.p[who].call(method, path.replace(id, fake), body);
        expect(r2.json, `${who} ${method} ${path}`).toEqual(r.json);
      }
    }
    expect(made2.status).toBe(201);
    expect(await waiting(w, id)).toHaveLength(1); // nothing the others did changed anything
  });

  it('nobody can make a link for owner or manager, a manager included', async () => {
    const w = await world();
    const id = await team(w);
    for (const who of ['ann', 'bob'] as const) {
      for (const role of ['owner', 'manager']) {
        const r = await makeLink(w, id, who, { role });
        expect([r.status, r.json.error.field], `${who} ${role}`).toEqual([422, 'role']);
      }
    }
    expect((await w.p.ann.call('GET', `/api/circles/${id}/join-links`)).json.items).toEqual([]);
  });

  it('only a signed-in person can preview or join: without a session it is a 401', async () => {
    const w = await world();
    const id = await team(w);
    const made = await makeLink(w, id, 'ann', { approval: false });
    const outsider = browser(w.service.port);
    for (const path of ['/api/join/preview', '/api/join']) expect((await outsider.call('POST', path, { token: made.json.token })).status).toBe(401);
    expect(await roster(w, id)).not.toHaveProperty('zed');
  });
});

describe('races, over HTTP', () => {
  it('eight people joining at once by a one-use link make exactly one member; asking at once makes exactly one request', async () => {
    const w = await world();
    const id = await team(w);
    const racers: Browser[] = [];
    for (let n = 0; n < 8; n++) {
      const b = browser(w.service.port);
      await b.register(`racer${n}`);
      racers.push(b);
    }
    const direct = await makeLink(w, id, 'ann', { approval: false, role: 'member' });
    const results = await Promise.all(racers.map((b) => b.call('POST', '/api/join', { token: direct.json.token })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(7);
    expect(Object.keys(await roster(w, id)).filter((u) => u.startsWith('racer'))).toHaveLength(1);
    const asks = await makeLink(w, id, 'ann');
    const asked = await Promise.all(racers.map((b) => b.call('POST', '/api/join', { token: asks.json.token })));
    // the racer who joined directly is told they are a member and spends nothing; of the rest exactly one request is made
    expect(asked.filter((r) => r.status === 200 && r.json.result.state === 'requested')).toHaveLength(1);
    expect(await waiting(w, id)).toHaveLength(1);
  });

  it('eight approvals of one request at once add exactly one member', async () => {
    const w = await world();
    const id = await team(w);
    const made = await makeLink(w, id, 'ann');
    await w.p.eve.call('POST', '/api/join', { token: made.json.token });
    const request = (await waiting(w, id))[0]?.id;
    const results = await Promise.all([w.p.ann, w.p.bob, w.p.ann, w.p.bob, w.p.ann, w.p.bob, w.p.ann, w.p.bob].map((b) => b.call('POST', `/api/circles/${id}/join-requests/${request}/approve`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(7);
    expect(Object.keys(await roster(w, id)).filter((u) => u === 'eve')).toHaveLength(1);
  });
});

describe('registration, deletion, restart and the files', () => {
  it('a link does not create accounts: with registration closed a person with no account cannot join, and someone with one can', async () => {
    const w = await world();
    const id = await team(w);
    const made = await makeLink(w, id, 'ann', { approval: false, uses: 3 });
    await w.service.close();
    running.splice(running.indexOf(w.service), 1);
    const again = await startService(config(w.dir, { allowRegistration: false }), clocked(w.now));
    running.push(again);
    const stranger = browser(again.port);
    const refused = await stranger.call('POST', '/api/register', { username: 'newcomer', displayName: 'New', password: PW });
    expect(refused.status).toBe(403);
    expect((await stranger.call('POST', '/api/join', { token: made.json.token })).status).toBe(401);
    const eve = browser(again.port);
    await eve.login('eve');
    expect((await eve.call('POST', '/api/join', { token: made.json.token })).json.result.state).toBe('joined');
  });

  it('deleting the circle removes its links and requests, and the link then gets the made-up answer', async () => {
    const w = await world();
    const id = await team(w);
    const made = await makeLink(w, id, 'ann', { uses: 5 });
    await w.p.eve.call('POST', '/api/join', { token: made.json.token });
    expect((await w.p.ann.call('DELETE', `/api/circles/${id}`)).status).toBe(204);
    expect((await w.p.fay.call('POST', '/api/join/preview', { token: made.json.token })).json.error).toEqual(NO_LINK);
    expect((await w.p.eve.call('GET', '/api/join-requests')).json.items).toEqual([]);
  });

  it('a person deleting their account takes their waiting requests with them, and a link their creator made stays', async () => {
    const w = await world();
    const id = await team(w);
    const made = await makeLink(w, id, 'bob', { uses: 5 });
    await w.p.eve.call('POST', '/api/join', { token: made.json.token });
    await w.p.fay.call('POST', '/api/join', { token: made.json.token });
    expect((await w.p.eve.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    expect((await waiting(w, id)).map((r) => r.person.displayName)).toEqual(['Display fay']);
    expect((await w.p.bob.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    expect((await w.p.ann.call('GET', `/api/circles/${id}/join-links`)).json.items).toHaveLength(1);
  });

  it('a restart keeps links, uses and waiting requests; the files hold the hash and never the token', async () => {
    const w = await world();
    const id = await team(w);
    const made = await makeLink(w, id, 'ann', { uses: 5 });
    await w.p.eve.call('POST', '/api/join', { token: made.json.token });
    await w.service.close();
    running.splice(running.indexOf(w.service), 1);
    for (const file of readdirSync(w.dir)) {
      const bytes = readFileSync(join(w.dir, file));
      expect(bytes.includes(Buffer.from(made.json.token)), file).toBe(false);
      expect(bytes.includes(Buffer.from((made.json.token as string).slice(6))), file).toBe(false);
    }
    expect(readdirSync(w.dir).sort()).toEqual(['graphs.db', 'users.db']);
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(made.json.token).digest('hex');
    expect(readFileSync(join(w.dir, 'users.db')).includes(Buffer.from(hash))).toBe(true);
    const again = await startService(config(w.dir), clocked(w.now));
    running.push(again);
    const ann = browser(again.port);
    await ann.login('ann');
    expect((await ann.call('GET', `/api/circles/${id}/join-links`)).json.items[0]).toMatchObject({ uses: 1, maxUses: 5 });
    expect((await ann.call('GET', `/api/circles/${id}/join-requests`)).json.items).toHaveLength(1);
    const fay = browser(again.port);
    await fay.login('fay');
    expect((await fay.call('POST', '/api/join', { token: made.json.token })).json.result.state).toBe('requested');
  });

  it('a person asking by a bad link too often is held back, and other people are not', async () => {
    const w = await world();
    const id = await team(w);
    const made = await makeLink(w, id, 'ann', { approval: false, uses: 5 });
    for (let n = 0; n < 30; n++) expect((await w.p.eve.call('POST', '/api/join', { token: `cjoin_${String(n).padStart(43, 'Z')}` })).status).toBe(404);
    const held = await w.p.eve.call('POST', '/api/join', { token: made.json.token });
    expect([held.status, held.json.error.code]).toEqual([429, 'THROTTLED']);
    expect(Number(held.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await w.p.fay.call('POST', '/api/join', { token: made.json.token })).status).toBe(200);
  });
});
