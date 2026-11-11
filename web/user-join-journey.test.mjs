import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startService } from '../src/service/service.ts';
import { createApiClient } from './api-client.js';
import { createCirclesClient } from './circles-client.js';
import { fakePage, fill, waitFor } from './fake-page.test-util.mjs';
import { createJoinClient } from './join-client.js';
import { browserFetch, PW } from './sharing-world.test-util.mjs';
import { userHooks } from './user-hooks.js';
import { mountUser } from './user-mount.js';

// The join journey through the everyday app's own page (the real user.html) against the real service: real SQLite files, real
// HTTP, real sessions. A new person opens a link, signs up, joins or asks, and is approved.

const dirs = [];
const running = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'caci-user-join-'));
  dirs.push(dir);
  const service = await startService({ port: 0, bind: '127.0.0.1', dataDir: dir, allowRegistration: true, cookieSecure: false, trustedProxies: 1, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, maxBrainScopes: 25, statusPerHour: 20, ledgerDays: 90, sessionIdleDays: 7, sessionDays: 30, agentAccess: false, joinLinks: true });
  running.push(service);
  const people = {};
  for (const name of ['ann', 'bob']) {
    const fetch = browserFetch(service.port);
    const api = createApiClient({ fetchFn: fetch });
    await api.register({ username: name, displayName: `Display ${name}`, password: PW });
    await api.login({ username: name, password: PW });
    people[name] = { fetch, circles: createCirclesClient({ fetchFn: fetch }), join: createJoinClient({ fetchFn: fetch }) };
  }
  const circle = (await people.ann.circles.createCircle({ name: 'Club <b>x</b>' })).value.id;
  return { ...people, circle, service };
}

/** A new browser on the everyday app, at an address, with its own cookie jar. */
function newcomer(service, hash) {
  const fetch = browserFetch(service.port);
  const page = fakePage('user.html');
  let current = hash;
  const replaced = [];
  const listeners = [];
  const env = { getHash: () => current, setHash: (h) => { current = h; for (const l of listeners) l(); }, replaceHash: (h) => { replaced.push(h); current = h; }, onHashChange: (fn) => listeners.push(fn) };
  mountUser(page.document, fetch, env, (ctx) => userHooks(page.document, fetch, ctx));
  return { page, fetch, hash: () => current, replaced, go: (h) => env.setHash(h), join: createJoinClient({ fetchFn: fetch }), circles: createCirclesClient({ fetchFn: fetch }) };
}
const el = (b, id) => b.page.el(id);
const makeLink = async (w, body = {}) => (await w.ann.join.createLink(w.circle, { label: 'Chat', uses: 3, ...body })).value.token;

describe('the everyday app\'s join screen, against the real service', () => {
  it('a new person opens a link, is asked to sign up, asks to join, waits, is approved and finds the circle', async () => {
    const w = await world();
    const token = await makeLink(w, { role: 'member' }); // approval is on by default
    const gus = newcomer(w.service, `#/join/${token}`);
    await waitFor(() => !el(gus, 'screen-signed-out').hidden);

    // not signed in: the person is told why, and nothing about the circle is shown or sent; the link stays in the address
    expect(el(gus, 'join-signedout-note').hidden).toBe(false);
    expect(el(gus, 'view-join').hidden).toBe(true);
    expect(gus.hash()).toBe(`#/join/${token}`);

    // they create an account on the same page: they are signed in and the join screen takes over, with the address cleaned
    el(gus, 'show-register').fire('click');
    fill(gus.page, 'register', { username: 'gus', displayName: 'Gus G', email: '', password: PW });
    el(gus, 'register-form').fire('submit');
    await waitFor(() => !el(gus, 'view-join').hidden && !el(gus, 'join-preview').hidden);
    expect(gus.replaced).toEqual(['#/join']);
    expect(gus.hash()).toBe('#/join');
    expect(el(gus, 'join-preview-text').textContent).toBe('You have been invited to join the circle "Club <b>x</b>" as Member. The link was made by Display ann.');
    expect(el(gus, 'join-preview-text').children).toEqual([]);

    // they join: with approval on that is a request, not a membership
    el(gus, 'join-confirm').fire('click');
    await waitFor(() => !el(gus, 'join-result').hidden);
    expect(el(gus, 'join-result-text').textContent).toContain('has been sent');
    expect(el(gus, 'join-open-circle').hidden).toBe(true);
    await waitFor(() => el(gus, 'join-mine-list').children.length === 1);
    expect(el(gus, 'join-mine-list').children[0].querySelector('[data-slot="text"]').textContent).toMatch(/^Club <b>x<\/b>: You asked to join as: Member/);
    expect((await gus.circles.getCircle(w.circle)).ok).toBe(false);

    // opening the link again is the same miss as for any link that does not work: the one use is spent, and their request is listed
    el(gus, 'join-cancel').fire('click');
    await waitFor(() => !el(gus, 'view-home').hidden);
    gus.go('#/join');
    expect(el(gus, 'join-miss').textContent).toContain('needs a join link');

    // ann approves; gus finds the circle among his own
    const request = (await w.ann.join.listRequests(w.circle)).value.items;
    expect(request.map((r) => r.person.displayName)).toEqual(['Gus G']);
    expect((await w.ann.join.approve(w.circle, request[0].id)).value).toMatchObject({ username: 'gus', role: 'member' });
    gus.go('#/settings');
    await waitFor(() => el(gus, 'nav-circles').children.length === 1);
    expect(el(gus, 'nav-circles').children[0].querySelector('[data-slot="link"]').textContent).toBe('Club <b>x</b>');
    gus.go(`#/circle/${w.circle}`);
    await waitFor(() => el(gus, 'circle-heading').textContent !== '');
    expect(el(gus, 'circle-heading').textContent).toBe('Club <b>x</b>');
  });

  it('a link that needs no approval joins at once and offers the circle; opening it again says the person is already in', async () => {
    const w = await world();
    const token = await makeLink(w, { role: 'observer', approval: false, uses: 5 });
    const bob = newcomer(w.service, '#/');
    // bob is already an account (his own browser from the world); sign him in on the page
    await waitFor(() => !el(bob, 'screen-signed-out').hidden);
    fill(bob.page, 'signin', { username: 'bob', password: PW });
    el(bob, 'signin-form').fire('submit');
    await waitFor(() => !el(bob, 'screen-signed-in').hidden);
    bob.go(`#/join/${token}`);
    await waitFor(() => !el(bob, 'join-preview').hidden);
    el(bob, 'join-confirm').fire('click');
    await waitFor(() => !el(bob, 'join-open-circle').hidden);
    expect(el(bob, 'join-result-text').textContent).toBe('You are now a member of "Club <b>x</b>" as Observer.');
    expect(el(bob, 'join-open-circle').getAttribute('href')).toBe(`#/circle/${w.circle}`);
    expect((await w.ann.circles.getCircle(w.circle)).value.memberCount).toBe(2);
    // the link is used again, by the same person: nothing changes and no use is spent
    bob.go(`#/join/${token}`);
    await waitFor(() => !el(bob, 'join-preview').hidden);
    el(bob, 'join-confirm').fire('click');
    await waitFor(() => el(bob, 'join-result-text').textContent.includes('already in'));
    expect(el(bob, 'join-result-text').textContent).toBe('You are already in "Club <b>x</b>" as Observer. Nothing was changed.');
    expect((await w.ann.join.listLinks(w.circle)).value.items[0].uses).toBe(1);
  });

  it('a link that has been withdrawn is the miss for a newcomer, with nothing of the circle shown', async () => {
    const w = await world();
    const made = await w.ann.join.createLink(w.circle, { label: 'Temp', uses: 5 });
    await w.ann.join.revokeLink(w.circle, made.value.link.id);
    const gus = newcomer(w.service, `#/join/${made.value.token}`);
    await waitFor(() => !el(gus, 'screen-signed-out').hidden);
    el(gus, 'show-register').fire('click');
    fill(gus.page, 'register', { username: 'gus', displayName: 'Gus G', email: '', password: PW });
    el(gus, 'register-form').fire('submit');
    await waitFor(() => el(gus, 'join-miss').textContent.includes('does not work'));
    expect(el(gus, 'join-miss').textContent).toContain('This link does not work');
    expect(el(gus, 'join-preview').hidden).toBe(true);
    expect(el(gus, 'join-preview-text').textContent).toBe('');
  });
});
