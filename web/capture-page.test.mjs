import { describe, expect, it } from 'vitest';
import { fakePage, fill, settle, visibleScreens } from './fake-page.test-util.mjs';
import { mount } from './mount.js';

const USER = { id: 'u0000000000000001', username: 'ann', displayName: 'Ann A' };
const P = 'prop-0abc12345-00-abcdef';
const SUMMARY = { newItems: ['note-1'], updatedItems: [], newCategories: ['health'], updatedCategories: [], reusedCategories: [], newLinks: [{ item: 'note-1', category: 'health' }], problems: [], notes: [] };
const OPS = [{ op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 'Blood test', summary: 'S' } }, { op: 'upsertNode', partition: 'category', id: 'health', data: { name: 'Health' } }, { op: 'link', item: 'note-1', category: 'health', weight: 0.9 }];
const PROPOSAL = (extra = {}) => ({ id: P, createdAt: Date.UTC(2026, 9, 9, 14, 0), expiresAt: Date.UTC(2026, 9, 9, 14, 15), mode: 'demo', text: 'New items\n  note-1', summary: SUMMARY, operations: OPS, rationale: 'Because it is about health.', ...extra });
const refuse = (status, code, message, extra = {}) => ({ status, body: { error: { code, message, ...extra } } });
const proposed = (extra) => ({ status: 201, body: { proposal: PROPOSAL(extra) } });
const written = { status: 200, body: { written: { id: P, applied: 3, summary: SUMMARY } } };
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
  return { fetchFn, calls, keys: () => calls.map((c) => c.key) };
}
function address(initial = '') {
  let hash = initial;
  const listeners = [];
  const env = { getHash: () => hash, setHash: (h) => { hash = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  return { env, get: () => hash, change: (h) => env.setHash(h) };
}
const ME = { 'GET /api/me': { status: 200, body: { user: USER } }, 'GET /api/capture/mode': { status: 200, body: { mode: 'demo' } } };
async function start(table = {}, hash = '#/capture') {
  const page = fakePage();
  const svc = service({ ...ME, ...table });
  const addr = address(hash);
  mount(page.document, svc.fetchFn, addr.env);
  await settle();
  return { page, svc, addr };
}
const rows = (page, id) => page.el(id).children;
const text = (row) => row.querySelector('[data-slot="text"]').textContent;
const propose = async (page, note = 'Dr Patel booked my blood test') => {
  fill(page, 'capture', { note });
  page.el('capture-form').fire('submit');
  await settle();
};

describe('the capture screen before anything is sent', () => {
  it('shows the screen, takes the focus and the title, and says which model files notes before a note is sent', async () => {
    const { page, svc } = await start();
    expect(page.el('view-capture').hidden).toBe(false);
    expect(page.document.title).toBe('Capture – CaCi');
    expect(page.focused().id).toBe('capture-heading');
    expect(page.el('capture-mode-notice').textContent).toBe('Filed by the free demo model: nothing leaves this machine.');
    expect(page.el('capture-form-section').hidden).toBe(false);
    expect(page.el('capture-submit').disabled).toBe(false);
    expect(page.el('capture-mode-retry').hidden).toBe(true);
    expect(page.el('capture-count').textContent).toBe('0 / 8,000');
    expect(svc.keys()).toContain('GET /api/capture/mode');
    expect(svc.keys().some((k) => k.startsWith('POST'))).toBe(false);
  });

  it('says the other mode too, with what is sent and that it is not anonymised', async () => {
    const { page } = await start({ 'GET /api/capture/mode': { status: 200, body: { mode: 'anthropic' } } });
    expect(page.el('capture-mode-notice').textContent).toBe("Filed by Anthropic's model: your note and the names of your categories are sent to Anthropic and are not anonymised.");
  });

  it('while the mode is unknown nothing can be proposed, and the person can try again', async () => {
    let n = 0;
    const { page, svc } = await start({ 'GET /api/capture/mode': () => (++n === 1 ? refuse(500, 'STORAGE_ERROR', 'x') : { status: 200, body: { mode: 'demo' } }) });
    expect(page.el('capture-mode-notice').textContent).toBe('Could not tell which model files your notes.');
    expect(page.el('capture-submit').disabled).toBe(true);
    expect(page.el('capture-mode-retry').hidden).toBe(false);
    fill(page, 'capture', { note: 'a note' });
    page.el('capture-form').fire('submit');
    await settle();
    expect(svc.keys().some((k) => k.startsWith('POST'))).toBe(false);
    page.el('capture-mode-retry').fire('click');
    await settle();
    expect(page.el('capture-mode-notice').textContent).toBe('Filed by the free demo model: nothing leaves this machine.');
    expect(page.el('capture-submit').disabled).toBe(false);
    expect(page.el('capture-mode-retry').hidden).toBe(true);
  });

  it('shows the checking line while the mode is being read', async () => {
    const g = gate();
    const { page } = await start({ 'GET /api/capture/mode': () => g.promise });
    expect(page.el('capture-mode-notice').textContent).toBe('Checking which model files your notes…');
    expect(page.el('capture-submit').disabled).toBe(true);
    g.release({ status: 200, body: { mode: 'demo' } });
    await settle();
    expect(page.el('capture-submit').disabled).toBe(false);
  });

  it('the count follows what is typed, counted as characters', async () => {
    const { page } = await start();
    page.el('capture-note').value = '😀😀😀';
    page.el('capture-note').fire('input');
    expect(page.el('capture-count').textContent).toBe('3 / 8,000');
  });
});

describe('proposing', () => {
  it('an empty note is refused beside the box with the focus there and nothing is sent', async () => {
    const { page, svc } = await start();
    await propose(page, '   ');
    expect(page.el('capture-note-error').hidden).toBe(false);
    expect(page.el('capture-note-error').textContent).toBe('Write a note first.');
    expect(page.el('capture-note').getAttribute('aria-invalid')).toBe('true');
    expect(page.focused().id).toBe('capture-note');
    expect(svc.keys().some((k) => k.startsWith('POST'))).toBe(false);
  });

  it('sends the trimmed note and shows the preview as text: the service\'s text, the operations, the reason, the mode and the expiry; nothing is written', async () => {
    const { page, svc } = await start({ 'POST /api/capture/propose': proposed() });
    await propose(page, '  Dr Patel booked my blood test  ');
    expect(svc.calls.find((c) => c.key === 'POST /api/capture/propose').body).toEqual({ text: 'Dr Patel booked my blood test' });
    expect(page.el('capture-preview').hidden).toBe(false);
    expect(page.el('capture-form-section').hidden).toBe(true);
    expect(page.focused().id).toBe('capture-preview-heading');
    expect(page.el('capture-preview-notice').textContent).toBe('Filed by the free demo model: nothing leaves this machine.');
    expect(page.el('capture-text').textContent).toBe('New items\n  note-1');
    expect(rows(page, 'capture-ops').map(text)).toEqual(['Add or update item note-1 "Blood test"', 'Add or update category health "Health"', 'Link item note-1 to category health (weight 0.9)']);
    expect(page.el('capture-rationale').textContent).toBe('Why: Because it is about health.');
    expect(page.el('capture-expires').textContent).toBe('Expires 2026-10-09 14:15 UTC. After that it is forgotten and nothing is written.');
    expect(svc.keys().some((k) => k.includes('approve'))).toBe(false);
  });

  it('problems and notes in the summary are listed so a person can see approving may be refused', async () => {
    const { page } = await start({ 'POST /api/capture/propose': proposed({ summary: { ...SUMMARY, problems: ['link to a category that is not there'], notes: ['repeats an earlier link'] } }) });
    await propose(page);
    expect(rows(page, 'capture-lines').map(text)).toEqual(['Problem: link to a category that is not there', 'Note: repeats an earlier link']);
  });

  it('a missing rationale is not shown', async () => {
    const { page } = await start({ 'POST /api/capture/propose': proposed({ rationale: undefined }) });
    await propose(page);
    expect(page.el('capture-rationale').hidden).toBe(true);
  });

  it('markup in the note, the model\'s text and a name stays text', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { page } = await start({ 'POST /api/capture/propose': proposed({ text: evil, rationale: evil, operations: [{ op: 'upsertNode', partition: 'item', id: evil, data: { title: evil } }] }) });
    await propose(page, evil);
    expect(page.el('capture-text').textContent).toBe(evil);
    expect(page.el('capture-rationale').textContent).toBe(`Why: ${evil}`);
    expect(text(rows(page, 'capture-ops')[0])).toBe(`Add or update item ${evil} "${evil}"`);
    expect(page.el('capture-text').children).toEqual([]);
  });

  it('the service\'s refusals show at the top in its words, with the wait, and the note stays in the box', async () => {
    const cases = [
      [refuse(429, 'THROTTLED', 'you have made the most proposals allowed in an hour', {}), 'you have made the most proposals allowed in an hour'],
      [{ ...refuse(429, 'TOO_MANY_PENDING', 'you have too many proposals waiting: approve or reject one first'), headers: { 'retry-after': '90' } }, 'you have too many proposals waiting: approve or reject one first Try again in 90 seconds.'],
      [refuse(502, 'MODEL_TIMEOUT', 'the model took too long: try again'), 'the model took too long: try again'],
      [refuse(502, 'MODEL_REFUSED', 'the model declined to file this note'), 'the model declined to file this note'],
      [{ ...refuse(503, 'MODEL_BUSY', 'the model is busy: try again shortly'), headers: { 'retry-after': '30' } }, 'the model is busy: try again shortly Try again in 30 seconds.'],
    ];
    for (const [answer, words] of cases) {
      const { page } = await start({ 'POST /api/capture/propose': answer });
      await propose(page, 'my note');
      expect(page.el('capture-error').hidden).toBe(false);
      expect(page.el('capture-error').textContent).toBe(words);
      expect(page.focused().id).toBe('capture-error');
      expect(page.el('capture-note').value).toBe('my note');
      expect(page.el('capture-preview').hidden).toBe(true);
    }
  });

  it('a second try clears the old message', async () => {
    let n = 0;
    const { page } = await start({ 'POST /api/capture/propose': () => (++n === 1 ? refuse(502, 'MODEL_ERROR', 'the model could not file this note: try again') : proposed()) });
    await propose(page, 'my note');
    expect(page.el('capture-error').hidden).toBe(false);
    await propose(page, 'my note');
    expect(page.el('capture-error').hidden).toBe(true);
    expect(page.el('capture-preview').hidden).toBe(false);
  });

  it('while a request is out the controls are disabled and a second submit does nothing', async () => {
    const g = gate();
    const { page, svc } = await start({ 'POST /api/capture/propose': () => g.promise });
    fill(page, 'capture', { note: 'a note' });
    page.el('capture-form').fire('submit');
    await settle();
    expect(page.el('capture-submit').disabled).toBe(true);
    expect(page.el('capture-note').disabled).toBe(true);
    expect(page.el('capture-form').getAttribute('aria-busy')).toBe('true');
    page.el('capture-form').fire('submit');
    await settle();
    expect(page.el('capture-error').hidden).toBe(true);
    expect(svc.keys().filter((k) => k === 'POST /api/capture/propose')).toHaveLength(1);
    g.release(proposed());
    await settle();
    expect(page.el('capture-preview').hidden).toBe(false);
  });
});

describe('approving and rejecting', () => {
  const t = (extra = {}) => ({ 'POST /api/capture/propose': proposed(), ...extra });

  it('approving writes, says how many operations and what they were, clears the note, and takes the focus', async () => {
    const { page, svc } = await start(t({ [`POST /api/capture/proposals/${P}/approve`]: written }));
    await propose(page, 'my note');
    page.el('capture-approve').fire('click');
    await settle();
    expect(svc.keys()).toContain(`POST /api/capture/proposals/${P}/approve`);
    expect(page.el('capture-outcome').hidden).toBe(false);
    expect(page.el('capture-outcome-text').textContent).toBe('Written: 3 operations (1 new item, 1 new category, 1 link).');
    expect(page.el('capture-preview').hidden).toBe(true);
    expect(page.el('capture-note').value).toBe('');
    expect(page.focused().id).toBe('capture-outcome-heading');
  });

  it('rejecting writes nothing, says so, and keeps the note for editing', async () => {
    const { page, svc } = await start(t({ [`POST /api/capture/proposals/${P}/reject`]: { status: 204 } }));
    await propose(page, 'my note');
    page.el('capture-reject').fire('click');
    await settle();
    expect(svc.keys()).not.toContain(`POST /api/capture/proposals/${P}/approve`);
    expect(page.el('capture-outcome-text').textContent).toBe('Rejected. Nothing was written.');
    expect(page.el('capture-note').value).toBe('my note');
    expect(page.focused().id).toBe('capture-outcome-heading');
  });

  it('"File another note" shows the form again with the focus in the box', async () => {
    const { page } = await start(t({ [`POST /api/capture/proposals/${P}/reject`]: { status: 204 } }));
    await propose(page, 'my note');
    page.el('capture-reject').fire('click');
    await settle();
    page.el('capture-again').fire('click');
    expect(page.el('capture-outcome').hidden).toBe(true);
    expect(page.el('capture-form-section').hidden).toBe(false);
    expect(page.focused().id).toBe('capture-note');
  });

  it('a refused write shows the service\'s words, keeps the proposal and the focus on the message', async () => {
    const { page } = await start(t({ [`POST /api/capture/proposals/${P}/approve`]: refuse(409, 'WRITE_REFUSED', 'this proposal can no longer be applied') }));
    await propose(page);
    page.el('capture-approve').fire('click');
    await settle();
    expect(page.el('capture-action-error').hidden).toBe(false);
    expect(page.el('capture-action-error').textContent).toBe('this proposal can no longer be applied');
    expect(page.focused().id).toBe('capture-action-error');
    expect(page.el('capture-preview').hidden).toBe(false);
    expect(page.el('capture-approve').disabled).toBe(false);
  });

  it('an expired proposal and one the service forgot end in words and write nothing', async () => {
    for (const answer of [refuse(410, 'EXPIRED', 'that proposal has expired: make it again'), refuse(404, 'NOT_FOUND', 'no such proposal')]) {
      const { page } = await start(t({ [`POST /api/capture/proposals/${P}/approve`]: answer }));
      await propose(page, 'my note');
      page.el('capture-approve').fire('click');
      await settle();
      expect(page.el('capture-outcome').hidden).toBe(false);
      expect(page.el('capture-outcome-text').textContent).toBe('That proposal is gone or has expired. Make it again.');
      expect(page.el('capture-preview').hidden).toBe(true);
      expect(page.el('capture-note').value).toBe('my note');
      expect(page.focused().id).toBe('capture-outcome-heading');
    }
  });

  it('a failed reject (the service is down) keeps the proposal with the words', async () => {
    const { page } = await start(t({ [`POST /api/capture/proposals/${P}/reject`]: refuse(500, 'STORAGE_ERROR', 'x') }));
    await propose(page);
    page.el('capture-reject').fire('click');
    await settle();
    expect(page.el('capture-preview').hidden).toBe(false);
    expect(page.el('capture-action-error').hidden).toBe(false);
    expect(page.focused().id).toBe('capture-action-error');
  });

  it('a reject of a proposal that has gone ends in the outcome', async () => {
    const { page } = await start(t({ [`POST /api/capture/proposals/${P}/reject`]: refuse(404, 'NOT_FOUND', 'no such proposal') }));
    await propose(page);
    page.el('capture-reject').fire('click');
    await settle();
    expect(page.el('capture-outcome').hidden).toBe(false);
    expect(page.el('capture-outcome-text').textContent).toBe('That proposal is gone or has expired. Make it again.');
  });

  it('the buttons are disabled while a request is out, and an older message goes on the next try', async () => {
    const g = gate();
    let n = 0;
    const { page } = await start(t({ [`POST /api/capture/proposals/${P}/approve`]: () => (++n === 1 ? refuse(409, 'WRITE_REFUSED', 'no') : g.promise) }));
    await propose(page);
    page.el('capture-approve').fire('click');
    await settle();
    expect(page.el('capture-action-error').hidden).toBe(false);
    page.el('capture-approve').fire('click');
    await settle();
    expect(page.el('capture-action-error').hidden).toBe(true);
    expect(page.el('capture-approve').disabled).toBe(true);
    expect(page.el('capture-reject').disabled).toBe(true);
    g.release(written);
    await settle();
    expect(page.el('capture-outcome').hidden).toBe(false);
  });
});

describe('details the first mutation run found', () => {
  it('the invalid mark goes with the next try', async () => {
    const { page } = await start({ 'POST /api/capture/propose': proposed() });
    await propose(page, '   ');
    expect(page.el('capture-note').getAttribute('aria-invalid')).toBe('true');
    await propose(page, 'a real note');
    expect(page.el('capture-note').getAttribute('aria-invalid')).toBeNull();
    expect(page.el('capture-note-error').hidden).toBe(true);
  });

  it('an older message goes on the next reject, and a reject of a gone proposal moves the focus to the outcome without an error', async () => {
    let n = 0;
    const { page } = await start({ 'POST /api/capture/propose': proposed(), [`POST /api/capture/proposals/${P}/reject`]: () => (++n === 1 ? refuse(500, 'STORAGE_ERROR', 'x') : { status: 204 }) });
    await propose(page);
    page.el('capture-reject').fire('click');
    await settle();
    expect(page.el('capture-action-error').hidden).toBe(false);
    page.el('capture-reject').fire('click');
    await settle();
    expect(page.el('capture-action-error').hidden).toBe(true);
    const gone = await start({ 'POST /api/capture/propose': proposed(), [`POST /api/capture/proposals/${P}/reject`]: refuse(404, 'NOT_FOUND', 'no such proposal') });
    await propose(gone.page);
    gone.page.el('capture-reject').fire('click');
    await settle();
    expect(gone.page.el('capture-action-error').hidden).toBe(true);
    expect(gone.page.focused().id).toBe('capture-outcome-heading');
  });

  it('leaving the screen forgets old messages too', async () => {
    const { page, addr } = await start({ 'POST /api/capture/propose': refuse(502, 'MODEL_ERROR', 'the model could not file this note: try again') });
    await propose(page, 'my note');
    expect(page.el('capture-error').hidden).toBe(false);
    addr.change('#/');
    await settle();
    addr.change('#/capture');
    await settle();
    expect(page.el('capture-error').hidden).toBe(true);
    expect(page.el('capture-note-error').hidden).toBe(true);
  });
});

describe('leaving clears the action message and the invalid mark', () => {
  it('a refused approval and an empty note do not follow the person to the next visit', async () => {
    const { page, addr } = await start({ 'POST /api/capture/propose': proposed(), [`POST /api/capture/proposals/${P}/approve`]: refuse(409, 'WRITE_REFUSED', 'no') });
    await propose(page, '   ');
    expect(page.el('capture-note').getAttribute('aria-invalid')).toBe('true');
    await propose(page, 'my note');
    page.el('capture-approve').fire('click');
    await settle();
    expect(page.el('capture-action-error').hidden).toBe(false);
    addr.change('#/');
    await settle();
    addr.change('#/capture');
    await settle();
    expect(page.el('capture-action-error').hidden).toBe(true);
    expect(page.el('capture-action-error').textContent).toBe('');
    await propose(page, '   ');
    expect(page.el('capture-note').getAttribute('aria-invalid')).toBe('true');
    addr.change('#/');
    await settle();
    addr.change('#/capture');
    await settle();
    expect(page.el('capture-note').getAttribute('aria-invalid')).toBeNull();
  });
});

describe('leaving and signing out', () => {
  it('going to another screen forgets the proposal and the typed note; coming back asks the mode again', async () => {
    const { page, addr, svc } = await start({ 'POST /api/capture/propose': proposed() });
    await propose(page, 'my note');
    expect(page.el('capture-preview').hidden).toBe(false);
    addr.change('#/');
    await settle();
    addr.change('#/capture');
    await settle();
    expect(page.el('capture-preview').hidden).toBe(true);
    expect(page.el('capture-note').value).toBe('');
    expect(page.el('capture-form-section').hidden).toBe(false);
    expect(svc.keys().filter((k) => k === 'GET /api/capture/mode')).toHaveLength(2);
  });

  it('signing out forgets everything, and signing in as someone else starts clean', async () => {
    const { page } = await start({ 'POST /api/capture/propose': proposed(), 'POST /api/logout': { status: 204 } });
    await propose(page, 'my note');
    page.el('nav-home').fire('click');
    page.el('signout').fire('click');
    await settle();
    expect(visibleScreens(page)).toEqual(['signed-out']);
    expect(page.el('capture-preview').hidden).toBe(true);
    expect(page.el('capture-note').value).toBe('');
    expect(rows(page, 'capture-ops')).toHaveLength(0);
  });

  it('a note typed and not sent is not kept when the screen is left', async () => {
    const { page, addr } = await start();
    fill(page, 'capture', { note: 'half typed' });
    addr.change('#/brain');
    await settle();
    expect(page.el('capture-note').value).toBe('');
  });

  it('mounting fails loudly if the page lacks an element the capture screen needs', () => {
    const page = fakePage();
    const broken = { title: '', getElementById: (id) => (id === 'capture-approve' ? null : page.document.getElementById(id)) };
    expect(() => mount(broken, service().fetchFn)).toThrow(/no element "capture-approve"/);
  });
});
