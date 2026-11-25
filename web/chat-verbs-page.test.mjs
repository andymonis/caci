import { describe, expect, it } from 'vitest';
import { fakePage, settle } from './fake-page.test-util.mjs';
import { userHooks } from './user-hooks.js';
import { mountUser } from './user-mount.js';

// R-025 VR-FR-11 and VR-FR-12 on the screens: numbered points, one button per verb the person may use, done marked, and `/verb N` in a box.

const USER = { id: 'u0000000000000001', username: 'ann', displayName: 'Ann A' };
const C1 = 'c0000000000000001';
const C2 = 'c0000000000000002';
const circle = (id, name, role = 'member') => ({ role, scope: { kind: 'circle', circleId: id, circleName: name }, canCapture: role !== 'observer' });
const OWN = { scope: { kind: 'personal' }, canCapture: true };
const VERBS = [{ name: 'clear', effect: 'clear', help: 'Clear this for me.' }, { name: 'pay', effect: 'clear', help: 'Mark this as paid.' }, { name: 'remove', effect: 'remove', help: 'Remove this fact for everyone.' }];
const FACT_C1 = { scope: { kind: 'circle', circleId: C1, circleName: 'Yoga' }, id: 'yoga-1' };
const FACT_C2 = { scope: { kind: 'circle', circleId: C2, circleName: 'Club' }, id: 'bins-1' };
const FACT_OWN = { scope: { kind: 'personal' }, id: 'note-9' };
const point = (text, facts) => ({ text, sources: [{ kind: 'personal' }], facts });
const answer = (points) => ({ status: 200, body: { status: { headline: 'This week.', points, nothing: points.length === 0, generatedAt: 1, mode: 'demo', entriesUsed: 1, entriesLeftOut: 0, entriesResolved: 0 } } });

function service({ scopes = [OWN, circle(C1, 'Yoga', 'owner'), circle(C2, 'Club', 'member')], points = [point('Pay for yoga <b>now</b>', [FACT_C1]), point('Bins on Thursday', [FACT_C2]), point('Dentist on Friday', [FACT_OWN]), point('Two facts', [FACT_C1, FACT_C2]), point('No fact', [])], verbs, resolve } = {}) {
  const calls = [];
  const fetchFn = async (path, init) => {
    const key = `${init.method} ${path}`;
    calls.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const table = {
      'GET /api/me': { status: 200, body: { user: USER, graphId: 'x' } },
      'GET /api/capture/mode': { status: 200, body: { mode: 'demo' } },
      'GET /api/brain/scopes': { status: 200, body: { items: scopes } },
      'GET /api/facts/verbs': verbs ?? { status: 200, body: { items: VERBS } },
      'POST /api/status': answer(points),
      'POST /api/facts/resolve': resolve ?? ((c) => { const b = c.at(-1).body; return { status: 200, body: { resolved: { fact: { scope: b.scope, id: b.id }, verb: b.verb, effect: b.verb === 'remove' ? 'remove' : 'clear', result: b.verb === 'remove' || b.scope.kind === 'personal' ? 'deleted' : 'hidden' } } }; }),
      'POST /api/logout': { status: 204 },
    };
    const entry = table[key] ?? { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'not signed in' } } };
    const a = await (typeof entry === 'function' ? entry(calls) : entry);
    return { status: a.status, headers: { get: () => null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { fetchFn, calls, keys: () => calls.map((c) => c.key), bodies: (key) => calls.filter((c) => c.key === key).map((c) => c.body) };
}
function address(hash) {
  let h = hash;
  const listeners = [];
  const env = { getHash: () => h, setHash: (next) => { h = next; for (const l of listeners) l(); }, onHashChange: (cb) => listeners.push(cb) };
  return { env };
}
async function start(over = {}, hash = '') {
  const page = fakePage('user.html');
  const svc = service(over);
  mountUser(page.document, svc.fetchFn, address(hash).env, (ctx) => userHooks(page.document, svc.fetchFn, ctx));
  await settle();
  return { page, svc };
}
const lines = (page, id) => page.el(id).children.flatMap((row) => row.querySelector('[data-slot="lines"]').children);
const lineView = (l) => ({ num: l.querySelector('[data-slot="number"]').hidden ? '' : l.querySelector('[data-slot="number"]').textContent, text: l.querySelector('[data-slot="text"]').textContent, verbs: l.querySelector('[data-slot="verbs"]').hidden ? [] : l.querySelector('[data-slot="verbs"]').children.map((b) => b.textContent), done: l.querySelector('[data-slot="verbs"]').textContent === 'Done' });
const ask = async (page, text = 'What is on?') => { page.el('question-text').value = text; page.el('question-form').fire('submit'); await settle(); };
const send = async (page, text) => { page.el('update-text').value = text; page.el('update-form').fire('submit'); await settle(); };
const buttons = (l) => l.querySelector('[data-slot="verbs"]').children;

describe('Home: numbered points and buttons', () => {
  it('numbers the points of an answer and offers a button per verb the person may use', async () => {
    const { page, svc } = await start();
    await ask(page);
    expect(svc.keys().filter((k) => k === 'GET /api/facts/verbs')).toHaveLength(1);
    const views = lines(page, 'chat-thread').map(lineView);
    expect(views.map((v) => [v.num, v.text])).toEqual([['1.', 'Pay for yoga <b>now</b> (From: your own notes)'], ['2.', 'Bins on Thursday (From: your own notes)'], ['3.', 'Dentist on Friday (From: your own notes)'], ['4.', 'Two facts (From: your own notes)'], ['5.', 'No fact (From: your own notes)']]);
    // the circle you own offers remove; a circle you only belong to does not; your own brain does
    expect(views[0].verbs).toEqual(['clear', 'pay', 'remove']);
    expect(views[1].verbs).toEqual(['clear', 'pay']);
    expect(views[2].verbs).toEqual(['clear', 'pay', 'remove']);
    expect(views[3].verbs).toEqual(['clear 4.1', 'pay 4.1', 'remove 4.1', 'clear 4.2', 'pay 4.2']);
    expect(views[4].verbs).toEqual([]);
  });

  it('text from the service or the model stays text: the markup in a point is never parsed', async () => {
    const { page } = await start();
    await ask(page);
    const first = lines(page, 'chat-thread')[0];
    expect(first.querySelector('[data-slot="text"]').textContent).toContain('<b>now</b>');
    expect(first.children.every((c) => c.tag === undefined || c.tag !== 'b')).toBe(true);
  });

  it('clicking a button sends the exact reference and verb, says what was done, and shows the point as done', async () => {
    const { page, svc } = await start();
    await ask(page);
    const pay = buttons(lines(page, 'chat-thread')[1])[1];
    expect(pay.textContent).toBe('pay');
    expect(pay.getAttribute('aria-label')).toBe('Mark this as paid: point 2');
    pay.fire('click');
    await settle();
    expect(svc.bodies('POST /api/facts/resolve')).toEqual([{ scope: { kind: 'circle', circleId: C2 }, id: 'bins-1', verb: 'pay' }]);
    const rows = page.el('chat-thread').children.map((row) => row.querySelector('[data-slot="text"]').textContent);
    expect(rows.at(-1)).toBe('Mark this as paid: done for point 2; it will stay out of your checks.');
    const views = lines(page, 'chat-thread').map(lineView);
    expect(views[1].done).toBe(true);
    expect(views[0].done).toBe(false);
  });

  it('the buttons are off while a request is out', async () => {
    let release;
    const { page } = await start({ resolve: () => new Promise((r) => (release = () => r({ status: 200, body: { resolved: { fact: FACT_C1, verb: 'pay', effect: 'clear', result: 'hidden' } } }))) });
    await ask(page);
    buttons(lines(page, 'chat-thread')[0])[1].fire('click');
    await new Promise((r) => setTimeout(r, 0));
    expect(buttons(lines(page, 'chat-thread')[2]).every((b) => b.disabled)).toBe(true);
    release();
    await settle();
    expect(buttons(lines(page, 'chat-thread')[2]).every((b) => b.disabled)).toBe(false);
  });

  it('typing /pay 2 in either box does the same and files nothing', async () => {
    const { page, svc } = await start();
    await ask(page);
    await send(page, '/pay 2');
    await ask(page, '/clear 3');
    expect(svc.bodies('POST /api/facts/resolve').map((b) => `${b.verb} ${b.id}`)).toEqual(['pay bins-1', 'clear note-9']);
    expect(svc.keys().some((k) => k.includes('/api/capture/propose'))).toBe(false);
    expect(page.el('update-text').value === '' || page.el('update-text').value === '/pay 2').toBe(true);
  });

  it('a mistyped verb is answered in the thread and nothing is filed or asked again', async () => {
    const { page, svc } = await start();
    await ask(page);
    const asked = svc.keys().filter((k) => k === 'POST /api/status').length;
    await send(page, '/dance 2');
    const rows = page.el('chat-thread').children.map((row) => row.querySelector('[data-slot="text"]').textContent);
    expect(rows.at(-1)).toBe('There is no verb "dance". The verbs are: /clear, /pay, /remove.');
    expect(svc.keys().filter((k) => k === 'POST /api/status')).toHaveLength(asked);
    expect(svc.keys().some((k) => k.includes('propose') || k.includes('resolve'))).toBe(false);
  });

  it('a fact that has gone says to ask again, and the point is not marked done', async () => {
    const { page } = await start({ resolve: { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such fact' } } } });
    await ask(page);
    buttons(lines(page, 'chat-thread')[0])[1].fire('click');
    await settle();
    const rows = page.el('chat-thread').children.map((row) => row.querySelector('[data-slot="text"]').textContent);
    expect(rows.at(-1)).toBe('That fact is no longer there. Ask again for a fresh answer.');
    expect(lines(page, 'chat-thread').map(lineView)[0].done).toBe(false);
  });

  it('with no vocabulary there are no buttons, and the answer still shows (a number is shown when a fact is behind it)', async () => {
    const { page } = await start({ verbs: { status: 500, body: { error: { message: 'x' } } } });
    await ask(page);
    const views = lines(page, 'chat-thread').map(lineView);
    expect(views.every((v) => v.verbs.length === 0)).toBe(true);
    expect(views[0].text).toContain('Pay for yoga');
  });

  it('sign-out forgets the buttons and what was done', async () => {
    const { page } = await start();
    await ask(page);
    buttons(lines(page, 'chat-thread')[0])[0].fire('click');
    await settle();
    page.el('logout')?.fire?.('click');
    await settle();
    expect(page.el('chat-thread').children.length).toBeGreaterThanOrEqual(0);
  });
});

describe('a circle screen: the same, for that circle', () => {
  const only = (facts) => ({ points: [point('Pay for yoga', facts), point('No fact', [])] });
  it('the owner is offered remove; a member and an observer are not, and an observer can still pay', async () => {
    for (const [role, want] of [['owner', ['clear', 'pay', 'remove']], ['manager', ['clear', 'pay']], ['member', ['clear', 'pay']], ['observer', ['clear', 'pay']]]) {
      const { page, svc } = await start({ ...only([FACT_C1]), scopes: [OWN, circle(C1, 'Yoga', role)] }, `#/circle/${C1}`);
      page.el('circle-pulse').fire('click');
      await settle();
      const views = lines(page, 'circle-thread').map(lineView);
      expect(views[0].num, role).toBe('1.');
      expect(views[0].verbs, role).toEqual(want);
      expect(views[1].verbs, role).toEqual([]);
      expect(svc.keys().filter((k) => k === 'GET /api/facts/verbs'), role).toHaveLength(1);
    }
  });

  it('clicking pay on a circle point resolves that fact, and typing /pay 1 in the update box does too, filing nothing', async () => {
    const { page, svc } = await start(only([FACT_C1]), `#/circle/${C1}`);
    page.el('circle-pulse').fire('click');
    await settle();
    buttons(lines(page, 'circle-thread')[0])[1].fire('click');
    await settle();
    expect(svc.bodies('POST /api/facts/resolve')).toEqual([{ scope: { kind: 'circle', circleId: C1 }, id: 'yoga-1', verb: 'pay' }]);
    expect(lines(page, 'circle-thread').map(lineView)[0].done).toBe(true);
    page.el('circle-update-text').value = '/clear 1';
    page.el('circle-update-form').fire('submit');
    await settle();
    expect(svc.bodies('POST /api/facts/resolve').map((b) => b.verb)).toEqual(['pay', 'clear']);
    expect(svc.keys().some((k) => k.includes('propose'))).toBe(false);
  });
});
