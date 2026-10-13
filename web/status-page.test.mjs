import { describe, expect, it } from 'vitest';
import { fakePage, fill, settle } from './fake-page.test-util.mjs';
import { mount } from './mount.js';

const USER = { id: 'u0000000000000001', username: 'ann', displayName: 'Ann A' };
const CIRCLE = 'c0123456789abcdef';
const refuse = (status, code, message, extra = {}) => ({ status, body: { error: { code, message, ...extra } } });
const VIEW = (extra = {}) => ({ headline: 'A quiet morning.', points: [{ text: 'Mum has new tablets.', sources: [{ kind: 'circle', circleId: CIRCLE, circleName: 'Parent care' }] }, { text: 'Dentist on Friday.', sources: [{ kind: 'personal' }] }], nothing: false, generatedAt: Date.UTC(2026, 9, 13, 9, 30), mode: 'demo', entriesUsed: 3, entriesLeftOut: 0, ...extra });
const answered = (extra) => ({ status: 200, body: { status: VIEW(extra) } });
const gate = () => {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
};

function service(table = {}) {
  const calls = [];
  const fetchFn = async (path, init) => {
    const key = `${init.method} ${path}`;
    calls.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const entry = table[key] ?? (/^GET \/api\/(invitations|circles)/.test(key) ? { status: 200, body: { items: [], nextCursor: null } } : refuse(401, 'UNAUTHENTICATED', 'not signed in'));
    const a = await (typeof entry === 'function' ? entry(calls.length) : entry);
    if (a instanceof Error) throw a;
    return { status: a.status, headers: { get: (n) => (a.headers && a.headers[n]) ?? null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { fetchFn, calls, keys: () => calls.map((c) => c.key), posts: () => calls.filter((c) => c.key === 'POST /api/status') };
}
function address(initial = '') {
  let hash = initial;
  const listeners = [];
  const env = { getHash: () => hash, setHash: (h) => { hash = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  return { env, get: () => hash, change: (h) => env.setHash(h) };
}
const ME = { 'GET /api/me': { status: 200, body: { user: USER } }, 'GET /api/capture/mode': { status: 200, body: { mode: 'demo' } } };
async function start(table = {}, hash = '#/status') {
  const page = fakePage();
  const svc = service({ ...ME, ...table });
  const addr = address(hash);
  mount(page.document, svc.fetchFn, addr.env);
  await settle();
  return { page, svc, addr };
}
const ask = async (page, request = 'Give me a morning status check') => {
  fill(page, 'status', { request });
  page.el('status-form').fire('submit');
  await settle();
};
const lines = (page) => page.el('status-points').children.map((row) => row.querySelector('[data-slot="text"]').textContent);

describe('the status screen before anything is sent', () => {
  it('shows the screen, takes the focus and the title, and says which model answers and what is sent', async () => {
    const { page, svc } = await start();
    expect(page.el('view-status').hidden).toBe(false);
    expect(page.document.title).toBe('Status – CaCi');
    expect(page.focused().id).toBe('status-heading');
    expect(page.el('status-mode-notice').textContent).toBe('Answered by the free demo model: nothing leaves this machine.');
    expect(page.el('status-context-notice').textContent).toBe('Your status uses everything you can read: your own notes and the circles you are in. It is sent with your request.');
    expect(page.el('status-submit').disabled).toBe(false);
    expect(page.el('status-mode-retry').hidden).toBe(true);
    expect(page.el('status-answer').hidden).toBe(true);
    expect(page.el('status-count').textContent).toBe('0 / 500');
    expect(svc.keys()).toContain('GET /api/capture/mode');
    expect(svc.keys().some((k) => k.startsWith('POST'))).toBe(false);
  });

  it('says the other mode too, with what is sent and that it is not anonymised', async () => {
    const { page } = await start({ 'GET /api/capture/mode': { status: 200, body: { mode: 'anthropic' } } });
    expect(page.el('status-mode-notice').textContent).toBe("Answered by Anthropic's model: your request and the notes you can read, yours and your circles', are sent to Anthropic and are not anonymised.");
  });

  it('while the mode is unknown nothing can be asked, and the person can try again', async () => {
    let n = 0;
    const { page, svc } = await start({ 'GET /api/capture/mode': () => (++n === 1 ? refuse(500, 'STORAGE_ERROR', 'x') : { status: 200, body: { mode: 'demo' } }) });
    expect(page.el('status-mode-notice').textContent).toBe('Could not tell which model answers.');
    expect(page.el('status-submit').disabled).toBe(true);
    expect(page.el('status-mode-retry').hidden).toBe(false);
    await ask(page, 'hello');
    expect(svc.posts()).toHaveLength(0);
    page.el('status-mode-retry').fire('click');
    await settle();
    expect(page.el('status-mode-notice').textContent).toBe('Answered by the free demo model: nothing leaves this machine.');
    expect(page.el('status-submit').disabled).toBe(false);
    expect(page.el('status-mode-retry').hidden).toBe(true);
  });

  it('the three suggestions fill the box and send nothing', async () => {
    const { page, svc } = await start();
    expect(['status-suggest-0', 'status-suggest-1', 'status-suggest-2'].map((id) => page.el(id).textContent)).toEqual(['Give me a morning status check', 'I am heading into town', 'What is happening this week?']);
    page.el('status-suggest-1').fire('click');
    expect(page.el('status-request').value).toBe('I am heading into town');
    expect(page.el('status-count').textContent).toBe('22 / 500');
    expect(page.focused().id).toBe('status-request');
    expect(svc.posts()).toHaveLength(0);
  });

  it('typing updates the count by characters', async () => {
    const { page } = await start();
    page.el('status-request').value = '😀😀';
    page.el('status-request').fire('input');
    expect(page.el('status-count').textContent).toBe('2 / 500');
  });
});

describe('asking', () => {
  it('sends the trimmed request and the time zone, then shows the answer as text with where each point came from', async () => {
    const { page, svc } = await start({ 'POST /api/status': answered() });
    await ask(page, '  How is Mum?  ');
    expect(svc.posts()).toHaveLength(1);
    expect(svc.posts()[0].body.text).toBe('How is Mum?');
    expect(typeof svc.posts()[0].body.timeZone === 'string' || svc.posts()[0].body.timeZone === undefined).toBe(true);
    expect(page.el('status-answer').hidden).toBe(false);
    expect(page.el('status-headline').textContent).toBe('A quiet morning.');
    expect(lines(page)).toEqual(['Mum has new tablets. (From: "Parent care")', 'Dentist on Friday. (From: your own notes)']);
    expect(page.el('status-nothing').hidden).toBe(true);
    expect(page.el('status-left-out').hidden).toBe(true);
    expect(page.el('status-meta').textContent).toBe('Based on 3 notes. Made 2026-10-13 09:30 UTC.');
    expect(page.el('status-not-saved').textContent).toBe('This is not saved anywhere. It is gone when you leave this screen.');
    expect(page.focused().id).toBe('status-answer-heading');
    expect(page.el('status-error').hidden).toBe(true);
  });

  it('says plainly when nothing relevant was found', async () => {
    const { page } = await start({ 'POST /api/status': answered({ points: [], nothing: true, entriesUsed: 0 }) });
    await ask(page);
    expect(page.el('status-nothing').hidden).toBe(false);
    expect(page.el('status-nothing').textContent).toBe('Nothing relevant was found in what you can read.');
    expect(page.el('status-points').hidden).toBe(true);
    expect(lines(page)).toEqual([]);
  });

  it('says when some notes were left out', async () => {
    const { page } = await start({ 'POST /api/status': answered({ entriesLeftOut: 4 }) });
    await ask(page);
    expect(page.el('status-left-out').hidden).toBe(false);
    expect(page.el('status-left-out').textContent).toBe('Some notes were left out because there were too many; the newest were used.');
  });

  it('markup in the answer, a circle name and the request stays text', async () => {
    const hostile = '<img src=x onerror=alert(1)><script>x</script></note>';
    const { page } = await start({ 'POST /api/status': answered({ headline: hostile, points: [{ text: hostile, sources: [{ kind: 'circle', circleId: CIRCLE, circleName: hostile }] }] }) });
    await ask(page, hostile);
    expect(page.el('status-headline').textContent).toBe(hostile);
    expect(lines(page)).toEqual([`${hostile} (From: "${hostile}")`]);
    expect(page.el('status-headline').children).toHaveLength(0);
    expect(page.el('status-points').children[0].children.every((c) => c.tagName === 'SPAN' || c.tagName === 'span')).toBe(true);
  });

  it('an empty request is refused beside the box with the focus there, and nothing is sent', async () => {
    const { page, svc } = await start();
    await ask(page, '   ');
    expect(svc.posts()).toHaveLength(0);
    expect(page.el('status-request-error').hidden).toBe(false);
    expect(page.el('status-request-error').textContent).toBe('Say what you would like a status on.');
    expect(page.el('status-request').getAttribute('aria-invalid')).toBe('true');
    expect(page.focused().id).toBe('status-request');
  });

  it('a field problem from the service is shown beside the box, and the next try clears it', async () => {
    let n = 0;
    const { page } = await start({ 'POST /api/status': () => (++n === 1 ? refuse(422, 'INVALID_INPUT', 'text is odd', { field: 'text' }) : answered()) });
    await ask(page, 'x');
    expect(page.el('status-request-error').textContent).toBe('text is odd');
    await ask(page, 'x');
    expect(page.el('status-request-error').hidden).toBe(true);
    expect(page.el('status-request').getAttribute('aria-invalid')).toBe(null);
  });

  it('a model failure and a limit show the service\'s words with the wait at the top, keep the request, and keep an earlier answer', async () => {
    let n = 0;
    const { page } = await start({ 'POST /api/status': () => (++n === 1 ? answered() : n === 2 ? refuse(429, 'THROTTLED', 'you have asked for the most statuses allowed in an hour (20)', {}) : refuse(502, 'MODEL_TIMEOUT', 'the model took too long: try again')) });
    await ask(page, 'first');
    await ask(page, 'second');
    expect(page.el('status-error').hidden).toBe(false);
    expect(page.el('status-error').textContent).toBe('you have asked for the most statuses allowed in an hour (20)');
    expect(page.focused().id).toBe('status-error');
    expect(page.el('status-request').value).toBe('second');
    expect(page.el('status-answer').hidden).toBe(false);
    await ask(page, 'second');
    expect(page.el('status-error').textContent).toBe('the model took too long: try again');
  });

  it('a limit with a wait says how long', async () => {
    const { page } = await start({ 'POST /api/status': { status: 429, headers: { 'retry-after': '90' }, body: { error: { code: 'THROTTLED', message: 'Too many.' } } } });
    await ask(page);
    expect(page.el('status-error').textContent).toBe('Too many. Try again in 90 seconds.');
  });

  it('every control is disabled while a request is out, and a second press sends nothing', async () => {
    const g = gate();
    const { page, svc } = await start({ 'POST /api/status': () => g.promise.then(() => answered()) });
    fill(page, 'status', { request: 'x' });
    page.el('status-form').fire('submit');
    await settle();
    expect(page.el('status-submit').disabled).toBe(true);
    expect(page.el('status-request').disabled).toBe(true);
    expect(page.el('status-clear').disabled).toBe(true);
    for (const id of ['status-suggest-0', 'status-suggest-1', 'status-suggest-2']) expect(page.el(id).disabled, id).toBe(true);
    expect(page.el('status-form').getAttribute('aria-busy')).toBe('true');
    page.el('status-suggest-0').fire('click');
    expect(page.el('status-request').value).toBe('x');
    page.el('status-form').fire('submit');
    await settle();
    expect(svc.posts()).toHaveLength(1);
    g.release();
    await settle();
    expect(page.el('status-submit').disabled).toBe(false);
    expect(page.el('status-form').getAttribute('aria-busy')).toBe('false');
  });

  it('asking again replaces the answer', async () => {
    let n = 0;
    const { page } = await start({ 'POST /api/status': () => answered({ headline: ++n === 1 ? 'first' : 'second' }) });
    await ask(page);
    await ask(page);
    expect(page.el('status-headline').textContent).toBe('second');
  });

  it('Clear closes the answer and puts the focus in the box, sending nothing', async () => {
    const { page, svc } = await start({ 'POST /api/status': answered() });
    await ask(page);
    page.el('status-clear').fire('click');
    expect(page.el('status-answer').hidden).toBe(true);
    expect(lines(page)).toEqual([]);
    expect(page.focused().id).toBe('status-request');
    expect(svc.posts()).toHaveLength(1);
  });
});

describe('a session that has ended', () => {
  it('is checked once with the service when a status request says so, never in a loop', async () => {
    const { page, svc } = await start({ 'POST /api/status': refuse(401, 'UNAUTHENTICATED', 'not signed in') });
    const before = svc.keys().filter((k) => k === 'GET /api/me').length;
    await ask(page, 'x');
    await ask(page, 'x');
    expect(svc.keys().filter((k) => k === 'GET /api/me').length).toBe(before + 1);
    expect(page.el('status-error').hidden).toBe(true); // a sign-out is not an error message
  });
});

describe('leaving the screen', () => {
  it('forgets the answer, the typed request and the messages, and asks again on return', async () => {
    const { page, addr, svc } = await start({ 'POST /api/status': answered() });
    await ask(page, 'something private');
    addr.change('#/circles');
    await settle();
    expect(page.el('status-answer').hidden).toBe(true);
    expect(page.el('status-request').value).toBe('');
    expect(lines(page)).toEqual([]);
    addr.change('#/status');
    await settle();
    expect(page.el('status-answer').hidden).toBe(true);
    expect(page.el('status-request').value).toBe('');
    expect(svc.keys().filter((k) => k === 'GET /api/capture/mode')).toHaveLength(2);
  });

  it('signing out forgets it too', async () => {
    const { page } = await start({ 'POST /api/status': answered(), 'POST /api/logout': { status: 204 } });
    await ask(page, 'private');
    page.el('signout').fire('click');
    await settle();
    expect(page.el('status-answer').hidden).toBe(true);
    expect(page.el('status-request').value).toBe('');
  });

  it('an answer that arrives after leaving the screen is not shown', async () => {
    const g = gate();
    const { page, addr } = await start({ 'POST /api/status': () => g.promise.then(() => answered()) });
    fill(page, 'status', { request: 'x' });
    page.el('status-form').fire('submit');
    await settle();
    addr.change('#/circles');
    await settle();
    g.release();
    await settle();
    expect(page.el('status-answer').hidden).toBe(true);
    expect(page.focused().id).toBe('circles-heading');
  });

  it('the home page and the navigation link to the screen', async () => {
    const { page, addr } = await start({}, '#/');
    expect(page.el('nav-status').getAttribute('href')).toBe('#/status');
    addr.change('#/status');
    await settle();
    expect(page.el('nav-status').getAttribute('aria-current')).toBe('page');
    expect(page.el('nav-home').getAttribute('aria-current')).toBe(null);
  });
});
