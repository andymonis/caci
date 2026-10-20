import { describe, expect, it } from 'vitest';
import { fakePage, settle } from './fake-page.test-util.mjs';
import { CHAT_MODE_WORDS, CIRCLE_READ_ONLY, CIRCLE_VISIBLE } from './chat-view.js';
import { userHooks } from './user-hooks.js';
import { mountUser } from './user-mount.js';

const USER = { id: 'u0000000000000001', username: 'ann', displayName: 'Ann A' };
const C1 = 'c0000000000000001';
const C2 = 'c0000000000000002';
const circle = (id, name, role = 'member') => ({ role, scope: { kind: 'circle', circleId: id, circleName: name }, canCapture: role !== 'observer' });
const OWN = { scope: { kind: 'personal' }, canCapture: true };
const SUMMARY = { newItems: ['i1'], updatedItems: [], newCategories: [], updatedCategories: [], reusedCategories: [], newLinks: [], problems: [], notes: [], facts: [{ id: 'i1', title: 'Bins', summary: 'Thursday' }], removed: [] };
const proposal = { id: 'prop-aaa-1', createdAt: 1, expiresAt: 2, mode: 'demo', text: 'x', operations: [{ op: 'upsertNode', partition: 'item', id: 'i1' }], summary: SUMMARY };
const answer = (headline, points = []) => ({ status: 200, body: { status: { headline, points, nothing: points.length === 0, generatedAt: 1, mode: 'demo', entriesUsed: 1, entriesLeftOut: 0 } } });
const gate = () => { let release; const promise = new Promise((r) => (release = r)); return { promise, release }; };

function service(over = {}) {
  const calls = [];
  const state = { scopes: [OWN, circle(C1, 'Parent care'), circle(C2, 'Club', 'observer')], table: {} };
  const table = () => ({
    'GET /api/me': { status: 200, body: { user: USER, graphId: 'x' } },
    'GET /api/capture/mode': { status: 200, body: { mode: 'demo' } },
    'POST /api/capture/propose': { status: 201, body: { proposal } },
    'POST /api/capture/proposals/prop-aaa-1/approve': { status: 200, body: { written: { id: 'prop-aaa-1', applied: 3, summary: SUMMARY } } },
    'POST /api/capture/proposals/prop-aaa-1/reject': { status: 204 },
    'POST /api/status': answer('The circle is quiet.', [{ text: 'Bins on Thursday', sources: [{ kind: 'circle', circleId: C1, circleName: 'Parent care' }] }]),
    'POST /api/logout': { status: 204 },
    ...over,
    ...state.table,
  });
  const fetchFn = async (path, init) => {
    const key = `${init.method} ${path}`;
    calls.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    let entry = table()[key];
    if (key === 'GET /api/brain/scopes') entry = { status: 200, body: { items: state.scopes } };
    entry ??= { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'not signed in' } } };
    const a = await (typeof entry === 'function' ? entry(calls) : entry);
    return { status: a.status, headers: { get: () => null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { fetchFn, calls, state, keys: () => calls.map((c) => c.key), bodies: (key) => calls.filter((c) => c.key === key).map((c) => c.body) };
}
function address(initial = '') {
  let hash = initial;
  const listeners = [];
  const env = { getHash: () => hash, setHash: (h) => { hash = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  return { env, get: () => hash, go: (h) => env.setHash(h) };
}
async function start(over = {}, hash = `#/circle/${C1}`) {
  const page = fakePage('user.html');
  const svc = service(over);
  const addr = address(hash);
  mountUser(page.document, svc.fetchFn, addr.env, (ctx) => userHooks(page.document, svc.fetchFn, ctx));
  await settle();
  return { page, svc, addr };
}
const thread = (page) => page.el('circle-thread').children.map((row) => ({ cls: row.getAttribute('class'), text: row.querySelector('[data-slot="text"]').textContent, lines: row.querySelector('[data-slot="lines"]').children.map((l) => l.querySelector('[data-slot="text"]').textContent) }));
const send = async (page, text) => { page.el('circle-update-text').value = text; page.el('circle-update-form').fire('submit'); await settle(); };
const pulse = async (page) => { page.el('circle-pulse').fire('click'); await settle(); };

describe('a circle screen\'s chat', () => {
  it('shows which model answers and who can read it before anything is sent, with no question field', async () => {
    const { page, svc } = await start();
    expect(page.el('circle-model-notice').textContent).toBe(CHAT_MODE_WORDS.demo);
    expect(page.el('circle-visible').textContent).toBe(CIRCLE_VISIBLE);
    expect(page.el('circle-readonly').hidden).toBe(true);
    expect(page.el('circle-update-send').disabled).toBe(false);
    expect(page.el('circle-pulse').disabled).toBe(false);
    expect(svc.keys().filter((k) => k === 'GET /api/capture/mode')).toHaveLength(1);
    expect(svc.keys().filter((k) => k.startsWith('POST'))).toEqual([]);
    expect(page.ids.filter((id) => id.startsWith('circle-') && id.includes('question'))).toEqual([]);
  });

  it('Send records against this circle (kind and id only), says so by name, lists the facts, clears the box and keeps the focus there', async () => {
    const { page, svc } = await start();
    await send(page, 'Bins go out on Thursday');
    expect(svc.bodies('POST /api/capture/propose')).toEqual([{ text: 'Bins go out on Thursday', scope: { kind: 'circle', circleId: C1 } }]);
    expect(svc.keys().filter((k) => k.includes('/approve'))).toHaveLength(1);
    expect(thread(page).map((m) => [m.cls, m.text])).toEqual([['msg me', 'Bins go out on Thursday'], ['msg cacci', 'Recorded against the circle "Parent care"']]);
    expect(thread(page)[1].lines).toEqual(['Bins: Thursday']);
    expect(page.el('circle-update-text').value).toBe('');
    expect(page.focused().id).toBe('circle-update-text');
  });

  it('the Pulse sends only the circle (never words), shows a Pulse message and the answer with its sources', async () => {
    const { page, svc } = await start();
    await pulse(page);
    const body = svc.bodies('POST /api/status')[0];
    expect(Object.keys(body).sort()).toEqual(expect.arrayContaining(['pulse', 'scope']));
    expect(body.pulse).toBe(true);
    expect(body.scope).toEqual({ kind: 'circle', circleId: C1 });
    expect(body.text).toBeUndefined();
    expect(thread(page).map((m) => [m.cls, m.text])).toEqual([['msg me', 'Pulse'], ['msg cacci', 'The circle is quiet.']]);
    expect(thread(page)[1].lines).toEqual(['Bins on Thursday (From: "Parent care")']);
    expect(svc.keys().filter((k) => k.includes('/propose'))).toEqual([]);
  });

  it('an observer reads: the update box and Send are disabled with the reason, the Pulse works, and nothing can be sent', async () => {
    const { page, svc } = await start({}, `#/circle/${C2}`);
    expect(page.el('circle-readonly').textContent).toBe(CIRCLE_READ_ONLY);
    expect(page.el('circle-readonly').hidden).toBe(false);
    expect(page.el('circle-update-text').disabled).toBe(true);
    expect(page.el('circle-update-send').disabled).toBe(true);
    expect(page.el('circle-pulse').disabled).toBe(false);
    await send(page, 'let me in');
    expect(svc.keys().filter((k) => k.includes('/propose'))).toEqual([]);
    await pulse(page);
    expect(thread(page).at(-1).text).toBe('The circle is quiet.');
  });

  it('an empty update is refused beside the box and sends nothing', async () => {
    const { page, svc } = await start();
    await send(page, '   ');
    expect(page.el('circle-update-error').hidden).toBe(false);
    expect(page.focused().id).toBe('circle-update-text');
    expect(svc.keys().filter((k) => k.startsWith('POST'))).toEqual([]);
    await send(page, 'ok');
    expect(page.el('circle-update-error').hidden).toBe(true);
  });

  it('each circle has its own thread, kept while moving between screens, and forgotten on sign-out', async () => {
    const { page, addr } = await start();
    await send(page, 'First circle note');
    addr.go(`#/circle/${C2}`);
    await settle();
    expect(thread(page)).toEqual([]);
    await pulse(page);
    expect(thread(page).map((m) => m.text)).toEqual(['Pulse', 'The circle is quiet.']);
    addr.go('#/');
    await settle();
    addr.go(`#/circle/${C1}`);
    await settle();
    expect(thread(page).map((m) => m.text)).toEqual(['First circle note', 'Recorded against the circle "Parent care"']);
    page.el('signout').fire('click');
    await settle();
    expect(thread(page)).toEqual([]);
    expect(page.el('circle-update-text').value).toBe('');
  });

  it('asks which model answers once, says it is not known when it cannot be read, and Try again asks again', async () => {
    let n = 0;
    const { page, svc } = await start({ 'GET /api/capture/mode': () => (++n === 1 ? { status: 500, body: { error: { code: 'STORAGE_ERROR', message: 'x' } } } : { status: 200, body: { mode: 'demo' } }) });
    expect(page.el('circle-retry').hidden).toBe(false);
    expect(page.el('circle-mode-error').hidden).toBe(false);
    expect(page.el('circle-update-send').disabled).toBe(true);
    expect(page.el('circle-pulse').disabled).toBe(true);
    expect(page.el('circle-model-notice').textContent).toContain('Could not tell');
    page.el('circle-retry').fire('click');
    await settle();
    expect(page.el('circle-retry').hidden).toBe(true);
    expect(page.el('circle-pulse').disabled).toBe(false);
    expect(svc.keys().filter((k) => k === 'GET /api/capture/mode')).toHaveLength(2);
  });

  it('controls are disabled while a request is out, and a second press sends nothing', async () => {
    const g = gate();
    const { page, svc } = await start({ 'POST /api/status': () => g.promise });
    page.el('circle-pulse').fire('click');
    await settle();
    expect(page.el('circle-pulse').disabled).toBe(true);
    expect(page.el('circle-update-send').disabled).toBe(true);
    expect(page.el('circle-update-form').getAttribute('aria-busy')).toBe('true');
    page.el('circle-pulse').fire('click');
    await settle();
    expect(svc.keys().filter((k) => k === 'POST /api/status')).toHaveLength(1);
    g.release(answer('Done.'));
    await settle();
    expect(page.el('circle-pulse').disabled).toBe(false);
  });

  it('a limit, a refusal and a missing circle are said in the thread in words', async () => {
    const limited = await start({ 'POST /api/status': { status: 429, body: { error: { code: 'THROTTLED', message: 'Too many statuses' } } } });
    await pulse(limited.page);
    expect(thread(limited.page).at(-1).cls).toBe('msg cacci problem');
    const gone = await start({ 'POST /api/capture/propose': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such circle' } } } });
    await send(gone.page, 'x');
    expect(thread(gone.page).at(-1).text).toBe('Not recorded: No such circle, or you are not in it.');
  });

  it('hostile text, from the person or the model, is only text', async () => {
    const evil = '<img src=x onerror=alert(1)><script>x</script>';
    const { page } = await start({ 'POST /api/status': answer(evil, [{ text: evil, sources: [{ kind: 'circle', circleId: C1, circleName: evil }] }]) });
    await send(page, evil);
    await pulse(page);
    const t = thread(page);
    expect(t[0].text).toBe(evil);
    expect(t.at(-1).text).toBe(evil);
    expect(t.at(-1).lines[0]).toContain(evil);
    for (const row of page.el('circle-thread').children) expect(row.children.map((c) => c.tagName)).toEqual(['p', 'ul']);
  });

  it('a changed right starts a fresh thread so the buttons follow the service', async () => {
    const { page, svc, addr } = await start();
    await send(page, 'a note');
    svc.state.scopes = [OWN, circle(C1, 'Parent care', 'observer'), circle(C2, 'Club', 'observer')];
    addr.go('#/settings');
    await settle();
    addr.go(`#/circle/${C1}`);
    await settle();
    expect(page.el('circle-update-send').disabled).toBe(true);
    expect(page.el('circle-readonly').hidden).toBe(false);
    expect(thread(page)).toEqual([]);
  });

  it('an answer that arrives after leaving the screen is there when the person comes back', async () => {
    const g = gate();
    const { page, addr } = await start({ 'POST /api/status': () => g.promise });
    page.el('circle-pulse').fire('click');
    await settle();
    addr.go('#/');
    await settle();
    g.release(answer('Late but here.'));
    await settle();
    addr.go(`#/circle/${C1}`);
    await settle();
    expect(thread(page).map((m) => m.text)).toEqual(['Pulse', 'Late but here.']);
  });

  it('a pulse that finds the session ended re-checks once and sends no loop', async () => {
    let me = 0;
    const { page } = await start({ 'GET /api/me': () => (++me, { status: 200, body: { user: USER, graphId: 'x' } }), 'POST /api/status': { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'not signed in' } } } });
    await pulse(page);
    await pulse(page);
    expect(me).toBe(2);
  });

  it('a renamed circle starts a fresh thread so the words follow the service', async () => {
    const { page, svc, addr } = await start();
    await send(page, 'a note');
    svc.state.scopes = [OWN, circle(C1, 'Parents', 'member'), circle(C2, 'Club', 'observer')];
    addr.go('#/settings');
    await settle();
    addr.go(`#/circle/${C1}`);
    await settle();
    expect(thread(page)).toEqual([]);
    await send(page, 'another');
    expect(thread(page).at(-1).text).toBe('Recorded against the circle "Parents"');
  });

  it('pressing the Pulse clears an old problem beside the box', async () => {
    const { page } = await start();
    await send(page, '  ');
    expect(page.el('circle-update-error').hidden).toBe(false);
    await pulse(page);
    expect(page.el('circle-update-error').hidden).toBe(true);
  });

  it('a late answer for one circle never shows on another circle\'s screen', async () => {
    const g = gate();
    const { page, addr } = await start({ 'POST /api/status': () => g.promise });
    page.el('circle-pulse').fire('click');
    await settle();
    addr.go(`#/circle/${C2}`);
    await settle();
    g.release(answer('From the first circle.'));
    await settle();
    expect(thread(page)).toEqual([]);
    expect(JSON.stringify(thread(page))).not.toContain('first circle');
  });

  it('signing out forgets every thread, even for the next person on the same page, and drops an answer still on its way', async () => {
    let me = 0;
    const g = gate();
    const { page, svc, addr } = await start({ 'GET /api/me': () => (++me, { status: 200, body: { user: USER, graphId: 'x' } }), 'POST /api/login': { status: 200, body: { user: USER, graphId: 'x' } }, 'POST /api/status': () => g.promise });
    await send(page, 'private note for ann');
    page.el('circle-update-text').value = 'a draft';
    page.el('circle-pulse').fire('click');
    await settle();
    page.el('signout').fire('click');
    await settle();
    expect(page.el('circle-update-text').value).toBe('');
    g.release({ status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'not signed in' } } });
    await settle();
    expect(me).toBe(1); // the dropped answer did not make the page ask who is signed in again
    // the next person signs in on the same page, still at the same address: nothing of the earlier thread is there
    page.el('signin-username').value = 'ann';
    page.el('signin-password').value = 'correct horse 7 staple';
    page.el('signin-form').fire('submit');
    await settle();
    expect(addr.get()).toBe(`#/circle/${C1}`);
    expect(page.el('view-circle').hidden).toBe(false);
    expect(thread(page)).toEqual([]);
    expect(svc.keys()).toContain('POST /api/login');
  });
});
