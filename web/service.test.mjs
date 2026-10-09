import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startService } from '../src/service/service.ts';
import { createApiClient } from './api-client.js';
import { createCircleSession } from './circle-session.js';
import { createCirclesClient } from './circles-client.js';
import { createNotesClient, isProposalId } from './notes-client.js';
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

describe('the whole circles journey through the pages\' own code, against the real service', () => {
  /** One person\'s browser: its own cookie jar, address bar and page, mounted on the real service. */
  function browser(port, jar = browserFetch(port), hash = '') {
    const page = fakePage();
    let current = hash;
    const listeners = [];
    const env = { getHash: () => current, setHash: (h) => { current = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
    mount(page.document, jar, env);
    return { page, jar, env, hash: () => current, go: (h) => env.setHash(h), reload: () => browser(port, jar, current) };
  }
  const el = (b, id) => b.page.el(id);
  const rows = (b, list) => el(b, list).children;
  const slot = (row, name) => row.querySelector(`[data-slot="${name}"]`);
  const view = (b) => ['home', 'circles', 'circle', 'invitations'].find((v) => !b.page.el(`view-${v}`).hidden);
  const submit = (b, form) => b.page.el(`${form}-form`).fire('submit');

  async function register(port, name) {
    const b = browser(port);
    await waitFor(() => !el(b, 'signin-section').hidden && visibleScreens(b.page)[0] === 'signed-out');
    el(b, 'show-register').fire('click');
    fill(b.page, 'register', { username: name, displayName: `Display ${name}`, email: '', password: PW });
    submit(b, 'register');
    await waitFor(() => visibleScreens(b.page)[0] === 'signed-in');
    return b;
  }

  it('create, invite, see the count, accept, invite as a manager, change a role, remove, leave, delete, a stranger, a hostile address and a reload', async () => {
    const { port } = await start();
    await register(port, 'root'); // the first account is the administrator and not part of the story
    const ann = await register(port, 'ann');
    const bob = await register(port, 'bob');
    const cat = await register(port, 'cat');
    await waitFor(() => el(bob, 'home-invitations-count').textContent === 'You have no open invitations.');

    // ann makes a circle and lands on it as its owner
    ann.go('#/circles');
    await waitFor(() => view(ann) === 'circles' && !el(ann, 'circles-empty').hidden);
    fill(ann.page, 'create', { name: 'Neighbours', description: 'Next door' });
    submit(ann, 'create');
    await waitFor(() => view(ann) === 'circle' && el(ann, 'circle-heading').textContent === 'Neighbours');
    const id = /^#\/circles\/(c[a-z0-9]{16})$/.exec(ann.hash())?.[1];
    expect(id).toBeTruthy();
    expect(el(ann, 'circle-role').textContent).toBe('Your role: owner');
    expect(rows(ann, 'members-list')).toHaveLength(1);
    expect(ann.page.document.title).toBe('Circle – CaCi');
    expect(ann.page.focused().id).toBe('circle-heading');

    // she invites bob as a manager; the page never says whether the account exists
    fill(ann.page, 'invite', { username: 'BOB' });
    el(ann, 'invite-role').value = 'manager';
    submit(ann, 'invite');
    await waitFor(() => !el(ann, 'invite-notice').hidden);
    expect(el(ann, 'invite-notice').textContent).toBe('Invitation recorded for "bob".');
    fill(ann.page, 'invite', { username: 'nobody.at.all' });
    el(ann, 'invite-role').value = 'member';
    submit(ann, 'invite');
    await waitFor(() => el(ann, 'invite-notice').textContent === 'Invitation recorded for "nobody.at.all".');
    await waitFor(() => rows(ann, 'circle-invitations-list').length === 2);

    // bob\'s count is as old as his last look; Refresh shows the invitation; he accepts and lands on the circle
    expect(el(bob, 'home-invitations-count').textContent).toBe('You have no open invitations.');
    el(bob, 'home-refresh').fire('click');
    await waitFor(() => el(bob, 'home-invitations-count').textContent === 'You have 1 open invitation.');
    bob.go('#/invitations');
    await waitFor(() => view(bob) === 'invitations' && rows(bob, 'invitations-list').length === 1 && !slot(rows(bob, 'invitations-list')[0], 'accept').disabled);
    const row = rows(bob, 'invitations-list')[0];
    expect(slot(row, 'circle').textContent).toBe('Neighbours');
    expect(slot(row, 'meta').textContent).toBe('You would be: Manager');
    expect(slot(row, 'from').textContent).toBe('Invited by Display ann');
    slot(row, 'accept').fire('click');
    await waitFor(() => view(bob) === 'circle' && el(bob, 'circle-heading').textContent === 'Neighbours');
    expect(bob.hash()).toBe(`#/circles/${id}`);
    expect(el(bob, 'circle-role').textContent).toBe('Your role: manager');
    expect(el(bob, 'home-invitations-count').textContent).toBe('You have no open invitations.');
    await waitFor(() => rows(bob, 'members-list').length === 2);

    // as a manager he may invite members and observers only, and invites cat
    expect(el(bob, 'invite-section').hidden).toBe(false);
    expect(el(bob, 'invite-role-owner').hidden).toBe(true);
    expect(el(bob, 'invite-role-manager').hidden).toBe(true);
    expect(el(bob, 'delete-button').hidden).toBe(true);
    fill(bob.page, 'invite', { username: 'cat' });
    el(bob, 'invite-role').value = 'member';
    submit(bob, 'invite');
    await waitFor(() => !el(bob, 'invite-notice').hidden);
    cat.go('#/invitations');
    await waitFor(() => view(cat) === 'invitations' && rows(cat, 'invitations-list').length === 1 && !slot(rows(cat, 'invitations-list')[0], 'accept').disabled);
    slot(rows(cat, 'invitations-list')[0], 'accept').fire('click');
    await waitFor(() => view(cat) === 'circle' && el(cat, 'circle-role').textContent === 'Your role: member');
    expect(el(cat, 'rename-section').hidden).toBe(true);
    expect(el(cat, 'invite-section').hidden).toBe(true);
    expect(el(cat, 'leave-button').hidden).toBe(false);

    // a reload on the circle stays on the circle
    const reloaded = ann.reload();
    await waitFor(() => visibleScreens(reloaded.page)[0] === 'signed-in' && view(reloaded) === 'circle' && rows(reloaded, 'members-list').length === 3);
    expect(reloaded.hash()).toBe(`#/circles/${id}`);
    expect(el(reloaded, 'circle-heading').textContent).toBe('Neighbours');

    // ann changes cat to observer, bob (a manager) removes cat after being asked
    const catRow = () => rows(reloaded, 'members-list').find((r) => slot(r, 'name').textContent === 'Display cat');
    slot(catRow(), 'role').value = 'observer';
    slot(catRow(), 'save').fire('click');
    await waitFor(() => /Observer/.test(slot(catRow(), 'meta').textContent));
    el(bob, 'circle-refresh').fire('click');
    await waitFor(() => rows(bob, 'members-list').length === 3 && /Observer/.test(slot(rows(bob, 'members-list').find((r) => slot(r, 'name').textContent === 'Display cat'), 'meta').textContent));
    const bobCatRow = () => rows(bob, 'members-list').find((r) => slot(r, 'name').textContent === 'Display cat');
    slot(bobCatRow(), 'remove').fire('click');
    expect(slot(bobCatRow(), 'removeAsk').hidden).toBe(false);
    slot(bobCatRow(), 'removeNo').fire('click');
    expect(rows(bob, 'members-list')).toHaveLength(3); // cancelled: nothing happened
    slot(bobCatRow(), 'remove').fire('click');
    slot(bobCatRow(), 'removeYes').fire('click');
    await waitFor(() => rows(bob, 'members-list').length === 2);

    // cat is now a stranger to the circle: "no such circle", same words as for a made-up one
    el(cat, 'circle-refresh').fire('click');
    await waitFor(() => !el(cat, 'circle-gone').hidden);
    expect(el(cat, 'circle-gone').textContent).toBe('No such circle, or you are not in it.');
    const madeUp = cat.reload();
    madeUp.go('#/circles/c0000000000000000');
    await waitFor(() => view(madeUp) === 'circle' && !el(madeUp, 'circle-gone').hidden);
    expect(el(madeUp, 'circle-gone').textContent).toBe('No such circle, or you are not in it.');

    // the only owner may not leave, in the service\'s words; make bob an owner and then she may
    el(reloaded, 'leave-button').fire('click');
    expect(el(reloaded, 'leave-confirm').hidden).toBe(false);
    el(reloaded, 'leave-yes').fire('click');
    await waitFor(() => !el(reloaded, 'circle-error').hidden);
    expect(el(reloaded, 'circle-error').textContent.toLowerCase()).toContain('only owner');
    expect(reloaded.hash()).toBe(`#/circles/${id}`);
    const bobRow = () => rows(reloaded, 'members-list').find((r) => slot(r, 'name').textContent === 'Display bob');
    slot(bobRow(), 'role').value = 'owner';
    slot(bobRow(), 'save').fire('click');
    await waitFor(() => /Owner/.test(slot(bobRow(), 'meta').textContent));
    el(reloaded, 'leave-button').fire('click');
    el(reloaded, 'leave-yes').fire('click');
    await waitFor(() => reloaded.hash() === '#/circles' && view(reloaded) === 'circles');
    await waitFor(() => rows(reloaded, 'circles-list').length === 0);

    // bob, now the owner, deletes the circle after being asked
    el(bob, 'circle-refresh').fire('click');
    await waitFor(() => !el(bob, 'delete-button').hidden);
    el(bob, 'delete-button').fire('click');
    expect(el(bob, 'delete-confirm-text').textContent).toContain('removes the circle, its members and its invitations');
    el(bob, 'delete-yes').fire('click');
    await waitFor(() => bob.hash() === '#/circles' && view(bob) === 'circles');
    await waitFor(() => rows(bob, 'circles-list').length === 0 && !el(bob, 'circles-empty').hidden);

    // a hostile address lands on home
    const hostile = ann.reload();
    hostile.go('#/circles/..%2f..');
    await waitFor(() => view(hostile) === 'home');
    expect(hostile.hash()).toBe('#/circles/..%2f..'); // the page does not rewrite the address; it just shows home
  });

  it('markup in names stays text across the whole journey', async () => {
    const { port } = await start();
    await register(port, 'root');
    const ann = await register(port, 'ann');
    ann.go('#/circles');
    await waitFor(() => view(ann) === 'circles' && !el(ann, 'create-submit').disabled);
    fill(ann.page, 'create', { name: '<img src=x onerror=alert(1)>', description: '<script>x</script>' });
    submit(ann, 'create');
    await waitFor(() => view(ann) === 'circle' && el(ann, 'circle-heading').textContent === '<img src=x onerror=alert(1)>');
    expect(el(ann, 'circle-description').textContent).toBe('<script>x</script>');
    await waitFor(() => rows(ann, 'members-list').length === 1);
    expect(slot(rows(ann, 'members-list')[0], 'name').children).toEqual([]);
  });
});

const NOTE_LIMIT = 8000;

describe('the notes client against the real service (demo model, two accounts)', () => {
  const person = async (port, name) => {
    const jar = browserFetch(port);
    const session = createSession({ api: createApiClient({ fetchFn: jar }) });
    expect(await session.register({ username: name, displayName: `Display ${name}`, password: PW })).toEqual({ ok: true });
    return createNotesClient({ fetchFn: jar });
  };

  it('mode, propose, look, approve, browse, and nobody else can reach any of it', async () => {
    const { port } = await start();
    await person(port, 'root'); // the first account is the administrator
    const ann = await person(port, 'ann');
    const bob = await person(port, 'bob');

    expect((await ann.mode()).value).toEqual({ mode: 'demo' });
    expect((await ann.categories()).value.items).toEqual([]);

    const made = await ann.propose('  Dr Patel booked my blood test  ');
    expect(made.ok).toBe(true);
    const p = made.value;
    expect(isProposalId(p.id)).toBe(true);
    expect(p).toMatchObject({ mode: 'demo' });
    expect(p.expiresAt - p.createdAt).toBe(15 * 60_000);
    expect(p.summary.newItems).toHaveLength(1);
    expect(p.operations.map((o) => o.op)).toEqual(['upsertNode', 'upsertNode', 'link']);
    expect(Object.keys(p).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'mode', 'operations', 'rationale', 'summary', 'text']);
    expect((await ann.getProposal(p.id)).value).toEqual(p);
    expect((await ann.categories()).value.items).toEqual([]); // nothing written yet

    // bob can reach none of it, and gets what a made-up proposal gets
    const mine = await bob.getProposal(p.id);
    expect(mine.error).toEqual({ kind: 'not-found', what: 'proposal', message: 'That proposal is gone or has expired. Make it again.' });
    expect((await bob.approve(p.id)).error).toEqual(mine.error);
    expect((await bob.reject(p.id)).error).toEqual(mine.error);
    expect((await bob.getProposal('prop-0000000000-00-aaaaaa')).error).toEqual(mine.error);

    const done = await ann.approve(p.id);
    expect(done.value).toMatchObject({ id: p.id, applied: 3 });
    expect((await ann.approve(p.id)).error.kind).toBe('not-found'); // once only

    const cats = (await ann.categories()).value;
    expect(cats.items).toHaveLength(1);
    expect(cats.items[0]).toMatchObject({ itemCount: 1 });
    expect(cats.nextCursor).toBeNull();
    const categoryId = cats.items[0].id;
    const inCategory = (await ann.categoryItems(categoryId)).value;
    expect(inCategory.category.id).toBe(categoryId);
    expect(inCategory.items).toHaveLength(1);
    const itemId = inCategory.items[0].id;
    const detail = (await ann.item(itemId)).value;
    expect(detail.item.id).toBe(itemId);
    expect(detail.categories.map((c) => c.id)).toEqual([categoryId]);
    expect(typeof detail.categories[0].weight).toBe('number');

    // bob sees an empty brain and cannot reach ann's ids, which read exactly like made-up ones
    expect((await bob.categories()).value.items).toEqual([]);
    expect((await bob.categoryItems(categoryId)).error).toEqual({ kind: 'not-found', what: 'category', message: 'Not found: it may have been removed.' });
    expect((await bob.item(itemId)).error).toEqual({ kind: 'not-found', what: 'item', message: 'Not found: it may have been removed.' });
    for (const awkward of ['a/b?c=d&e#f %é😀<b>..', ' ', 'x'.repeat(256)]) {
      expect((await ann.categoryItems(awkward)).error.kind, awkward.slice(0, 10)).toBe('not-found');
      expect((await ann.item(awkward)).error.kind).toBe('not-found');
    }
  });

  it('rejecting writes nothing; a refused note and a full pending list are in the service\'s words', async () => {
    const { port } = await start({ maxPendingPerUser: 1 });
    await person(port, 'root');
    const ann = await person(port, 'ann');
    const first = (await ann.propose('a note about boats')).value;
    const second = await ann.propose('another note about sailing');
    expect(second.error).toMatchObject({ kind: 'limit', message: 'you have too many proposals waiting: approve or reject one first' });
    expect(await ann.reject(first.id)).toEqual({ ok: true, value: true });
    expect((await ann.getProposal(first.id)).error.kind).toBe('not-found');
    expect((await ann.categories()).value.items).toEqual([]);
    expect((await ann.propose('x'.repeat(NOTE_LIMIT + 1))).error).toMatchObject({ kind: 'invalid', field: 'text' });
    expect((await ann.propose('a third note about gardens')).ok).toBe(true);
  });

  it('a signed-out client is told so on every call', async () => {
    const { port } = await start();
    const stranger = createNotesClient({ fetchFn: browserFetch(port) });
    for (const r of [await stranger.mode(), await stranger.propose('a note'), await stranger.categories(), await stranger.categoryItems('c'), await stranger.item('i')]) expect(r.error).toEqual({ kind: 'signed-out', message: 'Your session has ended. Sign in again.' });
  });
});
