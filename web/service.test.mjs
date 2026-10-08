import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startService } from '../src/service/service.ts';
import { createApiClient } from './api-client.js';
import { createCircleSession } from './circle-session.js';
import { createCirclesClient } from './circles-client.js';
import { createCirclesSession } from './circles-session.js';
import { fakePage, fill, visibleScreens, waitFor } from './fake-page.test-util.mjs';
import { mount } from './mount.js';
import { createSession } from './session.js';

// The web app's own code against the real service: real SQLite files, real HTTP, nothing mocked except
// that the page is a stand-in (the hand check in a real browser is recorded in STATE.md).

const PW = 'correct horse 7 staple';
const dirs = [];
const running = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const config = (dataDir, extra = {}) => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 1, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, ...extra });
async function start(extra) {
  const dir = mkdtempSync(join(tmpdir(), 'caci-web-e2e-'));
  dirs.push(dir);
  const service = await startService(config(dir, extra));
  running.push(service);
  return service;
}

let client = 0;
/** What a browser does for this page: same address, a cookie jar, the Origin header it would send, and its own address. */
function browserFetch(port) {
  let cookie;
  const address = `198.51.100.${(client++ % 250) + 1}`;
  return async (path, init) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method,
      headers: { ...init.headers, ...(cookie ? { cookie } : {}), origin: `http://127.0.0.1:${port}`, 'x-forwarded-for': address },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
    return res;
  };
}
const sessionFor = (port) => createSession({ api: createApiClient({ fetchFn: browserFetch(port) }) });

describe('the page\'s own logic against the real service', () => {
  it('starts signed out, registers (and is signed in by it), reloads still signed in, signs out, and signs in again', async () => {
    const { port } = await start();
    const first = sessionFor(port);
    await first.start();
    expect(first.getState()).toMatchObject({ screen: 'signed-out', user: null });

    expect(await first.register({ username: 'Ann', displayName: 'Ann A', email: '', password: PW })).toEqual({ ok: true });
    expect(first.getState()).toMatchObject({ screen: 'signed-in', user: { username: 'ann', displayName: 'Ann A' } });
    expect(Object.keys(first.getState().user).sort()).toEqual(['displayName', 'id', 'username']);

    // "reload": the same browser (same cookie jar), a new session object
    const jarFetch = browserFetch(port);
    const reloadable = createSession({ api: createApiClient({ fetchFn: jarFetch }) });
    expect(await reloadable.signIn({ username: 'ann', password: PW })).toEqual({ ok: true });
    const reloaded = createSession({ api: createApiClient({ fetchFn: jarFetch }) });
    await reloaded.start();
    expect(reloaded.getState()).toMatchObject({ screen: 'signed-in', user: { username: 'ann' } });

    expect(await reloaded.signOut()).toEqual({ ok: true });
    expect(reloaded.getState().screen).toBe('signed-out');
    const afterwards = createSession({ api: createApiClient({ fetchFn: jarFetch }) });
    await afterwards.start();
    expect(afterwards.getState().screen).toBe('signed-out'); // the old session no longer works
    expect(await afterwards.signOut()).toEqual({ ok: true }); // signing out twice is fine
  });

  it('tells a person what went wrong in the service\'s own words: a wrong password, a taken name, a weak password, and an unknown account', async () => {
    const { port } = await start();
    const s = sessionFor(port);
    await s.register({ username: 'ann', displayName: 'Ann', password: PW });
    const other = sessionFor(port);
    const wrong = await other.signIn({ username: 'ann', password: 'definitely not it' });
    expect(wrong).toMatchObject({ ok: false, kind: 'credentials' });
    expect(wrong.message.length).toBeGreaterThan(5);
    expect(await other.signIn({ username: 'nobody-here', password: 'definitely not it' })).toEqual(wrong); // the same words for an unknown name
    const taken = await sessionFor(port).register({ username: 'ANN', displayName: 'Another', password: PW });
    expect(taken).toMatchObject({ ok: false, kind: 'taken', errors: { username: expect.any(String) } });
    const weak = await sessionFor(port).register({ username: 'bob', displayName: 'Bob', password: 'password1234' }); // long enough, but on the service's list
    expect(weak).toMatchObject({ ok: false, kind: 'invalid', errors: { password: expect.any(String) } });
    expect(JSON.stringify(weak)).not.toContain('password1234');
  });

  it('closed registration is reported as closed', async () => {
    const { port } = await start({ allowRegistration: false });
    expect(await sessionFor(port).register({ username: 'ann', displayName: 'Ann', password: PW })).toMatchObject({ ok: false, kind: 'closed', message: 'Registration is closed on this service.' });
  });

  it('being held back after too many wrong passwords shows the wait', async () => {
    const { port } = await start();
    await sessionFor(port).register({ username: 'ann', displayName: 'Ann', password: PW });
    const jar = browserFetch(port); // one address, so the per-address and per-name counts both add up
    const attacker = createSession({ api: createApiClient({ fetchFn: jar }) });
    let last;
    for (let i = 0; i < 8; i++) last = await attacker.signIn({ username: 'ann', password: `wrong password ${i}` });
    expect(last).toMatchObject({ ok: false, kind: 'throttled' });
    expect(last.retryAfterSeconds).toBeGreaterThan(0);
    expect(last.message).toMatch(/^Too many tries\. Wait \d+ seconds? and try again\.$/);
  });

  it('a display name made of markup is stored and returned as the text it is, and shown only as text', async () => {
    const { port } = await start();
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const s = sessionFor(port);
    expect(await s.register({ username: 'ann', displayName: hostile, password: PW })).toEqual({ ok: true });
    expect(s.getState().user.displayName).toBe(hostile);
    const page = fakePage();
    mount(page.document, browserFetch(port));
    await waitFor(() => visibleScreens(page)[0] === 'signed-out');
    fill(page, 'signin', { username: 'ann', password: PW });
    page.el('signin-form').fire('submit');
    await waitFor(() => visibleScreens(page)[0] === 'signed-in');
    expect(page.el('user-display-name').textContent).toBe(hostile);
    expect(page.ids).toEqual(fakePage().ids);
  });

  it('the whole page, run against the real service: create an account, land on the holding page, sign out, sign in', async () => {
    const { port } = await start();
    const jar = browserFetch(port);
    const page = fakePage();
    mount(page.document, jar);
    await waitFor(() => visibleScreens(page)[0] === 'signed-out');
    page.el('show-register').fire('click');
    fill(page, 'register', { username: 'Ann', displayName: 'Ann A', email: 'ann@example.com', password: PW });
    page.el('register-form').fire('submit');
    await waitFor(() => visibleScreens(page)[0] === 'signed-in');
    expect(page.el('user-display-name').textContent).toBe('Ann A');
    expect(page.el('user-username').textContent).toBe('ann');
    page.el('signout').fire('click');
    await waitFor(() => visibleScreens(page)[0] === 'signed-out');
    fill(page, 'signin', { username: 'ann', password: PW });
    page.el('signin-form').fire('submit');
    await waitFor(() => visibleScreens(page)[0] === 'signed-in');
  });
});

describe('the circles client against the real service', () => {
  const people = async (port, names) => {
    const out = {};
    for (const name of names) {
      const jar = browserFetch(port);
      const session = createSession({ api: createApiClient({ fetchFn: jar }) });
      expect(await session.register({ username: name, displayName: `Display ${name}`, password: PW })).toEqual({ ok: true });
      out[name] = { circles: createCirclesClient({ fetchFn: jar }), id: session.getState().user.id };
    }
    return out;
  };

  it('a whole circle: create, invite, accept, roles, remove, leave, the only owner refused, delete', async () => {
    const { port } = await start();
    const { root, ann, bob, cat } = await people(port, ['root', 'ann', 'bob', 'cat']);
    expect(root).toBeDefined(); // the first account is the administrator and not part of the story
    const made = await ann.circles.createCircle({ name: ' Neighbours ', description: 'Next door' });
    expect(made.value).toMatchObject({ name: 'Neighbours', description: 'Next door', role: 'owner', memberCount: 1 });
    const id = made.value.id;
    expect((await ann.circles.listCircles()).value.items.map((c) => c.id)).toEqual([id]);

    for (const [who, role] of [[bob, 'manager'], [cat, 'member']]) {
      const name = who === bob ? 'bob' : 'cat';
      expect(await ann.circles.invite(id, { username: name.toUpperCase(), role })).toEqual({ ok: true, value: { invited: true } });
    }
    const [forBob] = (await bob.circles.myInvitations()).value.items;
    expect(forBob).toMatchObject({ circle: { id, name: 'Neighbours' }, role: 'manager', invitedBy: { displayName: 'Display ann' } });
    expect((await bob.circles.acceptInvitation(forBob.id)).value).toMatchObject({ id, role: 'manager', memberCount: 2 });
    const [forCat] = (await cat.circles.myInvitations()).value.items;
    expect((await cat.circles.declineInvitation(forCat.id)).ok).toBe(true);
    expect((await cat.circles.myInvitations()).value.items).toEqual([]);

    const open = await ann.circles.listInvitations(id);
    expect(open.value.items.map((i) => i.username)).toEqual([]); // both are gone: one accepted, one declined
    await ann.circles.invite(id, { username: 'cat', role: 'observer' });
    const [again] = (await ann.circles.listInvitations(id)).value.items;
    expect(again).toMatchObject({ username: 'cat', role: 'observer' });
    expect((await ann.circles.withdrawInvitation(id, again.id)).ok).toBe(true);
    expect((await cat.circles.myInvitations()).value.items).toEqual([]);
    await ann.circles.invite(id, { username: 'cat', role: 'member' });
    expect((await cat.circles.acceptInvitation((await cat.circles.myInvitations()).value.items[0].id)).ok).toBe(true);

    const roster = (await bob.circles.listMembers(id)).value.items;
    expect(Object.fromEntries(roster.map((m) => [m.username, m.role]))).toEqual({ ann: 'owner', bob: 'manager', cat: 'member' });
    expect((await bob.circles.changeRole(id, cat.id, 'observer')).value).toMatchObject({ role: 'observer', username: 'cat' });
    expect((await bob.circles.changeRole(id, ann.id, 'member')).error).toEqual({ kind: 'forbidden', message: 'Your role in this circle does not allow that.' });
    expect((await ann.circles.changeRole(id, bob.id, 'owner')).value.role).toBe('owner');
    expect((await bob.circles.removeMember(id, cat.id)).ok).toBe(true);
    expect((await cat.circles.getCircle(id)).error).toEqual({ kind: 'not-found', what: 'circle', message: 'No such circle, or you are not in it.' });
    expect((await ann.circles.leaveCircle(id)).ok).toBe(true);
    const only = await bob.circles.leaveCircle(id);
    expect(only.error.kind).toBe('last-owner');
    expect(only.error.message.toLowerCase()).toContain('only owner');
    expect((await bob.circles.deleteCircle(id)).ok).toBe(true);
    expect((await bob.circles.getCircle(id)).error.kind).toBe('not-found');
  });

  it('a circle the person is not in, and one that does not exist, read the same; a hostile id never leaves the page', async () => {
    const { port } = await start();
    const { root, ann, bob } = await people(port, ['root', 'ann', 'bob']);
    expect(root).toBeDefined();
    const id = (await ann.circles.createCircle({ name: 'Private' })).value.id;
    const stranger = await bob.circles.getCircle(id);
    const missing = await bob.circles.getCircle('c0000000000000000');
    expect(stranger).toEqual(missing);
    expect((await bob.circles.getCircle('../../etc/passwd')).error.kind).toBe('not-found');
  });

  it('limits and field problems come back in the service\'s words, beside the field it names', async () => {
    const { port } = await start({ maxCirclesPerUser: 1 });
    const { root, ann } = await people(port, ['root', 'ann']);
    expect(root).toBeDefined();
    expect(await ann.circles.createCircle({ name: '' })).toMatchObject({ ok: false, error: { kind: 'invalid', field: 'name' } });
    expect((await ann.circles.createCircle({ name: 'x'.repeat(81) })).error.field).toBe('name');
    expect((await ann.circles.createCircle({ name: 'One' })).ok).toBe(true);
    const over = await ann.circles.createCircle({ name: 'Two' });
    expect(over.error.kind).toBe('limit');
    expect(over.error.message).toMatch(/at most 1 circles?/);
    const circle = (await ann.circles.listCircles()).value.items[0];
    expect((await ann.circles.invite(circle.id, { username: 'x', role: 'member' })).error).toMatchObject({ kind: 'invalid', field: 'username' });
    expect((await ann.circles.invite(circle.id, { username: 'someone', role: 'boss' })).error).toMatchObject({ kind: 'invalid', field: 'role' });
  });

  it('a markup display name comes back as the text it is', async () => {
    const { port } = await start();
    const { ann } = await people(port, ['ann']);
    const hostile = '<img src=x onerror=alert(1)>';
    const jar = browserFetch(port);
    const registered = createSession({ api: createApiClient({ fetchFn: jar }) });
    await registered.register({ username: 'eve', displayName: hostile, password: PW });
    const eve = createCirclesClient({ fetchFn: jar });
    const id = (await eve.createCircle({ name: hostile, description: hostile })).value.id;
    const [circle] = (await eve.listCircles()).value.items;
    expect(circle).toMatchObject({ id, name: hostile, description: hostile });
    expect((await eve.listMembers(id)).value.items[0].displayName).toBe(hostile);
    expect(ann).toBeDefined();
  });
});

describe('the circles list and invitations logic against the real service', () => {
  const person = async (port, name) => {
    const jar = browserFetch(port);
    const session = createSession({ api: createApiClient({ fetchFn: jar }) });
    expect(await session.register({ username: name, displayName: `Display ${name}`, password: PW })).toEqual({ ok: true });
    const circles = createCirclesClient({ fetchFn: jar });
    return { circles, view: createCirclesSession({ client: circles }) };
  };

  it('create, list with show more, invite, count, refresh, accept, decline, leave', async () => {
    const { port } = await start();
    await person(port, 'root'); // the first account is the administrator
    const ann = await person(port, 'ann');
    const bob = await person(port, 'bob');

    expect(await ann.view.loadCircles()).toEqual({ ok: true });
    expect(ann.view.getState().circles).toMatchObject({ status: 'loaded', items: [] });
    expect(await ann.view.createCircle({ name: '' })).toMatchObject({ kind: 'invalid' });
    const made = [];
    for (const name of ['One', 'Two', 'Three']) made.push((await ann.view.createCircle({ name, description: `About ${name}` })).circle);
    expect(made[0]).toMatchObject({ name: 'One', role: 'owner', memberCount: 1 });
    expect(ann.view.getState().circles.stale).toBe(true);
    await ann.view.loadCircles();
    expect(ann.view.getState().circles).toMatchObject({ stale: false, nextCursor: null });
    expect(ann.view.getState().circles.items.map((c) => c.name)).toHaveLength(3);

    // show more: a real second page, by asking the client for one item at a time through the session's cursor
    const paged = createCirclesSession({ client: { ...ann.circles, listCircles: (p) => ann.circles.listCircles({ ...p, limit: 2 }) } });
    await paged.loadCircles();
    expect(paged.getState().circles.items).toHaveLength(2);
    expect(paged.getState().circles.nextCursor).not.toBeNull();
    await paged.moreCircles();
    expect(paged.getState().circles.items).toHaveLength(3);
    expect(paged.getState().circles.nextCursor).toBeNull();

    // nobody has invited bob yet
    await bob.view.loadInvitations();
    expect(bob.view.getState().invitations).toMatchObject({ count: 0, atLeast: false });
    for (const c of made) expect((await ann.circles.invite(c.id, { username: 'BOB', role: 'member' })).ok).toBe(true);
    expect(bob.view.getState().invitations.count).toBe(0); // not live: only as old as the last load
    await bob.view.refreshCount();
    expect(bob.view.getState().invitations).toMatchObject({ count: 3, atLeast: false });
    expect(bob.view.getState().invitations.items[0]).toMatchObject({ role: 'member', invitedBy: { displayName: 'Display ann' } });

    const [first, second, third] = bob.view.getState().invitations.items;
    const accepted = await bob.view.acceptInvitation(first.id);
    expect(accepted.ok).toBe(true);
    expect(accepted.circle).toMatchObject({ role: 'member', memberCount: 2 });
    expect(bob.view.getState().invitations.count).toBe(2);
    expect(bob.view.getState().circles.stale).toBe(true);
    await bob.view.loadCircles();
    expect(bob.view.getState().circles.items.map((c) => c.id)).toEqual([accepted.circle.id]);

    expect(await bob.view.declineInvitation(second.id)).toEqual({ ok: true });
    expect(bob.view.getState().invitations).toMatchObject({ count: 1 });
    expect(await bob.view.declineInvitation(second.id)).toMatchObject({ ok: false, kind: 'not-found', what: 'invitation' });
    expect(await bob.view.acceptInvitation(second.id)).toMatchObject({ kind: 'not-found', message: 'No such invitation: it may have been withdrawn, used or expired.' });

    // withdrawn behind his back: accepting says so and the list catches up
    const open = (await ann.circles.listInvitations(made.find((c) => c.id === third.circle.id).id)).value.items[0];
    await ann.circles.withdrawInvitation(third.circle.id, open.id);
    expect(await bob.view.acceptInvitation(third.id)).toMatchObject({ ok: false, kind: 'not-found', what: 'invitation' });
    expect(bob.view.getState().invitations.count).toBe(0);

    // leave: the list reloads; a circle that has gone says so
    expect(await bob.view.leaveCircle(accepted.circle.id)).toEqual({ ok: true });
    expect(bob.view.getState().circles.items).toEqual([]);
    expect(await bob.view.leaveCircle(accepted.circle.id)).toMatchObject({ ok: false, kind: 'not-found', what: 'circle', message: 'No such circle, or you are not in it.' });
    const only = await ann.view.leaveCircle(made[0].id);
    expect(only).toMatchObject({ ok: false, kind: 'last-owner' });
    expect(only.message.toLowerCase()).toContain('only owner');
  });

  it('the service\'s refusals show in its words: the most circles allowed, and a signed-out request', async () => {
    const { port } = await start({ maxCirclesPerUser: 1 });
    await person(port, 'root');
    const ann = await person(port, 'ann');
    expect((await ann.view.createCircle({ name: 'One' })).ok).toBe(true);
    const second = await ann.view.createCircle({ name: 'Two' });
    expect(second).toMatchObject({ ok: false, kind: 'limit' });
    expect(second.message.length).toBeGreaterThan(5);
    const stranger = createCirclesSession({ client: createCirclesClient({ fetchFn: browserFetch(port) }) });
    expect(await stranger.loadCircles()).toMatchObject({ ok: false, kind: 'signed-out', message: 'Your session has ended. Sign in again.' });
    expect(await stranger.loadInvitations()).toMatchObject({ kind: 'signed-out' });
    expect(stranger.getState().invitations.count).toBeNull();
  });
});

describe('one circle\'s logic against the real service (three accounts)', () => {
  const person = async (port, name) => {
    const jar = browserFetch(port);
    const session = createSession({ api: createApiClient({ fetchFn: jar }) });
    expect(await session.register({ username: name, displayName: `Display ${name}`, password: PW })).toEqual({ ok: true });
    const circles = createCirclesClient({ fetchFn: jar });
    const id = session.getState().user.id;
    return { circles, id, view: createCircleSession({ client: circles }), open: (circleId) => createCircleSession({ client: circles }).open(circleId, id) };
  };

  it('open, edit, invite, accept, change roles, remove, leave, delete, and every refusal in the service\'s words', async () => {
    const { port } = await start();
    await person(port, 'root');
    const ann = await person(port, 'ann');
    const bob = await person(port, 'bob');
    const cat = await person(port, 'cat');

    const made = (await ann.circles.createCircle({ name: 'Team', description: 'Us' })).value;
    const a = createCircleSession({ client: ann.circles });
    expect(await a.open(made.id, ann.id)).toEqual({ ok: true });
    expect(a.getState()).toMatchObject({ status: 'loaded', circle: { name: 'Team', role: 'owner', memberCount: 1 }, controls: { delete: true, invite: true } });
    expect(a.getState().members.items.map((m) => [m.username, m.self, m.controls])).toEqual([['ann', true, { changeRole: false, remove: false }]]);
    expect(a.getState().invitations).toMatchObject({ visible: true, items: [] });

    // rename; an empty description removes it
    expect(await a.update({ name: ' Neighbours ', description: '' })).toEqual({ ok: true });
    expect(a.getState().circle).toMatchObject({ name: 'Neighbours' });
    expect(a.getState().circle.description).toBeUndefined();
    expect(await a.update({ name: 'x'.repeat(81) })).toMatchObject({ kind: 'invalid' });

    // invite: the same notice for an account and for a name nobody has
    const real = await a.invite({ username: 'BOB', role: 'manager' });
    const nobody = await a.invite({ username: 'nobody.here', role: 'manager' });
    expect(real.ok && nobody.ok).toBe(true);
    expect(real.notice).toBe('Invitation recorded for "bob".');
    expect(nobody.notice).toBe('Invitation recorded for "nobody.here".');
    expect(a.getState().invitations.items.map((i) => i.username).sort()).toEqual(['bob', 'nobody.here']);
    await a.invite({ username: 'cat', role: 'member' });

    // the invitees accept; bob (a manager) sees invitations, cat (a member) does not
    for (const who of [bob, cat]) {
      const [mine] = (await who.circles.myInvitations()).value.items;
      expect((await who.circles.acceptInvitation(mine.id)).ok).toBe(true);
    }
    const b = createCircleSession({ client: bob.circles });
    await b.open(made.id, bob.id);
    expect(b.getState()).toMatchObject({ circle: { role: 'manager' }, controls: { rename: true, delete: false, invite: true }, rolesToOffer: ['member', 'observer'] });
    expect(b.getState().members.items.map((m) => [m.username, m.controls.changeRole, m.controls.remove]).sort()).toEqual([['ann', false, false], ['bob', false, false], ['cat', true, true]]);
    const c = createCircleSession({ client: cat.circles });
    await c.open(made.id, cat.id);
    expect(c.getState()).toMatchObject({ circle: { role: 'member' }, controls: { rename: false, invite: false }, invitations: { visible: false } });

    // the service decides: the member is refused in its words, and the view refreshes
    expect(await c.update({ name: 'Mine now' })).toMatchObject({ ok: false, kind: 'forbidden', message: 'Your role in this circle does not allow that.' });
    expect(await b.invite({ username: 'dave', role: 'owner' })).toMatchObject({ ok: false, errors: { role: expect.any(String) } }); // not even sent
    expect(await b.changeRole(ann.id, 'member')).toMatchObject({ ok: false, kind: 'forbidden' });

    // a role change by the owner; the view that was open learns about its demotion on the next refusal
    expect(await a.changeRole(bob.id, 'observer')).toEqual({ ok: true });
    expect(a.getState().members.items.find((m) => m.username === 'bob').role).toBe('observer');
    expect(await b.withdraw(a.getState().invitations.items.find((i) => i.username === 'nobody.here').id)).toMatchObject({ ok: false, kind: 'forbidden' });
    expect(b.getState()).toMatchObject({ circle: { role: 'observer' }, controls: { rename: false, invite: false }, invitations: { visible: false, items: [] } });

    // withdraw
    const open = a.getState().invitations.items.find((i) => i.username === 'nobody.here');
    expect(await a.withdraw(open.id)).toEqual({ ok: true });
    expect(a.getState().invitations.items).toEqual([]);
    expect(await a.withdraw(open.id)).toMatchObject({ ok: false, kind: 'not-found', what: 'invitation' });

    // remove (two steps); the person is then told the circle is gone
    expect(a.askRemove(cat.id)).toBe(true);
    expect(await a.confirmAction()).toEqual({ ok: true });
    expect(a.getState().members.items.map((m) => m.username).sort()).toEqual(['ann', 'bob']);
    expect(a.getState().circle.memberCount).toBe(2);
    expect(await c.refresh()).toMatchObject({ ok: false, kind: 'not-found' });
    expect(c.getState()).toMatchObject({ status: 'gone', message: 'No such circle, or you are not in it.' });

    // leaving: the only owner is refused in the service's words; then bob leaves for good
    a.askLeave();
    const only = await a.confirmAction();
    expect(only).toMatchObject({ ok: false, kind: 'last-owner' });
    expect(only.message.toLowerCase()).toContain('only owner');
    expect(a.getState().status).toBe('loaded');
    b.askLeave();
    expect(await b.confirmAction()).toEqual({ ok: true, goTo: 'list' });
    expect(b.getState().status).toBe('left');
    expect((await a.refresh()).ok).toBe(true);
    expect(a.getState().members.items.map((m) => m.username)).toEqual(['ann']);

    // delete (two steps); cancel does nothing
    a.askDelete();
    a.cancel();
    expect((await ann.circles.getCircle(made.id)).ok).toBe(true);
    a.askDelete();
    expect(await a.confirmAction()).toEqual({ ok: true, goTo: 'list' });
    expect(a.getState().status).toBe('deleted');
    expect((await ann.circles.getCircle(made.id)).error.kind).toBe('not-found');
  });

  it('a circle that is not yours and one that never existed read the same; markup is only text', async () => {
    const { port } = await start();
    await person(port, 'root');
    const ann = await person(port, 'ann');
    const bob = await person(port, 'bob');
    const made = (await ann.circles.createCircle({ name: '<b>Team</b>', description: '<img src=x onerror=alert(1)>' })).value;
    const stranger = createCircleSession({ client: bob.circles });
    const nobody = createCircleSession({ client: bob.circles });
    await stranger.open(made.id, bob.id);
    await nobody.open('c0000000000000000', bob.id);
    expect(stranger.getState()).toMatchObject({ status: 'gone', message: 'No such circle, or you are not in it.' });
    expect(nobody.getState()).toMatchObject({ status: 'gone', message: 'No such circle, or you are not in it.' });
    const a = createCircleSession({ client: ann.circles });
    await a.open(made.id, ann.id);
    expect(a.getState().circle).toMatchObject({ name: '<b>Team</b>', description: '<img src=x onerror=alert(1)>' });
    const hostile = createCircleSession({ client: bob.circles });
    await hostile.open('../../api/me', bob.id);
    expect(hostile.getState().status).toBe('gone');
  });
});
