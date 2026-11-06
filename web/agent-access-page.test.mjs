import { describe, expect, it } from 'vitest';
import { CREATED_WORDS, EXPLAIN, keyDetails, NO_KEYS, REVOKE_QUESTION, WARNING } from './agent-access-page.js';
import { fakePage, settle } from './fake-page.test-util.mjs';
import { userHooks } from './user-hooks.js';
import { mountUser } from './user-mount.js';

const USER = { id: 'u0000000000000001', username: 'ann', displayName: 'Ann A' };
const C1 = 'c0000000000000001';
const TOKEN = `cpat_${'B'.repeat(43)}`;
const key = (id, name, extra = {}) => ({ id, name, scopes: ['personal'], checks: false, createdAt: Date.UTC(2026, 10, 1), expiresAt: Date.UTC(2027, 0, 30), lastUsedAt: null, ...extra });
const gate = () => {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
};

function service({ keys = [], agentAccess = true } = {}) {
  const state = { keys: [...keys], agentAccess, created: [], revoked: [], hold: undefined, createReply: undefined, scopes: [{ scope: { kind: 'personal' }, canCapture: true }, { scope: { kind: 'circle', circleId: C1, circleName: 'Club <b>x</b>' }, role: 'member', canCapture: true }] };
  const calls = [];
  const fetchFn = async (path, init) => {
    const k = `${init.method} ${path}`;
    calls.push(k);
    let reply = { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'not signed in' } } };
    if (k === 'GET /api/me') reply = { status: 200, body: { user: USER, graphId: 'x' } };
    else if (k === 'GET /api/capture/mode') reply = { status: 200, body: { mode: 'demo' } };
    else if (k === 'POST /api/logout') reply = { status: 204 };
    else if (k === 'GET /api/brain/scopes') reply = { status: 200, body: { items: state.scopes } };
    else if (path.startsWith('/api/me/agent-tokens')) {
      if (!state.agentAccess) reply = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'not found' } } };
      else if (state.hold) {
        await state.hold.promise;
        reply = { status: 200, body: { items: state.keys } };
      } else if (init.method === 'GET') reply = { status: 200, body: { items: state.keys } };
      else if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        state.created.push(body);
        reply = state.createReply ?? { status: 201, body: { token: TOKEN, agentToken: key('t0000000000000009', body.name, { scopes: body.scopes, checks: body.checks }) } };
        if (reply.status === 201) state.keys = [reply.body.agentToken, ...state.keys];
      } else if (init.method === 'DELETE') {
        const id = path.split('/').pop();
        state.revoked.push(id);
        state.keys = state.keys.filter((x) => x.id !== id);
        reply = { status: 204 };
      }
    }
    return { status: reply.status, headers: { get: () => null }, text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)) };
  };
  return { state, calls, fetchFn };
}
function address(initial = '#/settings') {
  let hash = initial;
  const listeners = [];
  const env = { getHash: () => hash, setHash: (h) => { hash = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  return { env, go: (h) => env.setHash(h) };
}
async function start(options = {}, hash = '#/settings') {
  const page = fakePage('user.html');
  const svc = service(options);
  const addr = address(hash);
  mountUser(page.document, svc.fetchFn, addr.env, (ctx) => userHooks(page.document, svc.fetchFn, ctx));
  await settle();
  // the stand-in select has no default value; a real one starts at 90 days
  page.el('agent-days').value = '90';
  return { page, svc, addr };
}
const rows = (page) => page.el('agent-list').children;
const slot = (row, name) => row.querySelector(`[data-slot="${name}"]`);
const boxes = (page) => page.el('agent-brains').children.map((r) => slot(r, 'box'));
const labels = (page) => page.el('agent-brains').children.map((r) => slot(r, 'label').textContent);
const make = async (page, { name = 'Desk assistant', tick = [0] } = {}) => {
  page.el('agent-name').value = name;
  boxes(page).forEach((b, i) => (b.checked = tick.includes(i)));
  page.el('agent-form').fire('submit');
  await settle();
};

describe('the words', () => {
  it('say what it is, that it is one way, and that what the agent reads leaves CaCi', () => {
    expect(EXPLAIN).toMatch(/one way/);
    expect(EXPLAIN).toMatch(/never change anything/);
    expect(WARNING).toBe("Anything your agent reads is sent to your agent's provider, the company that runs it. CaCi cannot take it back.");
    expect(CREATED_WORDS('Desk')).toContain('shown only now');
    expect(CREATED_WORDS('Desk')).toContain('"Desk"');
    expect(REVOKE_QUESTION('Desk')).toContain('"Desk"');
    expect(NO_KEYS).toBe('You have not made any access keys.');
  });

  it('describe a key: what it reads (by name), whether it may ask for checks, when it ends, and when it was last used', () => {
    const labels = new Map([['personal', 'My own notes'], [`circle:${C1}`, 'Circle "Club"']]);
    expect(keyDetails(key('t1', 'a', { scopes: ['personal', `circle:${C1}`], checks: true, lastUsedAt: Date.UTC(2026, 10, 2, 9, 30) }), labels)).toBe('Can read: My own notes, Circle "Club". May also ask CaCi for attention checks. Ends 2027-01-30. Last used 2026-11-02 09:30 UTC.');
    expect(keyDetails(key('t1', 'a'), labels)).toBe('Can read: My own notes. Ends 2027-01-30. Not used yet.');
    expect(keyDetails(key('t1', 'a', { scopes: ['circle:c0000000000000099'] }), labels)).toContain('A circle you were in');
  });
});

describe('the Agent access part of Settings', () => {
  it('is not there at all when the service has agent access off', async () => {
    const { page, svc } = await start({ agentAccess: false });
    expect(page.el('agent-access').hidden).toBe(true);
    expect(svc.calls.filter((c) => c.includes('agent-tokens'))).toEqual(['GET /api/me/agent-tokens']);
  });

  it('asks nothing until Settings is shown, then shows the words, the choices and the keys', async () => {
    const { page, svc, addr } = await start({ keys: [key('t0000000000000001', 'First'), key('t0000000000000002', '<img src=x onerror=alert(1)>', { checks: true })] }, '#/');
    expect(svc.calls.some((c) => c.includes('agent-tokens'))).toBe(false);
    expect(page.el('agent-access').hidden).toBe(true);
    addr.go('#/settings');
    await settle();
    expect(page.el('agent-access').hidden).toBe(false);
    expect(page.el('agent-explain').textContent).toBe(EXPLAIN);
    expect(page.el('agent-warning').textContent).toBe(WARNING);
    expect(labels(page)).toEqual(['My own notes', 'Circle "Club <b>x</b>"']); // markup in a name stays text
    expect(rows(page)).toHaveLength(2);
    expect(slot(rows(page)[1], 'name').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(slot(rows(page)[1], 'details').textContent).toContain('May also ask CaCi for attention checks.');
    expect(page.el('agent-empty').hidden).toBe(true);
  });

  it('takes the circles from the navigation\'s own read (once per screen, none of its own), as they are when Settings is shown', async () => {
    const { page, svc, addr } = await start({}, '#/');
    expect(svc.calls.filter((c) => c === 'GET /api/brain/scopes')).toHaveLength(1);
    svc.state.scopes = [{ scope: { kind: 'personal' }, canCapture: true }, { scope: { kind: 'circle', circleId: 'c0000000000000002', circleName: 'New circle' }, role: 'owner', canCapture: true }];
    addr.go('#/settings');
    await settle();
    expect(svc.calls.filter((c) => c === 'GET /api/brain/scopes')).toHaveLength(2); // one read for the screen, shared with Settings
    expect(labels(page)).toEqual(['My own notes', 'Circle "New circle"']);
    svc.state.scopes = [{ scope: { kind: 'personal' }, canCapture: true }];
    addr.go('#/');
    await settle();
    addr.go('#/settings');
    await settle();
    expect(labels(page)).toEqual(['My own notes']); // a circle the person has left is no longer offered
  });

  it('says when there are no keys', async () => {
    const { page } = await start();
    expect(page.el('agent-empty').hidden).toBe(false);
    expect(page.el('agent-empty').textContent).toBe(NO_KEYS);
  });

  it('makes a key: sends the four fields, shows the key once with the warning words, empties the form and moves the focus to the key', async () => {
    const { page, svc } = await start();
    page.el('agent-checks').checked = true;
    await make(page, { name: '  Desk assistant ', tick: [0, 1] });
    expect(svc.state.created).toEqual([{ name: 'Desk assistant', scopes: ['personal', `circle:${C1}`], checks: true, days: 90 }]);
    expect(page.el('agent-created').hidden).toBe(false);
    expect(page.el('agent-created-token').value).toBe(TOKEN);
    expect(page.el('agent-created-words').textContent).toBe(CREATED_WORDS('Desk assistant'));
    expect(page.focused()).toBe(page.el('agent-created-token'));
    expect(page.el('agent-name').value).toBe('');
    expect(page.el('agent-checks').checked).toBe(false);
    expect(boxes(page).every((b) => b.checked === false)).toBe(true);
    expect(page.el('agent-notice').textContent).toContain('Copy it now');
    expect(rows(page)).toHaveLength(1);
    expect(JSON.stringify(rows(page).map((r) => slot(r, 'details').textContent))).not.toContain('cpat_');
    page.el('agent-created-done').fire('click');
    expect(page.el('agent-created').hidden).toBe(true);
    expect(page.el('agent-created-token').value).toBe('');
    expect(page.focused()).toBe(page.el('agent-name'));
  });

  it('prevents the form from being posted, and helps early: a name, notes to read, and a length of time', async () => {
    const { page, svc } = await start();
    page.el('agent-name').value = '';
    boxes(page)[0].checked = true;
    page.el('agent-form').fire('submit');
    await settle();
    expect(page.el('agent-form').prevented).toBe(true);
    expect(page.el('agent-name-error').hidden).toBe(false);
    expect(page.el('agent-name').getAttribute('aria-invalid')).toBe('true');
    expect(page.focused()).toBe(page.el('agent-name'));
    await make(page, { name: 'ok', tick: [] });
    expect(page.el('agent-brains-error').hidden).toBe(false);
    expect(page.el('agent-brains-error').textContent).toMatch(/at least one/i);
    expect(page.focused()).toBe(boxes(page)[0]);
    page.el('agent-days').value = '';
    await make(page, { name: 'ok', tick: [0] });
    expect(page.el('agent-days-error').hidden).toBe(false);
    expect(page.focused()).toBe(page.el('agent-days'));
    expect(svc.state.created).toEqual([]); // nothing was sent
    page.el('agent-days').value = '90';
    await make(page, { name: 'ok', tick: [0] });
    expect(page.el('agent-name-error').hidden).toBe(true); // an old problem is cleared by the next try
    expect(page.el('agent-brains-error').hidden).toBe(true);
    expect(page.el('agent-days-error').hidden).toBe(true);
    expect(svc.state.created).toHaveLength(1);
    expect(svc.state.created[0].checks).toBe(false); // not ticked, so not asked for
    expect(page.el('agent-name').getAttribute('aria-invalid')).toBeNull(); // and the mark of the old problem is gone
  });

  it('shows what the service says when it refuses (a full list), at the top, with the focus there, and keeps what was typed', async () => {
    const { page, svc } = await start();
    svc.state.createReply = { status: 409, body: { error: { code: 'CONFLICT', message: 'you already have the most agent tokens allowed (10): revoke one first' } } };
    await make(page, { name: 'Another', tick: [0] });
    expect(page.el('agent-error').hidden).toBe(false);
    expect(page.el('agent-error').textContent).toContain('most agent tokens');
    expect(page.focused()).toBe(page.el('agent-error'));
    expect(page.el('agent-name').value).toBe('Another');
    expect(boxes(page)[0].checked).toBe(true);
    expect(page.el('agent-created').hidden).toBe(true);
  });

  it('stops a key only after asking: the question takes the focus, Cancel returns it, Yes stops it and lists again', async () => {
    const { page, svc } = await start({ keys: [key('t0000000000000001', 'First'), key('t0000000000000002', 'Second')] });
    const stop = slot(rows(page)[0], 'revoke');
    expect(stop.getAttribute('aria-label')).toBe('Stop the key First');
    stop.fire('click');
    expect(page.el('agent-revoke-confirm').hidden).toBe(false);
    expect(page.el('agent-revoke-text').textContent).toBe(REVOKE_QUESTION('First'));
    expect(page.focused()).toBe(page.el('agent-revoke-no'));
    expect(svc.state.revoked).toEqual([]);
    page.el('agent-revoke-no').fire('click');
    expect(page.el('agent-revoke-confirm').hidden).toBe(true);
    expect(page.focused()).toBe(stop);
    slot(rows(page)[0], 'revoke').fire('click');
    page.el('agent-revoke-yes').fire('click');
    await settle();
    expect(svc.state.revoked).toEqual(['t0000000000000001']);
    expect(rows(page)).toHaveLength(1);
    expect(slot(rows(page)[0], 'name').textContent).toBe('Second');
    expect(page.el('agent-revoke-confirm').hidden).toBe(true);
    expect(page.el('agent-notice').textContent).toContain('Stopped "First"');
    expect(page.focused()).toBe(page.el('agent-heading'));
  });

  it('forgets a new key when the person leaves Settings or signs out', async () => {
    const { page, addr } = await start();
    await make(page);
    expect(page.el('agent-created-token').value).toBe(TOKEN);
    addr.go('#/');
    await settle();
    expect(page.el('agent-access').hidden).toBe(true);
    expect(page.el('agent-created-token').value).toBe('');
    addr.go('#/settings');
    await settle();
    expect(page.el('agent-created').hidden).toBe(true); // it does not come back
    await make(page);
    page.el('signout').fire('click');
    await settle();
    expect(page.el('agent-created-token').value).toBe('');
    expect(page.el('agent-access').hidden).toBe(true);
  });

  it('keeps the ticks the person made while nothing changes, and disables the controls while a request is out', async () => {
    const { page, svc, addr } = await start({ keys: [key('t0000000000000001', 'First')] });
    boxes(page)[1].checked = true;
    addr.go('#/');
    await settle();
    addr.go('#/settings');
    await settle();
    expect(boxes(page)).toHaveLength(2); // drawn again after leaving, so ticks start clean
    boxes(page)[1].checked = true;
    svc.state.hold = gate();
    page.el('agent-name').value = 'x';
    const pending = page.el('agent-form').fire('submit');
    await settle();
    expect(page.el('agent-submit').disabled).toBe(true);
    expect(slot(rows(page)[0], 'revoke').disabled).toBe(true); // a key cannot be stopped while a request is out
    expect(page.el('agent-form').getAttribute('aria-busy')).toBe('true');
    svc.state.hold.release();
    await pending;
    await settle();
    expect(page.el('agent-submit').disabled).toBe(false);
  });
});
