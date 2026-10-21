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
const pulse = async (page) => { page.el('circle-pulse').fire('click'); await settle(); };


const FACT = { scope: { kind: 'circle', circleId: C1, circleName: 'Parent care' }, id: 'note-1' };
const POINTS = [{ text: 'Mum has Tablet B.', sources: [{ kind: 'circle', circleId: C1, circleName: 'Parent care' }], facts: [FACT] }, { text: 'Bins on Thursday', sources: [], facts: [] }];
const SOURCE = { source: { scope: FACT.scope, fact: { title: 'Tablet B', summary: '1 x daily' }, current: true, replacedLater: true, recorded: true, enteredBy: { username: 'bob', displayName: 'Bob B' }, at: Date.UTC(2026, 9, 20, 9, 30), words: 'Mum now has 1 x Tablet B <b>daily</b>' } };
const withStatus = { 'POST /api/status': { status: 200, body: { status: { headline: 'Quiet.', points: POINTS, nothing: false, generatedAt: 1, mode: 'demo', entriesUsed: 1, entriesLeftOut: 0 } } }, [`GET /api/ledger/source?scope=circle:${C1}&id=note-1`]: { status: 200, body: SOURCE } };
const buttons = (page, listId) => page.el(listId).children.flatMap((row) => row.querySelector('[data-slot="lines"]').children.map((li) => li.querySelector('[data-slot="source"]')));
const sourceRows = (page, listId) => page.el(listId).children.filter((r) => r.getAttribute('class') === 'msg cacci' && r.getAttribute('tabindex') === '-1');

describe('Show the source on a circle screen', () => {
  it('a button on exactly the points that have facts; none before an answer', async () => {
    const { page } = await start(withStatus);
    expect(buttons(page, 'circle-thread')).toEqual([]);
    await pulse(page);
    const [first, second] = buttons(page, 'circle-thread').filter((b) => b);
    expect(first.hidden).toBe(false);
    expect(first.textContent).toBe('Show the source');
    expect(first.getAttribute('aria-label')).toBe('Show the source of: Mum has Tablet B. (From: "Parent care")');
    expect(second.hidden).toBe(true);
  });

  it('pressing it asks the ledger (scope and id in the address), adds who, when and the words as text, and moves the focus there', async () => {
    const { page, svc } = await start(withStatus);
    await pulse(page);
    buttons(page, 'circle-thread').filter((b) => b)[0].fire('click');
    await settle();
    expect(svc.keys().filter((k) => k.startsWith('GET /api/ledger/source'))).toEqual([`GET /api/ledger/source?scope=circle:${C1}&id=note-1`]);
    const rows = sourceRows(page, 'circle-thread');
    expect(rows).toHaveLength(1);
    const lines = rows[0].querySelector('[data-slot="lines"]').children.map((l) => l.querySelector('[data-slot="text"]').textContent);
    expect(lines).toEqual(['Entered by Bob B on 2026-10-20 09:30 UTC: "Mum now has 1 x Tablet B <b>daily</b>"', 'This fact was replaced later.']);
    expect(page.focused()).toBe(rows[0]);
  });

  it('the buttons are disabled while a request is out', async () => {
    const hold = gate();
    const { page } = await start({ ...withStatus, [`GET /api/ledger/source?scope=circle:${C1}&id=note-1`]: () => hold.promise.then(() => ({ status: 200, body: SOURCE })) });
    await pulse(page);
    const button = () => buttons(page, 'circle-thread').filter((b) => b)[0];
    button().fire('click');
    await settle();
    expect(button().disabled).toBe(true);
    hold.release();
    await settle();
    expect(button().disabled).toBe(false);
  });

  it('a failure puts the service words in the thread and leaves the focus alone', async () => {
    const { page } = await start({ ...withStatus, [`GET /api/ledger/source?scope=circle:${C1}&id=note-1`]: { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such item' } } } });
    await pulse(page);
    buttons(page, 'circle-thread').filter((b) => b)[0].fire('click');
    await settle();
    const last = page.el('circle-thread').children.at(-1);
    expect(last.getAttribute('class')).toBe('msg cacci problem');
    expect(last.querySelector('[data-slot="text"]').textContent).toBe('Not found: the change log no longer knows this fact.');
  });

  it('an observer can trace what the Pulse said', async () => {
    const C2facts = { ...withStatus };
    const { page, svc } = await start(C2facts, `#/circle/${C2}`);
    svc.state.table = {};
    expect(page.el('circle-update-send').disabled).toBe(true);
    await pulse(page);
    expect(buttons(page, 'circle-thread').filter((b) => b && !b.hidden).length).toBe(1);
  });

  it('on Home an answer to a question has the same buttons', async () => {
    const { page, svc } = await start(withStatus, '#/');
    page.el('question-text').value = 'What tablets?';
    page.el('question-form').fire('submit');
    await settle();
    const rows = page.el('chat-thread').children;
    const btn = rows.flatMap((row) => row.querySelector('[data-slot="lines"]').children.map((li) => li.querySelector('[data-slot="source"]'))).filter((b) => b && !b.hidden)[0];
    expect(btn).toBeDefined();
    btn.fire('click');
    await settle();
    expect(svc.keys().filter((k) => k.startsWith('GET /api/ledger/source'))).toHaveLength(1);
    const rows2 = sourceRows(page, 'chat-thread');
    expect(rows2).toHaveLength(1);
    expect(page.focused()).toBe(rows2[0]);
  });

  it('on Home the buttons are disabled while a request is out', async () => {
    const hold = gate();
    const { page } = await start({ ...withStatus, [`GET /api/ledger/source?scope=circle:${C1}&id=note-1`]: () => hold.promise.then(() => ({ status: 200, body: SOURCE })) }, '#/');
    page.el('question-text').value = 'What tablets?';
    page.el('question-form').fire('submit');
    await settle();
    const button = () => page.el('chat-thread').children.flatMap((row) => row.querySelector('[data-slot="lines"]').children.map((li) => li.querySelector('[data-slot="source"]'))).filter((b) => b && !b.hidden)[0];
    button().fire('click');
    await settle();
    expect(button().disabled).toBe(true);
    hold.release();
    await settle();
    expect(button().disabled).toBe(false);
  });

  it('the button of a later point asks for that point\'s facts', async () => {
    const second = { ...FACT, id: 'note-2' };
    const pts = [{ text: 'One.', sources: [], facts: [FACT] }, { text: 'Two.', sources: [], facts: [second] }];
    const { page, svc } = await start({ ...withStatus, 'POST /api/status': { status: 200, body: { status: { headline: 'Q.', points: pts, nothing: false, generatedAt: 1, mode: 'demo', entriesUsed: 1, entriesLeftOut: 0 } } }, [`GET /api/ledger/source?scope=circle:${C1}&id=note-2`]: { status: 200, body: SOURCE } });
    await pulse(page);
    buttons(page, 'circle-thread').filter((b) => b && !b.hidden)[1].fire('click');
    await settle();
    expect(svc.keys().filter((k) => k.startsWith('GET /api/ledger/source'))).toEqual([`GET /api/ledger/source?scope=circle:${C1}&id=note-2`]);
  });

  it('an answer whose points have no facts has no visible buttons', async () => {
    const { page } = await start({ 'POST /api/status': { status: 200, body: { status: { headline: 'Quiet.', points: [{ text: 'Bins', sources: [] }], nothing: false, generatedAt: 1, mode: 'demo', entriesUsed: 1, entriesLeftOut: 0 } } } });
    await pulse(page);
    expect(buttons(page, 'circle-thread').filter((b) => b && !b.hidden)).toEqual([]);
  });
});
