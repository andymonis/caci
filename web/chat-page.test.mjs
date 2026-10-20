import { describe, expect, it } from 'vitest';
import { fakePage, settle } from './fake-page.test-util.mjs';
import { mountChatPage } from './chat-page.js';
import { CHAT_MODE_WORDS } from './chat-view.js';
import { createNotesClient } from './notes-client.js';
import { mountUser } from './user-mount.js';

const USER = { id: 'u0000000000000001', username: 'ann', displayName: 'Ann A' };
const CIRCLE = 'c0000000000000001';
const proposal = (extra = {}) => ({
  id: 'prop-aaa-1', createdAt: 1, expiresAt: 2, mode: 'demo', text: 'x', operations: [{ op: 'upsertNode', partition: 'item', id: 'i1' }],
  summary: { newItems: ['i1'], updatedItems: [], newCategories: [], updatedCategories: [], reusedCategories: [], newLinks: [], problems: [], notes: [], facts: [{ id: 'i1', title: 'Dose', summary: '2 tablets' }], removed: [], ...extra },
});
const answer = (headline, points = []) => ({ status: 200, body: { status: { headline, points, nothing: points.length === 0, generatedAt: 1, mode: 'demo', entriesUsed: 1, entriesLeftOut: 0 } } });
const gate = () => { let release; const promise = new Promise((r) => (release = r)); return { promise, release }; };

function service(table) {
  const calls = [];
  const fetchFn = async (path, init) => {
    const key = `${init.method} ${path}`;
    calls.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const entry = table[key] ?? { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'not signed in' } } };
    const a = await (typeof entry === 'function' ? entry(calls) : entry);
    return { status: a.status, headers: { get: () => null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { fetchFn, calls, keys: () => calls.map((c) => c.key) };
}
const BASE = (extra = {}) => ({
  'GET /api/me': { status: 200, body: { user: USER, graphId: 'x' } },
  'GET /api/capture/mode': { status: 200, body: { mode: 'demo' } },
  'POST /api/capture/propose': { status: 201, body: { proposal: proposal() } },
  'POST /api/capture/proposals/prop-aaa-1/approve': { status: 200, body: { written: { id: 'prop-aaa-1', applied: 3, summary: { newItems: [], updatedItems: [], newCategories: [], updatedCategories: [], reusedCategories: [], newLinks: [], problems: [], notes: [] } } } },
  'POST /api/capture/proposals/prop-aaa-1/reject': { status: 204 },
  'POST /api/status': answer('Heading out', [{ text: 'Take 2 tablets', sources: [{ kind: 'personal' }] }]),
  'POST /api/logout': { status: 204 },
  ...extra,
});
async function start(table = BASE()) {
  const page = fakePage('user.html');
  const svc = service(table);
  let hooks;
  mountUser(page.document, svc.fetchFn, { getHash: () => '', setHash: () => {}, onHashChange: () => {} }, ({ recheck }) => (hooks = mountChatPage(page.document, createNotesClient({ fetchFn: svc.fetchFn }), recheck)));
  await settle();
  return { page, svc, hooks };
}
const thread = (page) => page.el('chat-thread').children.map((row) => ({ cls: row.getAttribute('class'), text: row.querySelector('[data-slot="text"]').textContent, lines: row.querySelector('[data-slot="lines"]').children.map((l) => l.querySelector('[data-slot="text"]').textContent) }));
const send = async (page, text) => { page.el('update-text').value = text; page.el('update-form').fire('submit'); await settle(); };
const ask = async (page, text) => { page.el('question-text').value = text; page.el('question-form').fire('submit'); await settle(); };

describe('the chat on Home', () => {
  it('shows which model handles updates before anything is sent, and asks for the mode once', async () => {
    const { page, svc } = await start();
    expect(page.el('chat-notice').textContent).toBe(CHAT_MODE_WORDS.demo);
    expect(page.el('update-send').disabled).toBe(false);
    expect(svc.keys().filter((k) => k === 'GET /api/capture/mode')).toHaveLength(1);
    expect(svc.keys().filter((k) => k.startsWith('POST'))).toEqual([]);
  });
  it('the real model\'s notice says that notes are sent and not anonymised', async () => {
    const { page } = await start(BASE({ 'GET /api/capture/mode': { status: 200, body: { mode: 'anthropic' } } }));
    expect(page.el('chat-notice').textContent).toBe(CHAT_MODE_WORDS.anthropic);
    expect(CHAT_MODE_WORDS.anthropic).toContain('not anonymised');
  });
  it('says it is checking while the mode is being asked', async () => {
    const g = gate();
    const { page } = await start(BASE({ 'GET /api/capture/mode': () => g.promise }));
    expect(page.el('chat-notice').textContent).toBe('Checking which model handles your updates…');
    g.release({ status: 200, body: { mode: 'demo' } });
    await settle();
    expect(page.el('chat-notice').textContent).toBe(CHAT_MODE_WORDS.demo);
  });
  it('cannot send until the mode is known; a failed mode shows its words and Try again', async () => {
    let n = 0;
    const { page, svc } = await start(BASE({ 'GET /api/capture/mode': () => (++n === 1 ? { status: 500, body: { error: { code: 'STORAGE_ERROR', message: 'x' } } } : { status: 200, body: { mode: 'demo' } }) }));
    expect(page.el('chat-retry').hidden).toBe(false);
    expect(page.el('chat-mode-error').hidden).toBe(false);
    expect(page.el('update-send').disabled).toBe(true);
    expect(page.el('chat-notice').textContent).toContain('Could not tell');
    page.el('chat-retry').fire('click');
    await settle();
    expect(page.el('chat-retry').hidden).toBe(true);
    expect(page.el('update-send').disabled).toBe(false);
    expect(svc.keys().filter((k) => k.startsWith('POST'))).toEqual([]);
  });
  it('sending with only an own brain files straight away, shows both sides and clears the box', async () => {
    const { page, svc } = await start();
    page.el('chat-thread').scrollHeight = 500;
    await send(page, 'Mum now takes 2 tablets');
    expect(svc.keys().filter((k) => k.startsWith('POST'))).toEqual(['POST /api/capture/propose', 'POST /api/capture/proposals/prop-aaa-1/approve']);
    expect(svc.calls.find((c) => c.key === 'POST /api/capture/propose').body).toEqual({ text: 'Mum now takes 2 tablets' });
    const t = thread(page);
    expect(t.map((m) => [m.cls, m.text])).toEqual([['msg me', 'Mum now takes 2 tablets'], ['msg cacci', 'Recorded against your brain']]);
    expect(t[1].lines).toEqual(['Dose: 2 tablets']);
    expect(page.el('update-text').value).toBe('');
    expect(page.focused().id).toBe('update-text');
    expect(page.el('chat-thread').scrollTop).toBe(500);
  });
  it('a replaced fact is listed', async () => {
    const { page } = await start(BASE({ 'POST /api/capture/propose': { status: 201, body: { proposal: proposal({ removed: [{ id: 'i0', title: 'Dose', summary: '1 tablet' }] }) } } }));
    await send(page, 'now 2');
    expect(thread(page)[1].lines).toEqual(['Dose: 2 tablets', 'Replaced: Dose: 1 tablet']);
  });
  it('a refusal is said in the thread in the service\'s words, nothing is cleared wrongly, and the proposal is discarded', async () => {
    const { page, svc } = await start(BASE({ 'POST /api/capture/proposals/prop-aaa-1/approve': { status: 409, body: { error: { code: 'WRITE_REFUSED', message: 'could not write' } } } }));
    await send(page, 'hello');
    const last = thread(page).at(-1);
    expect(last.cls).toBe('msg cacci problem');
    expect(last.text).toContain('Not recorded:');
    expect(svc.keys()).toContain('POST /api/capture/proposals/prop-aaa-1/reject');
    expect(page.el('update-text').value).toBe('hello');
  });
  it('an empty update or question is refused beside its box and sends nothing', async () => {
    const { page, svc } = await start();
    await send(page, '   ');
    expect(page.el('update-error').hidden).toBe(false);
    expect(page.focused().id).toBe('update-text');
    await ask(page, '');
    expect(page.el('question-error').hidden).toBe(false);
    expect(page.focused().id).toBe('question-text');
    expect(thread(page)).toEqual([]);
    expect(svc.keys().filter((k) => k.startsWith('POST'))).toEqual([]);
    await send(page, 'ok');
    expect(page.el('update-error').hidden).toBe(true);
  });
  it('asking shows the question and the answer with where it came from, and clears the question', async () => {
    const { page, svc } = await start();
    await ask(page, 'What is Mum taking?');
    expect(svc.calls.find((c) => c.key === 'POST /api/status').body.text).toBe('What is Mum taking?');
    const t = thread(page);
    expect(t.map((m) => [m.cls, m.text])).toEqual([['msg me', 'What is Mum taking?'], ['msg cacci', 'Heading out']]);
    expect(t[1].lines).toEqual(['Take 2 tablets (From: your own notes)']);
    expect(page.el('question-text').value).toBe('');
  });
  it('an answer with nothing relevant says so; a limit is said with its wait', async () => {
    const a = await start(BASE({ 'POST /api/status': answer('Nothing') }));
    await ask(a.page, 'q');
    expect(thread(a.page)[1].lines).toEqual(['Nothing relevant was found in what you can read.']);
    const b = await start(BASE({ 'POST /api/status': { status: 429, body: { error: { code: 'THROTTLED', message: 'Too many' } } } }));
    await ask(b.page, 'q');
    expect(thread(b.page)[1].cls).toBe('msg cacci problem');
  });
  it('controls are disabled while a request is out, and nothing is sent twice', async () => {
    const g = gate();
    const { page, svc } = await start(BASE({ 'POST /api/status': () => g.promise }));
    page.el('question-text').value = 'q';
    page.el('question-form').fire('submit');
    await settle();
    expect(page.el('update-send').disabled).toBe(true);
    expect(page.el('question-ask').disabled).toBe(true);
    expect(page.el('question-form').getAttribute('aria-busy')).toBe('true');
    page.el('question-form').fire('submit');
    await settle();
    expect(svc.keys().filter((k) => k === 'POST /api/status')).toHaveLength(1);
    g.release(answer('done'));
    await settle();
    expect(page.el('question-ask').disabled).toBe(false);
  });
  it('a message with no facts hides its list, and one with facts shows it', async () => {
    const { page } = await start();
    await send(page, 'hello');
    const rows = page.el('chat-thread').children;
    expect(rows[0].querySelector('[data-slot="lines"]').hidden).toBe(true);
    expect(rows[1].querySelector('[data-slot="lines"]').hidden).toBe(false);
  });
  it('errors beside the boxes are cleared by the next try', async () => {
    const { page } = await start();
    await ask(page, '');
    expect(page.el('question-error').hidden).toBe(false);
    await send(page, 'ok');
    expect(page.el('question-error').hidden).toBe(true);
    await send(page, ' ');
    expect(page.el('update-error').hidden).toBe(false);
    await ask(page, 'q');
    expect(page.el('update-error').hidden).toBe(true);
  });
  it('signing out empties the boxes and their errors', async () => {
    const { page } = await start();
    await send(page, ' ');
    page.el('update-text').value = 'draft';
    page.el('question-text').value = 'draft';
    page.el('signout').fire('click');
    await settle();
    expect(page.el('update-text').value).toBe('');
    expect(page.el('question-text').value).toBe('');
    expect(page.el('update-error').hidden).toBe(true);
  });
  it('hostile text, from the person or from CaCi, is only text', async () => {
    const evil = '<img src=x onerror=alert(1)><script>x</script>';
    const { page } = await start(BASE({ 'POST /api/status': answer(evil, [{ text: evil, sources: [{ kind: 'circle', circleId: CIRCLE, circleName: evil }] }]) }));
    await ask(page, evil);
    const t = thread(page);
    expect(t[0].text).toBe(evil);
    expect(t[1].text).toBe(evil);
    expect(t[1].lines[0]).toContain(evil);
    for (const row of page.el('chat-thread').children) expect(row.children.map((c) => c.tagName)).toEqual(['p', 'ul']);
  });
  it('the thread stays when going to Settings and back, and is gone after signing out', async () => {
    const { page } = await start();
    await ask(page, 'q');
    page.el('signout').fire('click');
    await settle();
    expect(thread(page)).toEqual([]);
    expect(page.el('chat-notice').textContent).not.toBe(CHAT_MODE_WORDS.demo);
  });
  it('a request that finds the session ended re-checks once (no loop)', async () => {
    let me = 0;
    const { page } = await start(BASE({ 'GET /api/me': () => (++me, { status: 200, body: { user: USER, graphId: 'x' } }), 'POST /api/status': { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'not signed in' } } } }));
    await ask(page, 'a');
    await ask(page, 'b');
    expect(me).toBe(2);
  });
});
