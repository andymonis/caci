import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startService } from '../src/service/service.ts';
import { createCirclesClient } from './circles-client.js';
import { fakePage, fill, waitFor } from './fake-page.test-util.mjs';
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
  service = await startService({ port: 0, bind: '127.0.0.1', dataDir: dir, allowRegistration: true, cookieSecure: false, trustedProxies: 1, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, maxBrainScopes: 25, statusPerHour: 20, sessionIdleDays: 7, sessionDays: 30, agentAccess: false, joinLinks: false });
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
const signedIn = (b) => !el(b, 'screen-signed-in').hidden;
const idle = (b) => signedIn(b) && !el(b, 'update-send').disabled;

async function register(b, username, displayName) {
  await waitFor(() => !el(b, 'screen-signed-out').hidden, 'the sign-in form');
  el(b, 'show-register').fire('click');
  fill(b.page, 'register', { username, displayName, email: '', password: PW });
  el(b, 'register-form').fire('submit');
  await waitFor(() => idle(b), 'Home after registering');
}
const cthread = (b) => el(b, 'circle-thread').children.map((row) => ({ cls: row.getAttribute('class'), text: row.querySelector('[data-slot="text"]').textContent, lines: row.querySelector('[data-slot="lines"]').children.map((l) => l.querySelector('[data-slot="text"]').textContent) }));
const circleReady = (b) => !el(b, 'view-circle').hidden && el(b, 'circle-heading').textContent !== '' && b.page.document.title === `${el(b, 'circle-heading').textContent} – CaCi` && !el(b, 'circle-pulse').disabled;

describe('verbs and resolving a fact, through the pages, against the real service (R-025 VR-AC-12)', () => {
  const lineViews = (b) => el(b, 'circle-thread').children.flatMap((row) => row.querySelector('[data-slot="lines"]').children).map((l) => ({
    num: l.querySelector('[data-slot="number"]').hidden ? '' : l.querySelector('[data-slot="number"]').textContent,
    text: l.querySelector('[data-slot="text"]').textContent,
    buttons: l.querySelector('[data-slot="verbs"]').hidden ? [] : l.querySelector('[data-slot="verbs"]').children,
    done: l.querySelector('[data-slot="verbs"]').textContent === 'Done',
  }));
  const idleCircle = (b) => !el(b, 'circle-pulse').disabled && !el(b, 'view-circle').hidden;
  const pulse = async (b) => {
    const before = cthread(b).length;
    el(b, 'circle-pulse').fire('click');
    await waitFor(() => idleCircle(b) && cthread(b).length >= before + 2 && cthread(b).at(-1).cls.startsWith('msg cacci'), 'the pulse answer');
  };
  const open = async (b, circle) => {
    b.go(`#/circle/${circle}`);
    await waitFor(() => circleReady(b), 'the circle screen');
  };

  it('a member pays this week from the Pulse, it leaves their view only, the owner removes it for everyone, next week appears fresh', async () => {
    await boot();
    const eve = browser();
    await register(eve, 'eve', 'Eve');
    const fay = browser();
    await register(fay, 'fay', 'Fay');
    const gus = browser();
    await register(gus, 'gus', 'Gus');
    const circles = createCirclesClient({ fetchFn: eve.fetchFn });
    const club = (await circles.createCircle({ name: 'Yoga' })).value.id;
    for (const [who, name, role] of [[fay, 'fay', 'member'], [gus, 'gus', 'observer']]) {
      expect((await circles.invite(club, { username: name, role })).ok).toBe(true);
      const theirs = createCirclesClient({ fetchFn: who.fetchFn });
      expect((await theirs.acceptInvitation((await theirs.myInvitations()).value.items[0].id)).ok).toBe(true);
    }
    const eveNotes = createNotesClient({ fetchFn: eve.fetchFn });
    const post = async (text) => {
      const made = await eveNotes.propose(text, { kind: 'circle', circleId: club });
      expect((await eveNotes.approve(made.value.id)).ok).toBe(true);
    };
    await post('Pay for this week yoga class by Friday YOGA-ONE');

    // fay: the Pulse numbers the point and offers clear and pay, not remove
    await open(fay, club);
    await pulse(fay);
    let views = lineViews(fay);
    expect(views).toHaveLength(1);
    expect(views[0].num).toBe('1.');
    expect(views[0].text).toContain('YOGA-ONE');
    expect(views[0].buttons.map((x) => x.textContent)).toEqual(['clear', 'pay']);
    // ... and pays it by the button
    views[0].buttons[1].fire('click');
    await waitFor(() => idleCircle(fay) && (cthread(fay).at(-1)?.text ?? '').startsWith('Mark this as paid: done for point 1'), 'the thread to say it was done');
    expect(lineViews(fay)[0].done).toBe(true);
    // the next Pulse leaves it out for fay
    await pulse(fay);
    expect(cthread(fay).at(-1).text + cthread(fay).at(-1).lines.join()).not.toContain('YOGA-ONE');

    // gus (an observer) still sees it, and may deal with it for himself
    await open(gus, club);
    await pulse(gus);
    views = lineViews(gus);
    expect(views[0].text).toContain('YOGA-ONE');
    expect(views[0].buttons.map((x) => x.textContent)).toEqual(['clear', 'pay']);

    // eve, the owner, is offered remove as well
    await open(eve, club);
    await pulse(eve);
    views = lineViews(eve);
    expect(views[0].buttons.map((x) => x.textContent)).toEqual(['clear', 'pay', 'remove']);

    // next week's request is a new fact and appears fresh for fay, while last week's stays cleared for her
    await post('Pay for next week yoga class by Friday YOGA-TWO');
    await pulse(fay);
    const fresh = cthread(fay).at(-1).lines.join('\n');
    expect(fresh).toContain('YOGA-TWO');
    expect(fresh).not.toContain('YOGA-ONE');

    // fay types /clear 1 in the update box: it is a command, not a note
    el(fay, 'circle-update-text').value = '/clear 1';
    el(fay, 'circle-update-form').fire('submit');
    await waitFor(() => idleCircle(fay) && (cthread(fay).at(-1)?.text ?? '').includes('done for point 1'), 'the typed command to be done');
    expect(cthread(fay).some((m) => m.text === 'Recorded against the circle "Yoga"')).toBe(false);

    // eve removes the first request for everyone: gus no longer sees it
    await pulse(eve);
    const viewsEve = lineViews(eve);
    const yogaOne = viewsEve.find((v) => v.text.includes('YOGA-ONE'));
    expect(yogaOne.buttons.map((x) => x.textContent)).toContain('remove');
    yogaOne.buttons.find((x) => x.textContent === 'remove').fire('click');
    await waitFor(() => idleCircle(eve) && (cthread(eve).at(-1)?.text ?? '').startsWith('Remove this fact for everyone: done'), 'the removal');
    await pulse(gus);
    expect(cthread(gus).at(-1).lines.join('\n')).not.toContain('YOGA-ONE');
    expect(cthread(gus).at(-1).lines.join('\n')).toContain('YOGA-TWO');
  });

  it('an outsider who holds a reference gets the made-up-circle answer, and a mistyped verb files nothing', async () => {
    await boot();
    const eve = browser();
    await register(eve, 'eve', 'Eve');
    const dan = browser();
    await register(dan, 'dan', 'Dan');
    const club = (await createCirclesClient({ fetchFn: eve.fetchFn }).createCircle({ name: 'Yoga' })).value.id;
    const eveNotes = createNotesClient({ fetchFn: eve.fetchFn });
    const made = await eveNotes.propose('Pay for this week yoga class by Friday YOGA-ONE', { kind: 'circle', circleId: club });
    expect((await eveNotes.approve(made.value.id)).ok).toBe(true);
    const factId = made.value.summary.newItems[0];
    const { createFactsClient } = await import('./facts-client.js');
    const stray = await createFactsClient({ fetchFn: dan.fetchFn }).resolve({ scope: { kind: 'circle', circleId: club }, id: factId }, 'pay');
    const madeUp = await createFactsClient({ fetchFn: dan.fetchFn }).resolve({ scope: { kind: 'circle', circleId: 'c0000000000000000' }, id: factId }, 'pay');
    expect(stray).toEqual(madeUp);
    expect(stray.error).toMatchObject({ kind: 'not-found', what: 'circle' });

    await open(eve, club);
    el(eve, 'circle-update-text').value = '/dance 1';
    el(eve, 'circle-update-form').fire('submit');
    await waitFor(() => idleCircle(eve) && (cthread(eve).at(-1)?.text ?? '').startsWith('There is no verb "dance"'), 'the answer to a mistyped verb');
    expect(cthread(eve).map((m) => m.text)).toEqual(['/dance 1', 'There is no verb "dance". The verbs are: /clear, /pay, /remove.']);
  });
});
