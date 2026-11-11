import { describe, expect, it } from 'vitest';
import { fakePage, settle } from './fake-page.test-util.mjs';
import { mount } from './mount.js';

const C = 'c0000000000000001';
const C2 = 'c0000000000000002';
const U = (n) => `u${String(n).padStart(16, '0')}`;
const J = (n) => `j${String(n).padStart(16, '0')}`;
const R = (n) => `r${String(n).padStart(16, '0')}`;
const TOKEN = `cjoin_${'Ab1_-'.repeat(8)}Abc`;
const USER = { id: U(1), username: 'ann', displayName: 'Ann A' };
const circle = (role = 'owner', id = C) => ({ id, name: 'Team', role, memberCount: 3, createdAt: 1, updatedAt: 1 });
const member = (n, role = 'member') => ({ userId: U(n), username: `user${n}`, displayName: `User ${n}`, role, joinedAt: Date.UTC(2026, 0, n) });
const link = (n, extra = {}) => ({ id: J(n), role: 'member', label: `Link ${n}`, createdBy: { userId: U(1), displayName: 'Ann A' }, createdAt: Date.UTC(2026, 0, 1), expiresAt: Date.UTC(2026, 0, 8), maxUses: 3, uses: 1, approval: true, ...extra });
const request = (n, name = `Eve ${n}`) => ({ id: R(n), person: { displayName: name }, role: 'observer', createdAt: Date.UTC(2026, 0, 2), expiresAt: Date.UTC(2026, 0, 9) });
const pageOf = (items, nextCursor = null) => ({ status: 200, body: { items, nextCursor } });
const refuse = (status, code, message, extra = {}) => ({ status, body: { error: { code, message, ...extra } } });

function service(table = {}) {
  const calls = [];
  const fetchFn = async (path, init) => {
    const key = `${init.method} ${path}`;
    calls.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const entry = table[key] ?? (/^GET \/api\/(invitations|circles)\?/.test(key) ? pageOf([]) : refuse(401, 'UNAUTHENTICATED', 'not signed in'));
    const a = await (typeof entry === 'function' ? entry(calls.length) : entry);
    return { status: a.status, headers: { get: (n) => (a.headers && a.headers[n]) ?? null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { fetchFn, calls, keys: () => calls.map((c) => c.key) };
}
function address(initial = '') {
  let hash = initial;
  const listeners = [];
  const env = { getHash: () => hash, getOrigin: () => 'https://caci.example', setHash: (h) => { hash = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  return { env, change: (h) => env.setHash(h) };
}
const LINKS = `GET /api/circles/${C}/join-links?limit=100`;
const REQUESTS = `GET /api/circles/${C}/join-requests?limit=100`;
const base = (role = 'owner', extra = {}) => ({
  'GET /api/me': { status: 200, body: { user: USER } },
  [`GET /api/circles/${C}`]: { status: 200, body: { circle: circle(role) } },
  [`GET /api/circles/${C2}`]: { status: 200, body: { circle: circle(role, C2) } },
  [`GET /api/circles/${C}/members?limit=50`]: pageOf([member(1, 'owner'), member(2)]),
  [`GET /api/circles/${C2}/members?limit=50`]: pageOf([member(1, 'owner')]),
  [`GET /api/circles/${C}/invitations?limit=50`]: pageOf([]),
  [LINKS]: pageOf([link(1), link(2, { label: 'Second', role: 'observer', approval: false, maxUses: 1, uses: 0 })]),
  [REQUESTS]: pageOf([request(1), request(2, 'Fay')]),
  ...extra,
});
async function start(table, hash = `#/circles/${C}`) {
  const page = fakePage();
  const svc = service(table);
  const addr = address(hash);
  mount(page.document, svc.fetchFn, addr.env);
  await settle();
  return { page, svc, addr };
}
const slot = (row, name) => row.querySelector(`[data-slot="${name}"]`);
const links = (page) => page.el('join-links-list').children;
const waiting = (page) => page.el('join-requests-list').children;
const shown = async (table, hash) => {
  const s = await start(table, hash);
  s.page.el('join-load').fire('click');
  await settle();
  return s;
};
const fillForm = (page, values) => {
  const all = { label: 'Group chat', role: 'observer', days: '7', uses: '1', approval: 'yes', ...values };
  for (const [k, v] of Object.entries(all)) page.el(`join-${k}`).value = v;
};
const submit = async (page) => {
  page.el('join-form').fire('submit');
  await settle();
};
const made = (extra = {}) => ({ status: 201, body: { token: TOKEN, link: link(9, { label: 'Group chat', role: 'observer', maxUses: 1, uses: 0, ...extra }) } });

describe('who sees the section, and when anything is asked', () => {
  it('owners and managers see it, members and observers do not, and nothing is requested before they ask', async () => {
    for (const [role, visible] of [['owner', true], ['manager', true], ['member', false], ['observer', false]]) {
      const { page, svc } = await start(base(role));
      expect(page.el('join-section').hidden, role).toBe(!visible);
      expect(page.el('join-load').hidden).toBe(false);
      expect(page.el('join-body').hidden).toBe(true);
      expect(page.el('join-note').textContent).toContain('A link is shown only once');
      expect(svc.keys().filter((k) => /join-/.test(k)), role).toEqual([]);
    }
  });

  it('is hidden while the circle is loading, and hides again when a demotion shows on a refresh', async () => {
    let role = 'owner';
    const { page } = await start(base('owner', { [`GET /api/circles/${C}`]: () => ({ status: 200, body: { circle: circle(role) } }) }));
    expect(page.el('join-section').hidden).toBe(false);
    role = 'member';
    page.el('circle-refresh').fire('click');
    await settle();
    expect(page.el('join-section').hidden).toBe(true);
  });
});

describe('showing the links', () => {
  it('loads the links and the waiting requests, moves the focus to the heading and shows them in words', async () => {
    const { page, svc } = await shown(base());
    expect(svc.keys().filter((k) => /join-/.test(k))).toEqual([LINKS, REQUESTS]);
    expect(page.focused().id).toBe('join-heading');
    expect(page.el('join-load').hidden).toBe(true);
    expect(page.el('join-body').hidden).toBe(false);
    expect([...links(page)].map((r) => slot(r, 'title').textContent)).toEqual(['Link 1', 'Second']);
    expect([...links(page)].map((r) => slot(r, 'meta').textContent)).toEqual(['Offers: Member · 1 of 3 uses used · each person needs approval · ends 2026-01-08', 'Offers: Observer · 0 of 1 use used · joins at once · ends 2026-01-08']);
    expect(slot(links(page)[0], 'revoke').getAttribute('aria-label')).toBe('Withdraw the link Link 1');
    expect([...waiting(page)].map((r) => slot(r, 'title').textContent)).toEqual(['Eve 1', 'Fay']);
    expect(slot(waiting(page)[0], 'meta').textContent).toBe('Wants to join as: Observer · asked 2026-01-02 · lapses 2026-01-09');
    expect(slot(waiting(page)[0], 'approve').getAttribute('aria-label')).toBe('Approve Eve 1');
    expect(slot(waiting(page)[1], 'decline').getAttribute('aria-label')).toBe('Decline Fay');
    expect(page.el('join-links-empty').hidden).toBe(true);
    expect(page.el('join-requests-empty').hidden).toBe(true);
    expect(page.el('join-created').hidden).toBe(true);
  });

  it('says Loading while it asks', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { page } = await start(base('owner', { [LINKS]: async () => (await gate, pageOf([])) }));
    page.el('join-load').fire('click');
    await settle();
    expect(page.el('join-status').hidden).toBe(false);
    expect(page.el('join-status').textContent).toBe('Loading…');
    release();
    await settle();
    expect(page.el('join-status').hidden).toBe(true);
  });

  it('says so when there are none', async () => {
    const { page } = await shown(base('owner', { [LINKS]: pageOf([]), [REQUESTS]: pageOf([]) }));
    expect(page.el('join-links-empty').textContent).toBe('There are no live join links.');
    expect(page.el('join-links-empty').hidden).toBe(false);
    expect(page.el('join-requests-empty').textContent).toBe('Nobody is waiting to join.');
    expect(page.el('join-requests-empty').hidden).toBe(false);
    expect(page.el('join-links-list').hidden).toBe(true);
  });

  it('a service with join links off says so and shows nothing; other failures are in words', async () => {
    const off = await shown(base('owner', { [LINKS]: refuse(404, 'NOT_FOUND', 'not found') }));
    expect(off.page.el('join-error').textContent).toBe('Join links are not switched on in this service.');
    expect(off.page.el('join-body').hidden).toBe(true);
    const broken = await shown(base('owner', { [REQUESTS]: refuse(500, 'STORAGE_ERROR', 'x') }));
    expect(broken.page.el('join-error').textContent).toBe('Something went wrong on the service. Try again in a moment.');
    expect(broken.page.el('join-body').hidden).toBe(true);
    expect(broken.page.el('join-links-list').children).toEqual([]);
    expect(broken.page.focused().id).toBe('join-error');
  });

  it('labels and names are only text', async () => {
    const hostile = '<img src=x onerror=1><b>x</b>';
    const { page } = await shown(base('owner', { [LINKS]: pageOf([link(1, { label: hostile })]), [REQUESTS]: pageOf([request(1, hostile)]) }));
    expect(slot(links(page)[0], 'title').textContent).toBe(hostile);
    expect(slot(links(page)[0], 'title').children).toEqual([]);
    expect(slot(waiting(page)[0], 'title').textContent).toBe(hostile);
    expect(slot(links(page)[0], 'revoke').getAttribute('aria-label')).toBe(`Withdraw the link ${hostile}`);
  });

  it('Refresh reloads both lists', async () => {
    const { page, svc } = await shown(base());
    page.el('join-refresh').fire('click');
    await settle();
    expect(svc.keys().filter((k) => /join-/.test(k))).toEqual([LINKS, REQUESTS, LINKS, REQUESTS]);
    expect(page.focused().id).toBe('join-heading');
  });
});

describe('making a link', () => {
  it('starts with the defaults in the form', async () => {
    const { page } = await shown(base());
    expect(['label', 'role', 'days', 'uses', 'approval'].map((f) => page.el(`join-${f}`).value)).toEqual(['', 'observer', '7', '1', 'yes']);
  });

  it('sends the form as the service wants it, shows the address once with the origin, resets the form and moves the focus to the address', async () => {
    const { page, svc } = await shown(base('owner', { 'POST /api/circles/c0000000000000001/join-links': made() }));
    fillForm(page, { label: '  Group chat  ', role: 'member', days: '14', uses: '5', approval: 'no' });
    await submit(page);
    expect(svc.calls.find((c) => c.key.startsWith('POST') && c.key.endsWith('join-links'))?.body).toEqual({ label: 'Group chat', role: 'member', days: 14, uses: 5, approval: false });
    expect(page.el('join-created').hidden).toBe(false);
    expect(page.el('join-created-url').textContent).toBe(`https://caci.example/#/join/${TOKEN}`);
    expect(page.el('join-created-words').textContent).toContain('It is not shown again');
    expect(page.focused().id).toBe('join-created-url');
    expect(['label', 'role', 'days', 'uses', 'approval'].map((f) => page.el(`join-${f}`).value)).toEqual(['', 'observer', '7', '1', 'yes']);
    expect(page.el('join-notice').textContent).toContain('shown only this once');
    expect(svc.keys().filter((k) => k === LINKS)).toHaveLength(2); // loaded, then reloaded after making one
  });

  it('the address is in no list and goes when it is dismissed, with the focus back on the form', async () => {
    const { page } = await shown(base('owner', { 'POST /api/circles/c0000000000000001/join-links': made() }));
    fillForm(page, {});
    await submit(page);
    const all = () => JSON.stringify([...links(page)].map((r) => [slot(r, 'title').textContent, slot(r, 'meta').textContent]));
    expect(all()).not.toContain('cjoin_');
    page.el('join-created-done').fire('click');
    expect(page.el('join-created').hidden).toBe(true);
    expect(page.el('join-created-url').textContent).toBe('');
    expect(page.focused().id).toBe('join-label');
    expect(page.el('join-notice').hidden).toBe(true);
  });

  it('asks nothing of the service and names every wrong field when the form is wrong, with the focus on the first', async () => {
    const { page, svc } = await shown(base());
    fillForm(page, { label: '', days: 'abc', uses: '0' });
    await submit(page);
    expect(svc.calls.some((c) => c.key.startsWith('POST'))).toBe(false);
    expect(page.el('join-label-error').hidden).toBe(false);
    expect(page.el('join-days-error').textContent).toBe('Days is a whole number from 1 to 30.');
    expect(page.el('join-uses-error').textContent).toBe('Uses is a whole number from 1 to 100.');
    expect(page.el('join-role-error').hidden).toBe(true);
    expect(page.el('join-label').getAttribute('aria-invalid')).toBe('true');
    expect(page.focused().id).toBe('join-label');
    fillForm(page, { label: 'ok', days: '7', uses: '1' });
    svc.calls.length = 0;
    await submit(page); // 401 for the missing POST route in this table, but the old marks are cleared first
    expect(page.el('join-label-error').hidden).toBe(true);
    expect(page.el('join-label').getAttribute('aria-invalid')).toBeNull();
  });

  it('accepts numbers only as whole digits', async () => {
    const { page, svc } = await shown(base());
    for (const days of ['7.5', '-1', '1e1', ' ', '0x7', '9999999']) {
      fillForm(page, { days });
      await submit(page);
      expect(page.el('join-days-error').hidden, days).toBe(false);
    }
    expect(svc.calls.some((c) => c.key.startsWith('POST'))).toBe(false);
  });

  it('shows the service\'s refusal beside its field, or at the top when it names none', async () => {
    const field = await shown(base('owner', { 'POST /api/circles/c0000000000000001/join-links': refuse(422, 'INVALID_INPUT', 'label must be 1 to 80 characters', { field: 'label' }) }));
    fillForm(field.page, {});
    await submit(field.page);
    expect(field.page.el('join-label-error').textContent).toBe('label must be 1 to 80 characters');
    expect(field.page.el('join-created').hidden).toBe(true);
    const limit = await shown(base('owner', { 'POST /api/circles/c0000000000000001/join-links': refuse(429, 'LIMIT_REACHED', 'a circle may have at most 20 live join links') }));
    fillForm(limit.page, {});
    await submit(limit.page);
    expect(limit.page.el('join-error').textContent).toBe('a circle may have at most 20 live join links');
  });

  it('is disabled while a request is out', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { page } = await shown(base('owner', { 'POST /api/circles/c0000000000000001/join-links': async () => (await gate, made()) }));
    fillForm(page, {});
    page.el('join-form').fire('submit');
    await settle();
    expect(page.el('join-submit').disabled).toBe(true);
    expect(page.el('join-refresh').disabled).toBe(true);
    release();
    await settle();
    expect(page.el('join-submit').disabled).toBe(false);
  });
});

describe('withdrawing a link', () => {
  const del = (n) => `DELETE /api/circles/${C}/join-links/${J(n)}`;

  it('asks first with the focus on Cancel; Cancel changes nothing and returns the focus; Yes withdraws, says so and reloads', async () => {
    let gone = false;
    const { page, svc } = await shown(base('owner', { [del(1)]: () => ((gone = true), { status: 204 }), [LINKS]: () => pageOf(gone ? [link(2)] : [link(1), link(2)]) }));
    slot(links(page)[0], 'revoke').fire('click');
    expect(slot(links(page)[0], 'ask').hidden).toBe(false);
    expect(slot(links(page)[0], 'revoke').hidden).toBe(true);
    expect(slot(links(page)[0], 'askText').textContent).toBe('Withdraw the link "Link 1"? It stops working at once. Requests already made stay waiting.');
    expect(page.focused()).toBe(slot(links(page)[0], 'no'));
    slot(links(page)[0], 'no').fire('click');
    expect(slot(links(page)[0], 'ask').hidden).toBe(true);
    expect(page.focused()).toBe(slot(links(page)[0], 'revoke'));
    expect(svc.keys().some((k) => k.startsWith('DELETE'))).toBe(false);
    slot(links(page)[0], 'revoke').fire('click');
    slot(links(page)[0], 'yes').fire('click');
    await settle();
    expect(svc.keys()).toContain(del(1));
    expect([...links(page)].map((r) => slot(r, 'title').textContent)).toEqual(['Link 2']);
    expect(page.el('join-notice').textContent).toContain('withdrawn');
    expect(page.focused().id).toBe('join-notice');
  });

  it('while something else is being loaded the question\'s Yes is disabled', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    let calls = 0;
    const { page } = await shown(base('owner', { [LINKS]: async () => (++calls > 1 ? (await gate, pageOf([link(1)])) : pageOf([link(1)])) }));
    slot(links(page)[0], 'revoke').fire('click');
    expect(slot(links(page)[0], 'yes').disabled).toBe(false);
    page.el('join-refresh').fire('click');
    await settle();
    expect(slot(links(page)[0], 'yes').disabled).toBe(true);
    release();
    await settle();
  });

  it('a refusal is shown in the service\'s words with the focus on it', async () => {
    const { page } = await shown(base('owner', { [del(1)]: refuse(403, 'FORBIDDEN', 'x') }));
    slot(links(page)[0], 'revoke').fire('click');
    slot(links(page)[0], 'yes').fire('click');
    await settle();
    expect(page.el('join-error').textContent).toBe('Your role in this circle does not allow that.');
    expect(page.focused().id).toBe('join-error');
  });
});

describe('waiting requests', () => {
  const post = (n, what) => `POST /api/circles/${C}/join-requests/${R(n)}/${what}`;

  it('approving says who, reloads the requests, refreshes the roster and moves the focus to the notice', async () => {
    let done = false;
    const { page, svc } = await shown(base('owner', { [post(1, 'approve')]: () => ((done = true), { status: 200, body: { member: member(3, 'observer') } }), [REQUESTS]: () => pageOf(done ? [request(2, 'Fay')] : [request(1), request(2, 'Fay')]) }));
    const before = svc.keys().filter((k) => k === `GET /api/circles/${C}/members?limit=50`).length;
    slot(waiting(page)[0], 'approve').fire('click');
    await settle();
    expect(svc.keys()).toContain(post(1, 'approve'));
    expect(page.el('join-notice').textContent).toBe('Approved: Eve 1 is now a observer.');
    expect(page.focused().id).toBe('join-notice');
    expect([...waiting(page)].map((r) => slot(r, 'title').textContent)).toEqual(['Fay']);
    expect(svc.keys().filter((k) => k === `GET /api/circles/${C}/members?limit=50`).length).toBe(before + 1); // the roster is up to date
  });

  it('declining says who and reloads, and the roster is left alone', async () => {
    let done = false;
    const { page, svc } = await shown(base('owner', { [post(2, 'decline')]: () => ((done = true), { status: 204 }), [REQUESTS]: () => pageOf(done ? [request(1)] : [request(1), request(2, 'Fay')]) }));
    const before = svc.keys().filter((k) => k === `GET /api/circles/${C}/members?limit=50`).length;
    slot(waiting(page)[1], 'decline').fire('click');
    await settle();
    expect(page.el('join-notice').textContent).toBe('Declined: Fay was not added.');
    expect([...waiting(page)].map((r) => slot(r, 'title').textContent)).toEqual(['Eve 1']);
    expect(svc.keys().filter((k) => k === `GET /api/circles/${C}/members?limit=50`).length).toBe(before);
  });

  it('a full circle shows the service\'s limit, leaves the request waiting and puts the focus on the requests', async () => {
    const { page } = await shown(base('owner', { [post(1, 'approve')]: refuse(429, 'LIMIT_REACHED', 'a circle may have at most 4 people') }));
    slot(waiting(page)[0], 'approve').fire('click');
    await settle();
    expect(page.el('join-error').textContent).toBe('a circle may have at most 4 people');
    expect(waiting(page)).toHaveLength(2);
    expect(page.focused().id).toBe('join-requests-heading');
  });

  it('a request someone else dealt with shows the words and the list as it is now', async () => {
    let reloaded = false;
    const { page } = await shown(base('owner', { [post(1, 'approve')]: () => ((reloaded = true), refuse(404, 'NOT_FOUND', 'no such join request')), [REQUESTS]: () => pageOf(reloaded ? [request(2, 'Fay')] : [request(1), request(2, 'Fay')]) }));
    slot(waiting(page)[0], 'approve').fire('click');
    await settle();
    expect(page.el('join-error').textContent).toBe('No such request: it may have been approved, declined or have lapsed.');
    expect([...waiting(page)].map((r) => slot(r, 'title').textContent)).toEqual(['Fay']);
  });

  it('the buttons are disabled while a request is out', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { page } = await shown(base('owner', { [post(1, 'approve')]: async () => (await gate, { status: 200, body: { member: member(3) } }) }));
    slot(waiting(page)[0], 'approve').fire('click');
    await settle();
    expect(slot(waiting(page)[0], 'approve').disabled).toBe(true);
    expect(slot(waiting(page)[1], 'decline').disabled).toBe(true);
    expect(slot(links(page)[0], 'revoke').disabled).toBe(true);
    release();
    await settle();
  });
});

describe('leaving the screen', () => {
  it('clears what was typed in the form, even in the hidden section', async () => {
    const { page, addr } = await shown(base());
    fillForm(page, { label: 'half typed', days: '9' });
    addr.change('#/circles');
    await settle();
    expect(['label', 'days'].map((f) => page.el(`join-${f}`).value)).toEqual(['', '7']);
  });

  it('forgets everything, a new link\'s address included, and another circle starts clean', async () => {
    const { page, addr } = await shown(base('owner', { 'POST /api/circles/c0000000000000001/join-links': made() }));
    fillForm(page, {});
    await submit(page);
    expect(page.el('join-created-url').textContent).toContain(TOKEN);
    addr.change('#/circles');
    await settle();
    expect(page.el('join-section').hidden).toBe(true);
    expect(page.el('join-created-url').textContent).toBe('');
    expect(page.el('join-links-list').children).toEqual([]);
    addr.change(`#/circles/${C}`);
    await settle();
    expect(page.el('join-body').hidden).toBe(true);
    expect(page.el('join-load').hidden).toBe(false);
    expect(page.el('join-created-url').textContent).toBe('');
    addr.change(`#/circles/${C2}`);
    await settle();
    expect(page.el('join-body').hidden).toBe(true);
    expect(page.el('join-created').hidden).toBe(true);
  });

  it('signing out forgets it too', async () => {
    const { page } = await shown(base('owner', { 'POST /api/circles/c0000000000000001/join-links': made(), 'POST /api/logout': { status: 204 } }));
    fillForm(page, {});
    await submit(page);
    page.el('signout').fire('click');
    await settle();
    expect(page.el('join-created-url').textContent).toBe('');
    expect(page.el('join-body').hidden).toBe(true);
  });
});

describe('my waiting requests on the Invitations screen', () => {
  const MINE = `GET /api/join-requests?limit=100`;
  const mine = (n, name = 'Team') => ({ id: R(n), circle: { name }, role: 'member', createdAt: Date.UTC(2026, 0, 2), expiresAt: Date.UTC(2026, 0, 9) });
  const open = async (table) => {
    const s = await start({ 'GET /api/me': { status: 200, body: { user: USER } }, ...table }, '#/invitations');
    return s;
  };

  it('asks nothing until the person asks, then lists them in words with the focus on the heading', async () => {
    const { page, svc } = await open({ [MINE]: pageOf([mine(1), mine(2, 'Club')]) });
    expect(svc.keys()).not.toContain(MINE);
    expect(page.el('my-requests-note').textContent).toContain('an owner or manager of that circle decides');
    expect(page.el('my-requests-load').textContent).toBe('Show my waiting requests');
    page.el('my-requests-load').fire('click');
    await settle();
    expect(svc.keys()).toContain(MINE);
    expect(page.focused().id).toBe('my-requests-heading');
    const rows = page.el('my-requests-list').children;
    expect([...rows].map((r) => slot(r, 'title').textContent)).toEqual(['Team', 'Club']);
    expect(slot(rows[0], 'meta').textContent).toBe('You asked to join as: Member · asked 2026-01-02 · lapses 2026-01-09');
    expect(page.el('my-requests-load').textContent).toBe('Refresh my waiting requests');
    expect(page.el('my-requests-empty').hidden).toBe(true);
  });

  it('the button is disabled and says Loading while it asks', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { page } = await open({ [MINE]: async () => (await gate, pageOf([])) });
    page.el('my-requests-load').fire('click');
    await settle();
    expect(page.el('my-requests-load').disabled).toBe(true);
    expect(page.el('my-requests-status').textContent).toBe('Loading…');
    release();
    await settle();
    expect(page.el('my-requests-load').disabled).toBe(false);
  });

  it('says so when there are none, and when join links are off, and when the load fails', async () => {
    const none = await open({ [MINE]: pageOf([]) });
    none.page.el('my-requests-load').fire('click');
    await settle();
    expect(none.page.el('my-requests-empty').textContent).toBe('You have no requests waiting.');
    expect(none.page.el('my-requests-empty').hidden).toBe(false);
    const off = await open({ [MINE]: refuse(404, 'NOT_FOUND', 'not found') });
    off.page.el('my-requests-load').fire('click');
    await settle();
    expect(off.page.el('my-requests-error').textContent).toBe('Join links are not switched on in this service.');
    expect(off.page.el('my-requests-list').children).toEqual([]);
    const broken = await open({ [MINE]: refuse(500, 'STORAGE_ERROR', 'x') });
    broken.page.el('my-requests-load').fire('click');
    await settle();
    expect(broken.page.el('my-requests-error').textContent).toBe('Something went wrong on the service. Try again in a moment.');
    expect(broken.page.focused().id).toBe('my-requests-error');
  });

  it('names are only text, and the list is forgotten on leaving the screen', async () => {
    const hostile = '<img src=x onerror=1><b>x</b>';
    const { page, addr } = await open({ [MINE]: pageOf([mine(1, hostile)]) });
    page.el('my-requests-load').fire('click');
    await settle();
    const row = page.el('my-requests-list').children[0];
    expect(slot(row, 'title').textContent).toBe(hostile);
    expect(slot(row, 'title').children).toEqual([]);
    addr.change('#/circles');
    await settle();
    addr.change('#/invitations');
    await settle();
    expect(page.el('my-requests-list').children).toEqual([]);
    expect(page.el('my-requests-load').textContent).toBe('Show my waiting requests');
  });
});
