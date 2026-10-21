import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startService } from '../src/service/service.ts';
import { createCirclesClient } from './circles-client.js';
import { fakePage, fill, waitFor } from './fake-page.test-util.mjs';
import { createLedgerClient } from './ledger-client.js';
import { createNotesClient } from './notes-client.js';
import { userHooks } from './user-hooks.js';
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
  mountUser(page.document, fetchFn, env, (context) => userHooks(page.document, fetchFn, context));
  return { page, fetchFn, go: (h) => env.setHash(h) };
}
const el = (b, id) => b.page.el(id);
const thread = (b) => el(b, 'chat-thread').children.map((row) => ({ cls: row.getAttribute('class'), text: row.querySelector('[data-slot="text"]').textContent, lines: row.querySelector('[data-slot="lines"]').children.map((l) => l.querySelector('[data-slot="text"]').textContent) }));
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

const cthread = (b) => el(b, 'circle-thread').children.map((row) => ({ cls: row.getAttribute('class'), text: row.querySelector('[data-slot="text"]').textContent, lines: row.querySelector('[data-slot="lines"]').children.map((l) => l.querySelector('[data-slot="text"]').textContent) }));
const navLinks = (b) => el(b, 'nav-circles').children.map((row) => row.querySelector('[data-slot="link"]').textContent);
const circleReady = (b) => !el(b, 'view-circle').hidden && el(b, 'circle-heading').textContent !== '' && b.page.document.title === `${el(b, 'circle-heading').textContent} – CaCi` && !el(b, 'circle-pulse').disabled;

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

    // a circle she owns: Send on Home still records against her own brain (the circle has its own screen)
    const circles = createCirclesClient({ fetchFn: eve.fetchFn });
    const made = await circles.createCircle({ name: 'Club <b>one</b>' });
    expect(made.ok).toBe(true);
    await send(eve, 'Bins go out on Thursday', lastIs(eve, 'Recorded'));
    expect(thread(eve).at(-1).text).toBe('Recorded against your brain');
    const clubNotes = createNotesClient({ fetchFn: eve.fetchFn });
    const proposed = await clubNotes.propose('Club AUDIT-PLAN is on Friday', { kind: 'circle', circleId: made.value.id });
    expect((await clubNotes.approve(proposed.value.id)).ok).toBe(true);

    // a question reads every brain, and names where each point came from
    await askQ(eve, 'What is happening with the bins?');
    const answer = thread(eve).at(-1);
    expect(answer.lines.join('\n')).toContain('Bins go out on Thursday');
    await askQ(eve, 'AUDIT-PLAN Friday');
    expect(thread(eve).at(-1).lines.join('\n')).toContain('From: "Club <b>one</b>"');

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

  it('Home is the own brain for everyone: an observer\'s note goes to her own brain and she can still read the circle by asking; a stranger never sees it', async () => {
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
    const fayCircles = createCirclesClient({ fetchFn: fay.fetchFn });
    const invitation = (await fayCircles.myInvitations()).value.items[0].id;
    expect((await fayCircles.acceptInvitation(invitation)).ok).toBe(true);
    const eveNotes = createNotesClient({ fetchFn: eve.fetchFn });
    const made = await eveNotes.propose('Club AUDIT-MARK secret plan', { kind: 'circle', circleId: club });
    expect((await eveNotes.approve(made.value.id)).ok).toBe(true);

    fay.go('#/');
    await send(fay, 'Fay own note about gardening', lastIs(fay, 'Recorded'));
    expect(thread(fay).map((m) => m.text)).toEqual(['Fay own note about gardening', 'Recorded against your brain']);
    await askQ(fay, 'plan');
    expect(thread(fay).at(-1).lines.join('\n')).toContain('AUDIT-MARK');

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

  it('circle screens: a link per circle at the top, Home Send is the own brain, a circle Send is the circle, the Pulse reads only that circle, an observer can only read, and a stranger or a removed member gets the one answer', async () => {
    await boot();
    const eve = browser();
    await register(eve, 'eve', 'Eve');
    const eveCircles = createCirclesClient({ fetchFn: eve.fetchFn });
    const club = (await eveCircles.createCircle({ name: 'Club' })).value.id;
    const fay = browser();
    await register(fay, 'fay', 'Fay');
    const dan = browser();
    await register(dan, 'dan', 'Dan');
    expect((await eveCircles.invite(club, { username: 'fay', role: 'observer' })).ok).toBe(true);
    const fayCircles = createCirclesClient({ fetchFn: fay.fetchFn });
    expect((await fayCircles.acceptInvitation((await fayCircles.myInvitations()).value.items[0].id)).ok).toBe(true);

    // eve: Home Send goes to her own brain, with no question
    await send(eve, 'Eve dentist appointment on Friday morning OWN-MARK', lastIs(eve, 'Recorded'));
    expect(thread(eve).map((m) => m.text)).toEqual(['Eve dentist appointment on Friday morning OWN-MARK', 'Recorded against your brain']);
    // the link to the circle is at the top of the navigation, and its screen records against the circle only
    eve.go('#/settings');
    await waitFor(() => navLinks(eve).length === 1, 'the circle link');
    expect(navLinks(eve)).toEqual(['Club']);
    eve.go(`#/circle/${club}`);
    await waitFor(() => circleReady(eve), 'the circle screen');
    expect(eve.page.document.title).toBe('Club – CaCi');
    el(eve, 'circle-update-text').value = 'Club bins go out on Thursday CLUB-MARK';
    el(eve, 'circle-update-form').fire('submit');
    await waitFor(() => cthread(eve).at(-1)?.text === 'Recorded against the circle "Club"', 'the circle filing');
    const eveNotes = createNotesClient({ fetchFn: eve.fetchFn });
    expect((await eveNotes.summaryIn({ kind: 'personal' })).value.itemCount).toBe(1); // only her own dentist note
    expect((await eveNotes.summaryIn({ kind: 'circle', circleId: club })).value.itemCount).toBe(1); // only the club note
    // the Pulse reads only that circle and says where it came from
    el(eve, 'circle-pulse').fire('click');
    await waitFor(() => cthread(eve).at(-1)?.text.includes('read 1 note') === true && circleReady(eve), 'the pulse answer');
    const pulseAnswer = cthread(eve).at(-1);
    expect(pulseAnswer.lines.join('\n')).toContain('CLUB-MARK');
    expect(pulseAnswer.lines.join('\n')).not.toContain('OWN-MARK');
    expect(pulseAnswer.lines.join('\n')).toContain('From: "Club"');

    // the observer: the link, no way to add, a working Pulse
    fay.go(`#/circle/${club}`);
    await waitFor(() => circleReady(fay), 'the observer\'s circle screen');
    expect(navLinks(fay)).toEqual(['Club']);
    expect(el(fay, 'circle-update-text').disabled).toBe(true);
    expect(el(fay, 'circle-update-send').disabled).toBe(true);
    expect(el(fay, 'circle-readonly').hidden).toBe(false);
    el(fay, 'circle-pulse').fire('click');
    await waitFor(() => cthread(fay).at(-1)?.text.includes('read 1 note') === true && circleReady(fay), 'the observer\'s pulse');
    expect(cthread(fay).at(-1).lines.join('\n')).toContain('CLUB-MARK');

    // a stranger is sent Home with the one set of words, and the service says the same
    dan.go(`#/circle/${club}`);
    await waitFor(() => !el(dan, 'circle-notice').hidden, 'the stranger\'s notice');
    expect(el(dan, 'circle-notice').textContent).toBe('No such circle, or you are not in it.');
    expect(navLinks(dan)).toEqual([]);
    expect(dan.page.document.title).toBe('CaCi');
    const stranger = await createNotesClient({ fetchFn: dan.fetchFn }).pulse({ kind: 'circle', circleId: club });
    expect(stranger.error).toMatchObject({ kind: 'not-found', what: 'circle' });

    // a member who is removed loses the link and the screen on the next screen change
    const members = (await eveCircles.listMembers(club)).value.items;
    const fayId = members.find((m) => m.username === 'fay').userId;
    expect((await eveCircles.removeMember(club, fayId)).ok).toBe(true);
    fay.go('#/settings');
    await waitFor(() => navLinks(fay).length === 0, 'the link to disappear');
    fay.go(`#/circle/${club}`);
    await waitFor(() => !el(fay, 'circle-notice').hidden, 'the removed member\'s notice');
    expect(el(fay, 'circle-notice').textContent).toBe('No such circle, or you are not in it.');
    expect(fay.page.document.title).toBe('CaCi');
  });

  it('tracing a fact: a member changes a dose in the circle, the owner asks on Home, and Show the source names who, when and the exact words; a fact whose words are gone says so; a stranger gets nothing', async () => {
    await boot();
    const eve = browser();
    await register(eve, 'eve', 'Eve');
    const eveCircles = createCirclesClient({ fetchFn: eve.fetchFn });
    const club = (await eveCircles.createCircle({ name: 'Club' })).value.id;
    const fay = browser();
    await register(fay, 'fay', 'Fay F');
    const dan = browser();
    await register(dan, 'dan', 'Dan');
    expect((await eveCircles.invite(club, { username: 'fay', role: 'member' })).ok).toBe(true);
    const fayCircles = createCirclesClient({ fetchFn: fay.fetchFn });
    expect((await fayCircles.acceptInvitation((await fayCircles.myInvitations()).value.items[0].id)).ok).toBe(true);

    // fay records the dose and then changes it, on the circle's screen
    fay.go(`#/circle/${club}`);
    await waitFor(() => circleReady(fay), 'the circle screen');
    for (const words of ['Mum: tablets are Tablet A, 2 x daily.', 'Mum: tablets are now Tablet B, 1 x daily <b>after food</b>.']) {
      const before = cthread(fay).length;
      el(fay, 'circle-update-text').value = words;
      el(fay, 'circle-update-form').fire('submit');
      await waitFor(() => cthread(fay).length === before + 2 && cthread(fay).at(-1)?.text.startsWith('Recorded') && circleReady(fay), 'the filing');
    }

    // eve asks on Home: the answer names the new dose, and a button traces it
    await askQ(eve, 'What tablets is Mum on?');
    const answer = thread(eve).at(-1);
    const line = answer.lines.findIndex((l) => l.includes('Tablet B'));
    expect(line).toBeGreaterThanOrEqual(0);
    expect(answer.lines.join(' ')).not.toContain('Tablet A');
    const buttonOf = (index) => el(eve, 'chat-thread').children.at(-1).querySelector('[data-slot="lines"]').children[index].querySelector('[data-slot="source"]');
    expect(buttonOf(line).hidden).toBe(false);
    buttonOf(line).fire('click');
    await waitFor(() => el(eve, 'chat-thread').children.at(-1)?.getAttribute('tabindex') === '-1', 'the source message');
    const shown = thread(eve).at(-1);
    expect(shown.lines.join('\n')).toMatch(/^Entered by Fay F on \d{4}-\d\d-\d\d \d\d:\d\d UTC: "Mum: tablets are now Tablet B, 1 x daily <b>after food<\/b>\."$/);
    expect(eve.page.focused()).toBe(el(eve, 'chat-thread').children.at(-1));

    // the fact it replaced can still be traced, and says it was replaced
    const ledger = createLedgerClient({ fetchFn: eve.fetchFn });
    const removed = (await ledger.list({ kind: 'circle', circleId: club })).value.items.find((e) => e.action === 'removed' && e.kind === 'item');
    const old = (await ledger.source({ kind: 'circle', circleId: club }, removed.subject)).value;
    expect(old).toMatchObject({ current: false, replacedLater: true, recorded: true, words: 'Mum: tablets are Tablet A, 2 x daily.' });
    expect(old.enteredBy.username).toBe('fay');

    // a fact whose words are gone says so plainly (who and when remain)
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir, 'users.db'));
    db.prepare("DELETE FROM ledger WHERE kind = 'input'").run();
    db.close();
    await askQ(eve, 'What tablets is Mum on?');
    const again = thread(eve).at(-1);
    const idx = again.lines.findIndex((l) => l.includes('Tablet B'));
    el(eve, 'chat-thread').children.at(-1).querySelector('[data-slot="lines"]').children[idx].querySelector('[data-slot="source"]').fire('click');
    await waitFor(() => el(eve, 'chat-thread').children.at(-1)?.getAttribute('tabindex') === '-1', 'the second source message');
    const gone = thread(eve).at(-1).lines.join('\n');
    expect(gone).toMatch(/^Entered by Fay F on /);
    expect(gone).toContain('not kept');
    expect(gone).not.toContain('Tablet B, 1 x daily');

    // a stranger cannot trace anything in the circle, and an id from another brain is not found
    const strangerLedger = createLedgerClient({ fetchFn: dan.fetchFn });
    expect((await strangerLedger.source({ kind: 'circle', circleId: club }, removed.subject)).error).toMatchObject({ kind: 'not-found', what: 'circle' });
    expect((await ledger.source({ kind: 'personal' }, removed.subject)).error).toMatchObject({ kind: 'not-found', what: 'item' });
  });
});
