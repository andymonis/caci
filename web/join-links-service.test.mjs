import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startService } from '../src/service/service.ts';
import { createApiClient } from './api-client.js';
import { browserFetch, PW } from './sharing-world.test-util.mjs';
import { createCirclesClient } from './circles-client.js';
import { createJoinClient } from './join-client.js';
import { createJoinLinksSession } from './join-links-session.js';

// The join client and the join links logic against the real service: real SQLite files, real HTTP, each person with their own cookie.

const dirs = [];
const running = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function world(joinLinks = true, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'caci-join-web-'));
  dirs.push(dir);
  const service = await startService({ port: 0, bind: '127.0.0.1', dataDir: dir, allowRegistration: true, cookieSecure: false, trustedProxies: 1, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, maxBrainScopes: 25, statusPerHour: 20, ledgerDays: 90, usageDays: 400, sessionIdleDays: 7, sessionDays: 30, agentAccess: false, joinLinks, ...extra });
  running.push(service);
  const people = {};
  for (const name of ['ann', 'bob', 'cat', 'eve', 'fay']) {
    const f = browserFetch(service.port);
    const api = createApiClient({ fetchFn: f });
    await api.register({ username: name, displayName: `Display ${name}`, password: PW });
    await api.login({ username: name, password: PW });
    people[name] = { circles: createCirclesClient({ fetchFn: f }), join: createJoinClient({ fetchFn: f }) };
  }
  const circle = (await people.ann.circles.createCircle({ name: 'Club' })).value.id;
  for (const [name, role] of [['bob', 'manager'], ['cat', 'member']]) {
    await people.ann.circles.invite(circle, { username: name, role });
    const invitation = (await people[name].circles.myInvitations()).value.items[0].id;
    await people[name].circles.acceptInvitation(invitation);
  }
  return { service, people, circle };
}
const FORM = { label: 'Chat', role: 'member', days: 7, uses: 3, approval: true };

describe('the join links logic against the real service', () => {
  it('a link is made, used by a stranger to ask, approved, and the person is a member; the token is held once', async () => {
    const { people, circle } = await world();
    let changed = 0;
    const s = createJoinLinksSession({ client: people.ann.join, onChanged: () => changed++ });
    expect(await s.open(circle)).toEqual({ ok: true });
    expect(s.getState()).toMatchObject({ status: 'loaded', links: [], requests: [] });
    expect(await s.create(FORM)).toEqual({ ok: true });
    const { token, link } = s.getState().created;
    expect(token).toMatch(/^cjoin_[A-Za-z0-9_-]{43}$/);
    expect(link).toMatchObject({ label: 'Chat', role: 'member', maxUses: 3, uses: 0, approval: true, createdBy: { displayName: 'Display ann' } });
    expect(s.getState().links).toHaveLength(1);
    expect(JSON.stringify(s.getState().links)).not.toContain('cjoin_');
    const seen = await people.eve.join.preview(token);
    expect(seen.value).toEqual({ circle: { name: 'Club' }, role: 'member', createdBy: { displayName: 'Display ann' } });
    const asked = await people.eve.join.join(token);
    expect(asked.value).toMatchObject({ state: 'requested', circle: { name: 'Club' }, role: 'member' });
    expect((await people.eve.circles.getCircle(circle)).ok).toBe(false);
    expect((await people.eve.join.myRequests()).value.items).toMatchObject([{ circle: { name: 'Club' }, role: 'member' }]);
    await s.refresh();
    expect(s.getState().requests.map((r) => r.person.displayName)).toEqual(['Display eve']);
    expect(s.getState().links[0].uses).toBe(1);
    expect(await s.approve(s.getState().requests[0].id)).toEqual({ ok: true });
    expect(s.getState().notice).toBe('Approved: Display eve is now a member.');
    expect(s.getState().requests).toEqual([]);
    expect(changed).toBe(1);
    expect((await people.eve.circles.getCircle(circle)).value).toMatchObject({ role: 'member', memberCount: 4 });
    expect((await people.eve.join.myRequests()).value.items).toEqual([]);
    s.reset();
    expect(JSON.stringify(s.getState())).not.toContain(token);
  });

  it('declining adds nobody; a manager does it too; withdrawing a link makes it a miss for the next person, after the question', async () => {
    const { people, circle } = await world();
    const owner = createJoinLinksSession({ client: people.ann.join });
    await owner.open(circle);
    await owner.create({ ...FORM, uses: 5 });
    const { token } = owner.getState().created;
    await people.fay.join.join(token);
    const manager = createJoinLinksSession({ client: people.bob.join });
    await manager.open(circle);
    expect(manager.getState().requests.map((r) => r.person.displayName)).toEqual(['Display fay']);
    expect(await manager.decline(manager.getState().requests[0].id)).toEqual({ ok: true });
    expect(manager.getState().notice).toBe('Declined: Display fay was not added.');
    expect((await people.fay.circles.getCircle(circle)).ok).toBe(false);
    await owner.refresh();
    const id = owner.getState().links[0].id;
    expect(owner.askRevoke(id)).toBe(true);
    owner.cancel();
    expect((await people.eve.join.preview(token)).ok).toBe(true);
    owner.askRevoke(id);
    expect(await owner.confirmRevoke()).toEqual({ ok: true });
    expect(owner.getState().links).toEqual([]);
    const miss = await people.eve.join.join(token);
    expect(miss.error).toMatchObject({ kind: 'not-found', what: 'link' });
  });

  it('a member is refused with the service\'s refusal shown, a stranger is told there is no such circle, and the form\'s own refusals come back by field', async () => {
    const { people, circle } = await world();
    const member = createJoinLinksSession({ client: people.cat.join });
    expect((await member.open(circle)).kind).toBe('forbidden');
    expect(member.getState()).toMatchObject({ status: 'error', message: 'Your role in this circle does not allow that.' });
    const stranger = createJoinLinksSession({ client: people.eve.join });
    expect((await stranger.open(circle)).kind).toBe('not-found');
    expect(stranger.getState()).toMatchObject({ status: 'gone', message: 'No such circle, or you are not in it.' });
    const owner = createJoinLinksSession({ client: people.ann.join });
    await owner.open(circle);
    const direct = await people.ann.join.createLink(circle, { label: 'x', role: 'owner' });
    expect(direct.error).toMatchObject({ kind: 'invalid', field: 'role' });
    expect(await owner.create({ ...FORM, label: '' })).toMatchObject({ kind: 'invalid', field: 'label' });
  });

  it('with join links switched off the session says so, and nothing is shown', async () => {
    const { people, circle } = await world(false);
    const s = createJoinLinksSession({ client: people.ann.join });
    expect((await s.open(circle)).kind).toBe('unavailable');
    expect(s.getState()).toMatchObject({ status: 'unavailable', message: 'Join links are not switched on in this service.', links: [], requests: [] });
    expect((await people.eve.join.myRequests()).error.kind).toBe('unavailable');
  });

  it('a full circle is the service\'s limit shown, and the request stays waiting', async () => {
    const { people, circle } = await world(true, { maxMembersPerCircle: 4 }); // ann, bob and cat are in: one place is left
    const owner = createJoinLinksSession({ client: people.ann.join });
    await owner.open(circle);
    await owner.create({ ...FORM, uses: 2 });
    const { token } = owner.getState().created;
    await people.eve.join.join(token);
    await people.fay.join.join(token);
    await owner.refresh();
    const [first, second] = owner.getState().requests.map((r) => r.id);
    expect((await owner.approve(first)).ok).toBe(true);
    const full = await owner.approve(second);
    expect(full).toMatchObject({ ok: false, kind: 'limit' });
    expect(owner.getState().problem).toBe('a circle may have at most 4 people');
    expect(owner.getState().requests).toHaveLength(1);
  });

  it('a one-use link is spent by asking: asking again is a miss, and the person finds the request in their own list', async () => {
    const { people, circle } = await world();
    const owner = createJoinLinksSession({ client: people.ann.join });
    await owner.open(circle);
    await owner.create({ ...FORM, uses: 1 });
    const { token } = owner.getState().created;
    expect((await people.eve.join.join(token)).value.state).toBe('requested');
    expect((await people.eve.join.join(token)).error).toMatchObject({ kind: 'not-found', what: 'link' });
    expect((await people.eve.join.myRequests()).value.items).toHaveLength(1);
  });
});
