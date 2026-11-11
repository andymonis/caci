import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startService } from '../src/service/service.ts';
import { createApiClient } from './api-client.js';
import { createCirclesClient } from './circles-client.js';
import { fakePage, waitFor } from './fake-page.test-util.mjs';
import { createJoinClient } from './join-client.js';
import { mount } from './mount.js';
import { browserFetch, PW } from './sharing-world.test-util.mjs';

// The whole join journey through the pages' own code against the real service: real SQLite files, real HTTP, real sessions.
// Each person has their own page (built from the real index.html) on their own cookie jar.

const dirs = [];
const running = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function world(joinLinks = true) {
  const dir = mkdtempSync(join(tmpdir(), 'caci-join-journey-'));
  dirs.push(dir);
  const service = await startService({ port: 0, bind: '127.0.0.1', dataDir: dir, allowRegistration: true, cookieSecure: false, trustedProxies: 1, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, maxBrainScopes: 25, statusPerHour: 20, ledgerDays: 90, sessionIdleDays: 7, sessionDays: 30, agentAccess: false, joinLinks });
  running.push(service);
  const people = {};
  for (const name of ['ann', 'bob', 'cat', 'eve', 'fay']) {
    const fetch = browserFetch(service.port);
    const api = createApiClient({ fetchFn: fetch });
    await api.register({ username: name, displayName: `Display ${name}`, password: PW });
    await api.login({ username: name, password: PW });
    people[name] = { fetch, circles: createCirclesClient({ fetchFn: fetch }), join: createJoinClient({ fetchFn: fetch }) };
  }
  const circle = (await people.ann.circles.createCircle({ name: 'Club' })).value.id;
  for (const [name, role] of [['bob', 'manager'], ['cat', 'member']]) {
    await people.ann.circles.invite(circle, { username: name, role });
    const invitation = (await people[name].circles.myInvitations()).value.items[0].id;
    await people[name].circles.acceptInvitation(invitation);
  }
  return { ...people, circle, service };
}

function browser(person, hash) {
  const page = fakePage();
  let current = hash;
  const listeners = [];
  const env = { getHash: () => current, getOrigin: () => 'https://caci.example', setHash: (h) => { current = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  mount(page.document, person.fetch, env);
  return { page, go: (h) => env.setHash(h) };
}
const el = (b, id) => b.page.el(id);
const slot = (row, name) => row.querySelector(`[data-slot="${name}"]`);
const rows = (b, id) => el(b, id).children;
const titles = (b, id) => [...rows(b, id)].map((r) => slot(r, 'title').textContent);
const allText = (b) => b.page.ids.map((id) => b.page.el(id).textContent ?? '').join('\n');
const circlePage = async (person, circle) => {
  const b = browser(person, `#/circles/${circle}`);
  await waitFor(() => !el(b, 'circle-body').hidden || !el(b, 'circle-gone').hidden);
  return b;
};

describe('joining by a link through the pages, against the real service', () => {
  it('ann makes a link on her page; two people ask; she approves one and a manager declines the other; the roster and the people\'s own lists follow', async () => {
    const w = await world();
    const ann = await circlePage(w.ann, w.circle);
    const bob = await circlePage(w.bob, w.circle);
    const cat = await circlePage(w.cat, w.circle);

    // owners and managers see the section, a member does not; nothing is asked until the button is pressed
    expect([el(ann, 'join-section').hidden, el(bob, 'join-section').hidden, el(cat, 'join-section').hidden]).toEqual([false, false, true]);
    expect(el(ann, 'join-load').hidden).toBe(false);
    el(ann, 'join-load').fire('click');
    await waitFor(() => !el(ann, 'join-body').hidden);
    expect(el(ann, 'join-links-empty').hidden).toBe(false);

    // she makes a link for members, two uses, with approval; its address is shown once
    el(ann, 'join-label').value = 'Neighbours <b>chat</b>';
    el(ann, 'join-role').value = 'member';
    el(ann, 'join-uses').value = '2';
    el(ann, 'join-form').fire('submit');
    await waitFor(() => !el(ann, 'join-created').hidden);
    const url = el(ann, 'join-created-url').textContent;
    expect(url).toMatch(/^https:\/\/caci\.example\/#\/join\/cjoin_[A-Za-z0-9_-]{43}$/);
    const token = url.slice(url.indexOf('#/join/') + 7);
    expect(titles(ann, 'join-links-list')).toEqual(['Neighbours <b>chat</b>']);
    expect(slot(rows(ann, 'join-links-list')[0], 'title').children).toEqual([]);
    expect(allText(ann).split(token).length - 1).toBe(1); // the token is on the page exactly once
    el(ann, 'join-created-done').fire('click');
    expect(allText(ann)).not.toContain(token);

    // eve and fay use it: each previews, then asks
    for (const person of [w.eve, w.fay]) {
      expect((await person.join.preview(token)).value).toEqual({ circle: { name: 'Club' }, role: 'member', createdBy: { displayName: 'Display ann' } });
      expect((await person.join.join(token)).value.state).toBe('requested');
    }
    // eve looks at her own waiting requests on the Invitations screen
    const eve = browser(w.eve, '#/invitations');
    await waitFor(() => !el(eve, 'view-invitations').hidden); // signed in and on the screen
    el(eve, 'my-requests-load').fire('click');
    await waitFor(() => titles(eve, 'my-requests-list').length === 1);
    expect(titles(eve, 'my-requests-list')).toEqual(['Club']);
    expect(slot(rows(eve, 'my-requests-list')[0], 'meta').textContent).toMatch(/^You asked to join as: Member · asked \d{4}-\d{2}-\d{2} · lapses \d{4}-\d{2}-\d{2}$/);

    // ann refreshes and sees both, by display name, and the used-up link is gone from the live list; she approves eve
    el(ann, 'join-refresh').fire('click');
    await waitFor(() => rows(ann, 'join-requests-list').length === 2);
    expect(titles(ann, 'join-requests-list').sort()).toEqual(['Display eve', 'Display fay']);
    expect(el(ann, 'join-links-empty').hidden).toBe(false); // both uses are spent, so the link is no longer live and is not listed
    const eveRow = [...rows(ann, 'join-requests-list')].find((r) => slot(r, 'title').textContent === 'Display eve');
    slot(eveRow, 'approve').fire('click');
    await waitFor(() => el(ann, 'join-notice').textContent === 'Approved: Display eve is now a member.');
    expect(titles(ann, 'join-requests-list')).toEqual(['Display fay']);
    // the circle's roster on the same page follows without pressing anything
    await waitFor(() => [...rows(ann, 'members-list')].some((r) => slot(r, 'name').textContent.startsWith('Display eve')));
    expect((await w.eve.circles.getCircle(w.circle)).value).toMatchObject({ role: 'member' });
    el(eve, 'my-requests-load').fire('click');
    await waitFor(() => !el(eve, 'my-requests-empty').hidden);
    expect(rows(eve, 'my-requests-list')).toEqual([]);

    // bob, a manager, declines fay; the link's two uses are spent and stay spent
    el(bob, 'join-load').fire('click');
    await waitFor(() => rows(bob, 'join-requests-list').length === 1);
    expect(titles(bob, 'join-requests-list')).toEqual(['Display fay']);
    slot(rows(bob, 'join-requests-list')[0], 'decline').fire('click');
    await waitFor(() => el(bob, 'join-notice').textContent === 'Declined: Display fay was not added.');
    expect((await w.fay.circles.getCircle(w.circle)).ok).toBe(false);
    expect((await w.fay.join.join(token)).error).toMatchObject({ kind: 'not-found', what: 'link' });
  });

  it('withdrawing a link on the page, after the question, makes it a miss for everyone', async () => {
    const w = await world();
    const ann = await circlePage(w.ann, w.circle);
    el(ann, 'join-load').fire('click');
    await waitFor(() => !el(ann, 'join-body').hidden);
    el(ann, 'join-label').value = 'Temp';
    el(ann, 'join-uses').value = '5';
    el(ann, 'join-form').fire('submit');
    await waitFor(() => !el(ann, 'join-created').hidden);
    const url = el(ann, 'join-created-url').textContent;
    const token = url.slice(url.indexOf('#/join/') + 7);
    expect((await w.eve.join.preview(token)).ok).toBe(true);
    const row = () => rows(ann, 'join-links-list')[0];
    slot(row(), 'revoke').fire('click');
    expect(slot(row(), 'ask').hidden).toBe(false);
    slot(row(), 'no').fire('click');
    expect((await w.eve.join.preview(token)).ok).toBe(true); // cancelling changed nothing
    slot(row(), 'revoke').fire('click');
    slot(row(), 'yes').fire('click');
    await waitFor(() => rows(ann, 'join-links-list').length === 0);
    expect(el(ann, 'join-notice').textContent).toContain('withdrawn');
    expect((await w.eve.join.preview(token)).error).toMatchObject({ kind: 'not-found', what: 'link' });
    expect((await w.fay.join.join(token)).error).toMatchObject({ kind: 'not-found', what: 'link' });
  });

  it('a person leaving the screen and coming back finds no trace of a link\'s address, and a stranger\'s page shows nothing', async () => {
    const w = await world();
    const ann = await circlePage(w.ann, w.circle);
    el(ann, 'join-load').fire('click');
    await waitFor(() => !el(ann, 'join-body').hidden);
    el(ann, 'join-label').value = 'One';
    el(ann, 'join-form').fire('submit');
    await waitFor(() => !el(ann, 'join-created').hidden);
    const url = el(ann, 'join-created-url').textContent;
    ann.go('#/circles');
    await waitFor(() => el(ann, 'join-section').hidden);
    ann.go(`#/circles/${w.circle}`);
    await waitFor(() => !el(ann, 'circle-body').hidden);
    expect(allText(ann)).not.toContain(url.slice(url.indexOf('#/join/') + 7));
    const eve = await circlePage(w.eve, w.circle);
    expect(el(eve, 'circle-gone').hidden).toBe(false);
    expect(el(eve, 'join-section').hidden).toBe(true);
  });

  it('with join links switched off the page says so instead of showing the section\'s lists', async () => {
    const w = await world(false);
    const ann = await circlePage(w.ann, w.circle);
    el(ann, 'join-load').fire('click');
    await waitFor(() => !el(ann, 'join-error').hidden);
    expect(el(ann, 'join-error').textContent).toBe('Join links are not switched on in this service.');
    expect(el(ann, 'join-body').hidden).toBe(true);
    const eve = browser(w.eve, '#/invitations');
    await waitFor(() => !el(eve, 'view-invitations').hidden); // signed in and on the screen
    el(eve, 'my-requests-load').fire('click');
    await waitFor(() => !el(eve, 'my-requests-error').hidden);
    expect(el(eve, 'my-requests-error').textContent).toBe('Join links are not switched on in this service.');
  });
});
