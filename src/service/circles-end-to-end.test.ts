import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ServiceConfig } from './config.js';
import { startService, type RunningService } from './service.js';

// Circles as people would use them: the real service on real SQLite files, over real HTTP, with
// six accounts (the first, root, is the platform admin). Nothing is mocked.

const PW = 'correct horse 7 staple';
const dirs: string[] = [];
const running: RunningService[] = [];
const circleResponses: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  const all = circleResponses.join('\n');
  expect(circleResponses.length).toBeGreaterThan(150);
  for (const leak of [PW, 'scrypt$', 'passwordHash', 'example.com', 'email', 'graphId', 'user-u', 'caci_session']) expect(all.includes(leak), `a response held "${leak}"`).toBe(false);
});

const config = (dataDir: string): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 0, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7 });

interface Reply {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  headers: Headers;
}
function browser(port: number) {
  let cookie: string | undefined;
  return {
    async call(method: string, path: string, body?: unknown): Promise<Reply> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      if (path.startsWith('/api/circles') || path.startsWith('/api/invitations')) circleResponses.push(text);
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text), text, headers: res.headers };
    },
    async signIn(name: string): Promise<string> {
      const registered = await this.call('POST', '/api/register', { username: name, displayName: `Display ${name}`, password: PW });
      await this.call('POST', '/api/login', { username: name, password: PW });
      return registered.json.user.id as string;
    },
  };
}
type Browser = ReturnType<typeof browser>;

interface World {
  service: RunningService;
  dir: string;
  people: Record<'root' | 'ann' | 'bob' | 'cat' | 'dan' | 'eve', Browser>;
  ids: Record<string, string>;
}
async function world(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'caci-circles-e2e-'));
  dirs.push(dir);
  const service = await startService(config(dir));
  running.push(service);
  const people = { root: browser(service.port), ann: browser(service.port), bob: browser(service.port), cat: browser(service.port), dan: browser(service.port), eve: browser(service.port) };
  const ids: Record<string, string> = {};
  for (const [name, b] of Object.entries(people)) ids[name] = await b.signIn(name);
  return { service, dir, people, ids };
}
/** Invites `name` with `role` and has them accept. */
async function bring(w: World, circle: string, by: keyof World['people'], name: keyof World['people'], role: string): Promise<void> {
  expect((await w.people[by].call('POST', `/api/circles/${circle}/invitations`, { username: name, role })).status).toBe(202);
  const invitation = (await w.people[name].call('GET', '/api/invitations')).json.items.find((i: { circle: { id: string } }) => i.circle.id === circle).id as string;
  expect((await w.people[name].call('POST', `/api/invitations/${invitation}/accept`)).status).toBe(200);
}
const rosterOf = async (b: Browser, circle: string): Promise<Record<string, string>> => Object.fromEntries(((await b.call('GET', `/api/circles/${circle}/members`)).json.items as Array<{ username: string; role: string }>).map((m) => [m.username, m.role]));
/** Ann owns a circle with bob (manager), cat (member) and dan (observer). */
async function team(w: World): Promise<string> {
  const id = (await w.people.ann.call('POST', '/api/circles', { name: 'Neighbours' })).json.circle.id as string;
  await bring(w, id, 'ann', 'bob', 'manager');
  await bring(w, id, 'bob', 'cat', 'member');
  await bring(w, id, 'bob', 'dan', 'observer');
  return id;
}

describe('circles, end to end', () => {
  it('forms a circle: nothing takes effect before acceptance, and then everyone sees the same people', async () => {
    const w = await world();
    const id = (await w.people.ann.call('POST', '/api/circles', { name: 'Neighbours' })).json.circle.id as string;
    expect((await w.people.ann.call('POST', `/api/circles/${id}/invitations`, { username: 'bob', role: 'manager' })).status).toBe(202);
    // invited, not yet in
    expect((await w.people.bob.call('GET', `/api/circles/${id}`)).status).toBe(404);
    expect(await rosterOf(w.people.ann, id)).toEqual({ ann: 'owner' });
    const invitation = (await w.people.bob.call('GET', '/api/invitations')).json.items[0];
    expect(invitation).toMatchObject({ circle: { id, name: 'Neighbours' }, role: 'manager', invitedBy: { displayName: 'Display ann' } });
    expect((await w.people.bob.call('POST', `/api/invitations/${invitation.id}/accept`)).json.circle).toMatchObject({ role: 'manager', memberCount: 2 });
    await bring(w, id, 'bob', 'cat', 'member');
    await bring(w, id, 'bob', 'dan', 'observer');
    const expected = { ann: 'owner', bob: 'manager', cat: 'member', dan: 'observer' };
    for (const who of ['ann', 'bob', 'cat', 'dan'] as const) expect(await rosterOf(w.people[who], id), who).toEqual(expected);
    expect((await w.people.cat.call('GET', '/api/circles')).json.items.map((c: { name: string; role: string }) => [c.name, c.role])).toEqual([['Neighbours', 'member']]);
  });

  it('declining, withdrawing and waiting all end an invitation, and an invitation cannot be used twice', async () => {
    const w = await world();
    const id = await team(w);
    const post = (who: keyof World['people'], name: string, role = 'member') => w.people[who].call('POST', `/api/circles/${id}/invitations`, { username: name, role });
    await post('ann', 'eve');
    const first = (await w.people.eve.call('GET', '/api/invitations')).json.items[0].id as string;
    expect((await w.people.eve.call('POST', `/api/invitations/${first}/decline`)).status).toBe(204);
    expect((await w.people.eve.call('POST', `/api/invitations/${first}/accept`)).json.error.message).toBe('no such invitation');
    await post('ann', 'eve');
    const second = (await w.people.ann.call('GET', `/api/circles/${id}/invitations`)).json.items[0].id as string;
    expect((await w.people.bob.call('DELETE', `/api/circles/${id}/invitations/${second}`)).status).toBe(204);
    expect((await w.people.eve.call('GET', '/api/invitations')).json.items).toEqual([]);
    await post('ann', 'eve');
    const third = (await w.people.eve.call('GET', '/api/invitations')).json.items[0].id as string;
    expect((await w.people.eve.call('POST', `/api/invitations/${third}/accept`)).status).toBe(200);
    expect((await w.people.eve.call('POST', `/api/invitations/${third}/accept`)).status).toBe(404);
    expect((await w.people.eve.call('POST', `/api/invitations/${third}/decline`)).status).toBe(404);
    expect(await rosterOf(w.people.ann, id)).toMatchObject({ eve: 'member' });
  });

  it('the permission table holds over HTTP, for every role', async () => {
    const w = await world();
    const id = await team(w);
    const forbidden = { code: 'FORBIDDEN', message: 'your role in this circle does not allow that' };
    const who = w.people;
    // members and observers run nothing
    for (const name of ['cat', 'dan'] as const) {
      for (const [method, path, body] of [['PATCH', `/api/circles/${id}`, { name: 'x' }], ['DELETE', `/api/circles/${id}`], ['POST', `/api/circles/${id}/invitations`, { username: 'eve', role: 'member' }], ['GET', `/api/circles/${id}/invitations`], ['PATCH', `/api/circles/${id}/members/${w.ids.bob}`, { role: 'member' }], ['DELETE', `/api/circles/${id}/members/${w.ids.bob}`]] as const) {
        const r = await who[name].call(method, path, body);
        expect(r.status, `${name} ${method} ${path}`).toBe(403);
        expect(r.json.error).toEqual(forbidden);
      }
    }
    // a manager: members and observers yes, owners and managers no
    expect((await who.bob.call('POST', `/api/circles/${id}/invitations`, { username: 'eve', role: 'owner' })).status).toBe(403);
    expect((await who.bob.call('POST', `/api/circles/${id}/invitations`, { username: 'eve', role: 'manager' })).status).toBe(403);
    expect((await who.bob.call('POST', `/api/circles/${id}/invitations`, { username: 'eve', role: 'observer' })).status).toBe(202);
    expect((await who.bob.call('PATCH', `/api/circles/${id}/members/${w.ids.ann}`, { role: 'member' })).status).toBe(403);
    expect((await who.bob.call('PATCH', `/api/circles/${id}/members/${w.ids.cat}`, { role: 'manager' })).status).toBe(403);
    expect((await who.bob.call('PATCH', `/api/circles/${id}/members/${w.ids.cat}`, { role: 'observer' })).status).toBe(200);
    expect((await who.bob.call('DELETE', `/api/circles/${id}`)).status).toBe(403);
    expect((await who.bob.call('PATCH', `/api/circles/${id}`, { description: 'by a manager' })).status).toBe(200);
    expect((await who.bob.call('DELETE', `/api/circles/${id}/members/${w.ids.ann}`)).status).toBe(403);
    // an owner: anything
    expect((await who.ann.call('PATCH', `/api/circles/${id}/members/${w.ids.cat}`, { role: 'manager' })).status).toBe(200);
    expect(await rosterOf(who.ann, id)).toEqual({ ann: 'owner', bob: 'manager', cat: 'manager', dan: 'observer' });
    // nobody changes their own role, not even an owner
    for (const name of ['ann', 'bob', 'cat', 'dan'] as const) {
      const r = await who[name].call('PATCH', `/api/circles/${id}/members/${w.ids[name]}`, { role: 'owner' });
      expect(r.status, name).toBe(403);
    }
    expect(await rosterOf(who.ann, id)).toEqual({ ann: 'owner', bob: 'manager', cat: 'manager', dan: 'observer' });
  });

  it('a stranger, and the platform admin, get exactly the answer for a circle that does not exist, from every route', async () => {
    const w = await world();
    const id = await team(w);
    const routes: Array<[string, string, unknown?]> = [
      ['GET', `/api/circles/${id}`], ['PATCH', `/api/circles/${id}`, { name: 'x' }], ['DELETE', `/api/circles/${id}`],
      ['GET', `/api/circles/${id}/members`], ['PATCH', `/api/circles/${id}/members/${w.ids.bob}`, { role: 'member' }], ['DELETE', `/api/circles/${id}/members/${w.ids.bob}`],
      ['POST', `/api/circles/${id}/leave`], ['POST', `/api/circles/${id}/invitations`, { username: 'x-person', role: 'member' }], ['GET', `/api/circles/${id}/invitations`], ['DELETE', `/api/circles/${id}/invitations/i0000000000000001`],
    ];
    for (const stranger of ['eve', 'root'] as const) {
      for (const [method, path, body] of routes) {
        const real = await w.people[stranger].call(method, path, body);
        const madeUp = await w.people[stranger].call(method, path.replace(id, 'cnonexistent000000'), body);
        expect(real.status, `${stranger} ${method} ${path}`).toBe(404);
        expect(real.json, `${stranger} ${method} ${path}`).toEqual({ error: { code: 'NOT_FOUND', message: 'no such circle' } });
        expect(madeUp.json).toEqual(real.json);
      }
    }
    expect((await w.people.root.call('GET', '/api/circles')).json.items).toEqual([]);
    expect(Object.keys(await rosterOf(w.people.ann, id))).toHaveLength(4); // nothing above changed the circle
  });

  it('inviting gives byte-identical answers for an existing account, an unknown name, someone already in and a repeat', async () => {
    const w = await world();
    const id = await team(w);
    const answers = [];
    for (const name of ['eve', 'no-such-person', 'cat', 'ann', 'eve', 'EVE']) {
      const r = await w.people.ann.call('POST', `/api/circles/${id}/invitations`, { username: name, role: 'member' });
      answers.push({ status: r.status, text: r.text, type: r.headers.get('content-type'), length: r.headers.get('content-length') });
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0]).toMatchObject({ status: 202, text: '{"invited":true}' });
  });

  it('the last owner cannot leave, be removed or be demoted, and two owners acting on each other at the same moment leave one', async () => {
    const w = await world();
    const id = await team(w);
    const leave = await w.people.ann.call('POST', `/api/circles/${id}/leave`);
    expect(leave.status).toBe(409);
    expect(leave.json.error.code).toBe('LAST_OWNER');
    expect((await w.people.bob.call('DELETE', `/api/circles/${id}/members/${w.ids.ann}`)).status).toBe(403);
    expect((await w.people.bob.call('PATCH', `/api/circles/${id}/members/${w.ids.ann}`, { role: 'member' })).status).toBe(403);
    expect(await rosterOf(w.people.ann, id)).toMatchObject({ ann: 'owner' });

    // a second owner, then each tries to remove the other at the same moment
    expect((await w.people.ann.call('PATCH', `/api/circles/${id}/members/${w.ids.bob}`, { role: 'owner' })).status).toBe(200);
    const removals = await Promise.all([w.people.ann.call('DELETE', `/api/circles/${id}/members/${w.ids.bob}`), w.people.bob.call('DELETE', `/api/circles/${id}/members/${w.ids.ann}`)]);
    expect(removals.filter((r) => r.status === 204)).toHaveLength(1);
    // the other is refused: either it met the last-owner rule (409), or it arrived after the first had finished and its sender was already out (404)
    expect([409, 404]).toContain(removals.find((r) => r.status !== 204)?.status);
    const owners = Object.entries(await rosterOf(w.people.cat, id)).filter(([, role]) => role === 'owner');
    expect(owners).toHaveLength(1);
  });

  it('eight people accepting one invitation at the same moment make one membership', async () => {
    const w = await world();
    const id = await team(w);
    await w.people.ann.call('POST', `/api/circles/${id}/invitations`, { username: 'eve', role: 'member' });
    const invitation = (await w.people.eve.call('GET', '/api/invitations')).json.items[0].id as string;
    const replies = await Promise.all(Array.from({ length: 8 }, () => w.people.eve.call('POST', `/api/invitations/${invitation}/accept`)));
    expect(replies.filter((r) => r.status === 200)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 404)).toHaveLength(7);
    expect(Object.keys(await rosterOf(w.people.ann, id))).toHaveLength(5);
  });

  it('a person may send 30 invitations an hour and is then told how long to wait; someone else is not affected', async () => {
    const w = await world();
    const id = await team(w);
    // (ann already sent one while the team formed, so 29 more fit in her 30)
    for (let i = 0; i < 29; i++) expect((await w.people.ann.call('POST', `/api/circles/${id}/invitations`, { username: `person-${i}`, role: 'member' })).status, `invitation ${i + 2}`).toBe(202);
    const refused = await w.people.ann.call('POST', `/api/circles/${id}/invitations`, { username: 'person-29', role: 'member' });
    expect(refused.status).toBe(429);
    expect(refused.json.error.code).toBe('THROTTLED');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await w.people.bob.call('POST', `/api/circles/${id}/invitations`, { username: 'person-29', role: 'member' })).status).toBe(202);
    // and the circle itself holds only 50 open invitations
    for (let i = 30; i < 50; i++) expect((await w.people.bob.call('POST', `/api/circles/${id}/invitations`, { username: `person-${i}`, role: 'member' })).status, `invitation ${i + 1}`).toBe(202);
    const full = await w.people.bob.call('POST', `/api/circles/${id}/invitations`, { username: 'one-too-many', role: 'member' });
    expect(full.status).toBe(429);
    expect(full.json.error.code).toBe('LIMIT_REACHED');
  });

  it('a person can be in 20 circles and no more', async () => {
    const w = await world();
    for (let i = 0; i < 20; i++) expect((await w.people.eve.call('POST', '/api/circles', { name: `Circle ${i}` })).status).toBe(201);
    const refused = await w.people.eve.call('POST', '/api/circles', { name: 'Twenty-first' });
    expect(refused.status).toBe(429);
    expect(refused.json.error.code).toBe('LIMIT_REACHED');
    expect((await w.people.eve.call('GET', '/api/circles?limit=100')).json.items).toHaveLength(20);
  });

  it('deleting accounts passes circles on, leaves no one in a circle without an account, and never leaves a circle without an owner', async () => {
    const w = await world();
    const id = await team(w); // ann owner, bob manager, cat member, dan observer
    const alone = (await w.people.eve.call('POST', '/api/circles', { name: 'Eve alone' })).json.circle.id as string;
    await w.people.eve.call('POST', `/api/circles/${id}/leave`); // she is not in it: 404, harmless
    // the admin removes the manager; the owner then removes herself
    expect((await w.people.root.call('DELETE', `/api/users/${w.ids.bob}`)).status).toBe(204);
    expect(await rosterOf(w.people.ann, id)).toEqual({ ann: 'owner', cat: 'member', dan: 'observer' });
    expect((await w.people.ann.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    expect(await rosterOf(w.people.cat, id)).toEqual({ cat: 'owner', dan: 'observer' }); // the member before the observer
    expect((await w.people.cat.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    expect(await rosterOf(w.people.dan, id)).toEqual({ dan: 'owner' });
    expect((await w.people.eve.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    expect((await w.people.dan.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    expect(alone).not.toBe(id);
    // everyone is gone but the admin: no circle is left, and nothing is held for the deleted
    expect((await w.people.root.call('GET', '/api/circles')).json.items).toEqual([]);
    const login = await browser(w.service.port).call('POST', '/api/login', { username: 'dan', password: PW });
    expect(login.status).toBe(401);
  });

  it('a restart keeps circles, members and open invitations, and a clean close leaves only the two database files', async () => {
    const w = await world();
    const id = await team(w);
    await w.people.ann.call('POST', `/api/circles/${id}/invitations`, { username: 'eve', role: 'observer' });
    const before = await rosterOf(w.people.ann, id);
    await w.service.close();
    running.splice(running.indexOf(w.service), 1);
    expect(readdirSync(w.dir).sort()).toEqual(['graphs.db', 'users.db']);

    const second = await startService(config(w.dir));
    running.push(second);
    const ann = browser(second.port);
    const eve = browser(second.port);
    await ann.call('POST', '/api/login', { username: 'ann', password: PW });
    await eve.call('POST', '/api/login', { username: 'eve', password: PW });
    expect(await rosterOf(ann, id)).toEqual(before);
    expect((await eve.call('GET', '/api/invitations')).json.items).toMatchObject([{ circle: { id, name: 'Neighbours' }, role: 'observer' }]);
    expect((await eve.call('POST', `/api/invitations/${(await eve.call('GET', '/api/invitations')).json.items[0].id}/accept`)).status).toBe(200);
    expect(await rosterOf(ann, id)).toMatchObject({ eve: 'observer' });
  });

  it('no response of the circle and invitation routes holds an email, a hash, a token or a graph id', async () => {
    const w = await world();
    const id = await team(w);
    const before = circleResponses.length;
    for (const who of ['ann', 'bob', 'cat', 'dan'] as const) {
      await w.people[who].call('GET', '/api/circles');
      await w.people[who].call('GET', `/api/circles/${id}`);
      await w.people[who].call('GET', `/api/circles/${id}/members`);
    }
    await w.people.ann.call('GET', `/api/circles/${id}/invitations`);
    await w.people.eve.call('GET', '/api/invitations');
    expect(circleResponses.length).toBeGreaterThan(before + 10);
    // (the final scan in afterAll searches everything for the secrets)
  });
});
