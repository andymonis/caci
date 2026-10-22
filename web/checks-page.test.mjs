import { describe, expect, it } from 'vitest';
import { fakePage, settle } from './fake-page.test-util.mjs';
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


const homeThread = (page) => page.el('chat-thread').children.map((row) => ({ cls: row.getAttribute('class'), text: row.querySelector('[data-slot="text"]').textContent, lines: row.querySelector('[data-slot="lines"]').children.map((l) => l.querySelector('[data-slot="text"]').textContent) }));
const circleThread = (page) => page.el('circle-thread').children.map((row) => ({ cls: row.getAttribute('class'), text: row.querySelector('[data-slot="text"]').textContent, lines: row.querySelector('[data-slot="lines"]').children.map((l) => l.querySelector('[data-slot="text"]').textContent) }));
const click = async (page, id) => { page.el(id).fire('click'); await settle(); };
const checkBody = (svc) => svc.bodies('POST /api/status');
const answerWith = (headline, points = [], nothing = points.length === 0) => ({ status: 200, body: { status: { headline, points, nothing, generatedAt: 1, mode: 'demo', entriesUsed: 1, entriesLeftOut: 0 } } });
const ONE = answerWith('One thing needs you this week.', [{ text: 'Dentist tomorrow at 9:15.', sources: [{ kind: 'personal' }] }]);
const SILENT = answerWith('Nothing needs your attention this week.');

describe('the three checks on Home (R-018 D12)', () => {
  it('are three buttons beside the boxes, and each sends only its check (no words, no scope, no old pulse flag)', async () => {
    const { page, svc } = await start({ 'POST /api/status': ONE }, '#/');
    for (const id of ['check-pulse', 'check-coming-up', 'check-long-range']) expect(page.el(id).disabled, id).toBe(false);
    await click(page, 'check-pulse');
    await click(page, 'check-coming-up');
    await click(page, 'check-long-range');
    const bodies = checkBody(svc);
    expect(bodies.map((b) => b.check)).toEqual(['pulse', 'coming-up', 'long-range']);
    for (const b of bodies) {
      expect(Object.keys(b).sort()).toEqual(expect.arrayContaining(['check']));
      expect(b.text).toBeUndefined();
      expect(b.scope).toBeUndefined();
      expect(b.pulse).toBeUndefined();
    }
    expect(homeThread(page).filter((m) => m.cls === 'msg me').map((m) => m.text)).toEqual(['Pulse', 'Coming up', 'Long range']);
    expect(homeThread(page).at(-1)).toMatchObject({ cls: 'msg cacci', text: 'One thing needs you this week.', lines: ['Dentist tomorrow at 9:15. (From: your own notes)'] });
  });

  it('a check clears an earlier problem shown beside the boxes', async () => {
    const { page } = await start({ 'POST /api/status': SILENT }, '#/');
    page.el('question-form').fire('submit');
    await settle();
    expect(page.el('question-error').hidden).toBe(false);
    await click(page, 'check-pulse');
    expect(page.el('question-error').hidden).toBe(true);
  });

  it('a silent answer is the headline alone: no second line', async () => {
    const { page } = await start({ 'POST /api/status': SILENT }, '#/');
    await click(page, 'check-pulse');
    expect(homeThread(page).at(-1)).toMatchObject({ text: 'Nothing needs your attention this week.', lines: [] });
    expect(page.el('chat-thread').children.at(-1).querySelector('[data-slot="lines"]').hidden).toBe(true);
  });

  it('are disabled while a request is out, and a failure puts the service\'s words in the thread', async () => {
    const hold = gate();
    const { page } = await start({ 'POST /api/status': () => hold.promise.then(() => SILENT) }, '#/');
    page.el('check-coming-up').fire('click');
    await settle();
    for (const id of ['check-pulse', 'check-coming-up', 'check-long-range', 'question-ask']) expect(page.el(id).disabled, id).toBe(true);
    hold.release();
    await settle();
    for (const id of ['check-pulse', 'check-coming-up', 'check-long-range']) expect(page.el(id).disabled, id).toBe(false);
    const failing = await start({ 'POST /api/status': { status: 429, body: { error: { code: 'THROTTLED', message: 'slow down' } } } }, '#/');
    await click(failing.page, 'check-long-range');
    expect(homeThread(failing.page).at(-1).cls).toBe('msg cacci problem');
  });

  it('the Pulse answer and its facts carry Show the source buttons like any answer', async () => {
    const withFacts = answerWith('One thing.', [{ text: 'Dentist.', sources: [{ kind: 'personal' }], facts: [{ scope: { kind: 'personal' }, id: 'note-1' }] }]);
    const { page } = await start({ 'POST /api/status': withFacts }, '#/');
    await click(page, 'check-pulse');
    const row = page.el('chat-thread').children.at(-1);
    expect(row.querySelector('[data-slot="lines"]').children[0].querySelector('[data-slot="source"]').hidden).toBe(false);
  });
});

describe('the three checks on a circle screen (R-018 D12)', () => {
  it('Pulse, Coming up and Long range each send their check with this circle only, and a silent answer is one line', async () => {
    const { page, svc } = await start({ 'POST /api/status': SILENT });
    for (const id of ['circle-pulse', 'circle-coming-up', 'circle-long-range']) expect(page.el(id).disabled, id).toBe(false);
    await click(page, 'circle-pulse');
    await click(page, 'circle-coming-up');
    await click(page, 'circle-long-range');
    const bodies = checkBody(svc);
    expect(bodies[0]).toMatchObject({ pulse: true, scope: { kind: 'circle', circleId: C1 } });
    expect(bodies[1]).toMatchObject({ check: 'coming-up', scope: { kind: 'circle', circleId: C1 } });
    expect(bodies[2]).toMatchObject({ check: 'long-range', scope: { kind: 'circle', circleId: C1 } });
    for (const b of bodies.slice(1)) expect(b.text).toBeUndefined();
    expect(circleThread(page).filter((m) => m.cls === 'msg me').map((m) => m.text)).toEqual(['Pulse', 'Coming up', 'Long range']);
    for (const m of circleThread(page).filter((x) => x.cls === 'msg cacci')) expect(m).toMatchObject({ text: 'Nothing needs your attention this week.', lines: [] });
  });

  it('an observer can ask all three of the circle, though not add to it', async () => {
    const { page, svc } = await start({ 'POST /api/status': ONE }, `#/circle/${C2}`);
    expect(page.el('circle-update-send').disabled).toBe(true);
    for (const id of ['circle-pulse', 'circle-coming-up', 'circle-long-range']) expect(page.el(id).disabled, id).toBe(false);
    await click(page, 'circle-long-range');
    expect(checkBody(svc)[0]).toMatchObject({ check: 'long-range', scope: { kind: 'circle', circleId: C2 } });
    expect(circleThread(page).at(-1).text).toBe('One thing needs you this week.');
  });

  it('the buttons are disabled while a request is out', async () => {
    const hold = gate();
    const { page } = await start({ 'POST /api/status': () => hold.promise.then(() => SILENT) });
    page.el('circle-coming-up').fire('click');
    await settle();
    for (const id of ['circle-pulse', 'circle-coming-up', 'circle-long-range']) expect(page.el(id).disabled, id).toBe(true);
    hold.release();
    await settle();
    for (const id of ['circle-pulse', 'circle-coming-up', 'circle-long-range']) expect(page.el(id).disabled, id).toBe(false);
  });

  it('a stranger gets the one not-found in words, and the thread says so', async () => {
    const { page } = await start({ 'POST /api/status': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such circle' } } } });
    await click(page, 'circle-coming-up');
    expect(circleThread(page).at(-1).text).toBe('No such circle, or you are not in it.');
  });

  it('each circle keeps its own thread of checks', async () => {
    const { page, addr } = await start({ 'POST /api/status': SILENT });
    await click(page, 'circle-coming-up');
    addr.go(`#/circle/${C2}`);
    await settle();
    expect(circleThread(page)).toEqual([]);
    addr.go(`#/circle/${C1}`);
    await settle();
    expect(circleThread(page).map((m) => m.text)).toEqual(['Coming up', 'Nothing needs your attention this week.']);
  });
});
