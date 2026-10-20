import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startService } from '../src/service/service.ts';
import { createCirclesClient } from './circles-client.js';
import { mountChatPage } from './chat-page.js';
import { fakePage, fill, waitFor } from './fake-page.test-util.mjs';
import { createNotesClient } from './notes-client.js';
import { browserFetch, PW } from './sharing-world.test-util.mjs';
import { mountUser } from './user-mount.js';

// The everyday app (R-016) through its own page code against the real service: real SQLite files, real HTTP, real sessions and the
// free demo model. Each person has their own page (built from the real user.html) on their own cookie jar.

let dir;
let service;
afterEach(async () => {
  await service?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  service = undefined;
});
async function boot() {
  dir = mkdtempSync(join(tmpdir(), 'caci-user-app-'));
  service = await startService({ port: 0, bind: '127.0.0.1', dataDir: dir, allowRegistration: true, cookieSecure: false, trustedProxies: 1, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, maxBrainScopes: 25, statusPerHour: 20 });
}

function browser(fetchFn = browserFetch(service.port), hash = '') {
  const page = fakePage('user.html');
  let current = hash;
  const listeners = [];
  const env = { getHash: () => current, setHash: (h) => { current = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  mountUser(page.document, fetchFn, env, ({ recheck }) => mountChatPage(page.document, createNotesClient({ fetchFn }), recheck));
  return { page, fetchFn, go: (h) => env.setHash(h) };
}
const el = (b, id) => b.page.el(id);
const thread = (b) => el(b, 'chat-thread').children.map((row) => ({ cls: row.getAttribute('class'), text: row.querySelector('[data-slot="text"]').textContent, lines: row.querySelector('[data-slot="lines"]').children.map((l) => l.querySelector('[data-slot="text"]').textContent), choices: row.querySelector('[data-slot="choices"]').children.map((c) => c.querySelector('[data-slot="button"]')) }));
const signedIn = (b) => !el(b, 'screen-signed-in').hidden;
const idle = (b) => signedIn(b) && !el(b, 'update-send').disabled;

async function register(b, username, displayName) {
  await waitFor(() => !el(b, 'screen-signed-out').hidden, 'the sign-in form');
  el(b, 'show-register').fire('click');
  fill(b.page, 'register', { username, displayName, email: '', password: PW });
  el(b, 'register-form').fire('submit');
  await waitFor(() => idle(b), 'Home after registering');
}
async function send(b, text, until) {
  el(b, 'update-text').value = text;
  el(b, 'update-form').fire('submit');
  await waitFor(until ?? (() => idle(b) && thread(b).at(-1)?.from !== 'me'), 'the reply');
}
const lastIs = (b, prefix) => () => idle(b) && (thread(b).at(-1)?.text ?? '').startsWith(prefix);
const askQ = async (b, text) => {
  el(b, 'question-text').value = text;
  el(b, 'question-form').fire('submit');
  await waitFor(() => idle(b) && thread(b).at(-1)?.cls.startsWith('msg cacci') && thread(b).at(-1)?.text !== '', 'the answer');
};

describe('the everyday app, through the pages, against the real service', () => {
  it('register, the model notice first, record, replace, record into a circle, ask, change settings, sign out and sign in', async () => {
    await boot();
    const eve = browser();
    await register(eve, 'eve', 'Eve Smith');
    expect(el(eve, 'user-display-name').textContent).toBe('Eve Smith');
    expect(el(eve, 'chat-notice').textContent).toContain('free demo model');
    expect(thread(eve)).toEqual([]);

    // a note with only her own brain files straight away, and says so
    await send(eve, 'Mum takes 2 tablets daily after breakfast', lastIs(eve, 'Recorded'));
    let t = thread(eve);
    expect(t.map((m) => m.text)).toEqual(['Mum takes 2 tablets daily after breakfast', 'Recorded against your brain']);
    expect(t[1].lines.length).toBeGreaterThan(0);

    // a change to the same fact replaces the old one, and the thread says what was replaced
    await send(eve, 'Mum now takes 1 tablet daily after breakfast', lastIs(eve, 'Recorded'));
    t = thread(eve);
    expect(t.at(-1).lines.some((l) => l.startsWith('Replaced:'))).toBe(true);

    // a circle she owns: the thread asks, and the answer decides where it is filed
    const circles = createCirclesClient({ fetchFn: eve.fetchFn });
    const made = await circles.createCircle({ name: 'Club <b>one</b>' });
    expect(made.ok).toBe(true);
    await send(eve, 'Bins go out on Thursday', (() => () => thread(eve).at(-1)?.text === 'Is this for you or a circle?')());
    t = thread(eve);
    expect(t.at(-1).choices.map((b) => b.textContent)).toEqual(['Me', 'Club <b>one</b>', 'Cancel']);
    expect(el(eve, 'update-send').disabled).toBe(true);
    t.at(-1).choices[1].fire('click');
    await waitFor(lastIs(eve, 'Recorded against the circle'), 'the circle filing');
    expect(thread(eve).at(-1).text).toBe('Recorded against the circle "Club <b>one</b>"');

    // a question reads every brain, and names where each point came from
    await askQ(eve, 'What is happening with the bins?');
    const answer = thread(eve).at(-1);
    expect(answer.lines.join('\n')).toContain('Bins go out on Thursday');
    expect(answer.lines.join('\n')).toContain('From: "Club <b>one</b>"');

    // settings: a new name shows at the top, a new password ends the old one
    eve.go('#/settings');
    expect(el(eve, 'view-settings').hidden).toBe(false);
    el(eve, 'profile-displayName').value = 'Eve Jones';
    el(eve, 'profile-form').fire('submit');
    await waitFor(() => el(eve, 'user-display-name').textContent === 'Eve Jones', 'the new name');
    fill(eve.page, 'password', { currentPassword: PW, newPassword: 'a brand new password 9' });
    el(eve, 'password-form').fire('submit');
    await waitFor(() => !el(eve, 'password-notice').hidden, 'the password notice');
    eve.go('#/');
    expect(thread(eve).length).toBeGreaterThan(4); // the thread is kept moving between Home and Settings

    // sign out clears everything; the old password no longer works, the new one does
    eve.go('#/settings');
    el(eve, 'signout').fire('click');
    await waitFor(() => !el(eve, 'screen-signed-out').hidden, 'sign-in');
    expect(thread(eve)).toEqual([]);
    fill(eve.page, 'signin', { username: 'eve', password: PW });
    el(eve, 'signin-form').fire('submit');
    await waitFor(() => el(eve, 'signin-error').textContent !== '' && !el(eve, 'signin-submit').disabled, 'the refusal');
    fill(eve.page, 'signin', { username: 'eve', password: 'a brand new password 9' });
    el(eve, 'signin-form').fire('submit');
    await waitFor(() => signedIn(eve), 'signing in again');
    eve.go('#/');
    await waitFor(() => idle(eve), 'Home again');
    expect(thread(eve)).toEqual([]);
    expect(el(eve, 'user-display-name').textContent).toBe('Eve Jones');

    // what she recorded is still there after signing in again
    await askQ(eve, 'tablets');
    expect(thread(eve).at(-1).lines.join('\n')).toContain('1 tablet');
    expect(thread(eve).at(-1).lines.join('\n')).not.toContain('2 tablets daily');
  });

  it('an observer is not offered the circle and her update goes to her own brain; a stranger\'s question never reads the circle', async () => {
    await boot();
    const eve = browser();
    await register(eve, 'eve', 'Eve');
    const circles = createCirclesClient({ fetchFn: eve.fetchFn });
    const club = (await circles.createCircle({ name: 'Club' })).value.id;
    const fay = browser();
    await register(fay, 'fay', 'Fay');
    const dan = browser();
    await register(dan, 'dan', 'Dan');
    expect((await circles.invite(club, { username: 'fay', role: 'observer' })).ok).toBe(true);
    const fayNotes = createNotesClient({ fetchFn: fay.fetchFn });
    const invitation = (await createCirclesClient({ fetchFn: fay.fetchFn }).myInvitations()).value.items[0].id;
    expect((await createCirclesClient({ fetchFn: fay.fetchFn }).acceptInvitation(invitation)).ok).toBe(true);
    expect((await fayNotes.scopes()).value.items.find((s) => s.scope.kind === 'circle').canCapture).toBe(false);

    await send(eve, 'Club AUDIT-MARK secret plan', (() => () => thread(eve).at(-1)?.text === 'Is this for you or a circle?')());
    thread(eve).at(-1).choices[1].fire('click');
    await waitFor(lastIs(eve, 'Recorded against the circle'), 'filing');

    // the observer is not asked: it goes to her own brain
    fay.go('#/');
    await send(fay, 'Fay own note about gardening', lastIs(fay, 'Recorded'));
    expect(thread(fay).map((m) => m.text)).toEqual(['Fay own note about gardening', 'Recorded against your brain']);
    expect(thread(fay).some((m) => m.choices.length > 0)).toBe(false);
    // but she can read the circle by asking
    await askQ(fay, 'plan');
    expect(thread(fay).at(-1).lines.join('\n')).toContain('AUDIT-MARK');

    // a person in no circle never sees it
    await askQ(dan, 'what is the club plan');
    expect(thread(dan).at(-1).text + thread(dan).at(-1).lines.join()).not.toContain('AUDIT-MARK');
  });

  it('the page is reachable at / and the back office at /admin, both from the same service', async () => {
    await boot();
    const home = await fetch(`http://127.0.0.1:${service.port}/`);
    const admin = await fetch(`http://127.0.0.1:${service.port}/admin`);
    expect(home.status).toBe(200);
    expect(admin.status).toBe(200);
    expect(await home.text()).toContain('/user-app.js');
    expect(await admin.text()).toContain('/app.js');
    for (const f of ['chat-page.js', 'chat-view.js', 'chat-session.js', 'user-mount.js', 'user-style.css']) expect((await fetch(`http://127.0.0.1:${service.port}/${f}`)).status, f).toBe(200);
  });
});
