import { describe, expect, it } from 'vitest';
import { fakePage, fill, settle, visibleScreens } from './fake-page.test-util.mjs';
import { mount } from './mount.js';

const C = 'c0000000000000001';
const U = (n) => `u${String(n).padStart(16, '0')}`;
const I = (n) => `i${String(n).padStart(16, '0')}`;
const ME = U(1);
const USER = { id: ME, username: 'ann', displayName: 'Ann A' };
const circle = (role = 'owner', extra = {}) => ({ id: C, name: 'Team', description: 'About us', role, memberCount: 3, createdAt: 1, updatedAt: 1, ...extra });
const member = (n, role = 'member', extra = {}) => ({ userId: U(n), username: `user${n}`, displayName: `User ${n}`, role, joinedAt: Date.UTC(2026, 0, n), ...extra });
const inv = (n, role = 'member') => ({ id: I(n), username: `guest${n}`, role, invitedBy: { userId: U(1), displayName: 'Ann A' }, createdAt: 1, expiresAt: Date.UTC(2026, 0, 20) });
const pageOf = (items, nextCursor = null) => ({ status: 200, body: { items, nextCursor } });
const refuse = (status, code, message, extra = {}) => ({ status, body: { error: { code, message, ...extra } } });
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
    const entry = table[key] ?? (/^GET \/api\/(invitations|circles)\?/.test(key) ? pageOf([]) : refuse(401, 'UNAUTHENTICATED', 'not signed in'));
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

const base = (role, members, invitations, extra = {}) => ({
  'GET /api/me': { status: 200, body: { user: USER } },
  [`GET /api/circles/${C}`]: { status: 200, body: { circle: circle(role) } },
  [`GET /api/circles/${C}/members?limit=50`]: pageOf(members),
  [`GET /api/circles/${C}/invitations?limit=50`]: pageOf(invitations),
  ...extra,
});
const OWNER_MEMBERS = [member(1, 'owner'), member(2, 'manager'), member(3, 'member'), member(4, 'observer')];
async function start(table, hash = `#/circles/${C}`) {
  const page = fakePage();
  const svc = service(table);
  const addr = address(hash);
  mount(page.document, svc.fetchFn, addr.env);
  await settle();
  return { page, svc, addr };
}
const rows = (page, list = 'members-list') => page.el(list).children;
const slot = (row, name) => row.querySelector(`[data-slot="${name}"]`);
const nameRow = (page, text) => rows(page).find((r) => slot(r, 'name').textContent.startsWith(text));
const options = (row) => ['owner', 'manager', 'member', 'observer'].filter((r) => !slot(row, `opt-${r}`).hidden && !slot(row, `opt-${r}`).disabled);

describe('what an owner sees', () => {
  it('the details, their role in plain words, the notices, the people, the forms and the destructive buttons', async () => {
    const { page } = await start(base('owner', OWNER_MEMBERS, [inv(1), inv(2, 'manager')]));
    expect(visibleScreens(page)).toEqual(['signed-in']);
    expect(page.el('view-circle').hidden).toBe(false);
    expect(page.el('circle-body').hidden).toBe(false);
    expect(page.el('circle-heading').textContent).toBe('Team');
    expect(page.focused().id).toBe('circle-heading');
    expect(page.el('circle-description').textContent).toBe('About us');
    expect(page.el('circle-role').textContent).toBe('Your role: owner');
    expect(page.el('circle-role-words').textContent).toBe('Everything: rename and delete the circle, invite and remove anyone, give anyone any role, including owner.');
    expect(page.el('rename-section').hidden).toBe(false);
    expect(page.el('rename-name').value).toBe('Team');
    expect(page.el('rename-description').value).toBe('About us');
    expect(page.el('invite-section').hidden).toBe(false);
    expect(page.el('circle-invitations-section').hidden).toBe(false);
    expect(page.el('delete-button').hidden).toBe(false);
    expect(page.el('leave-button').hidden).toBe(false);
    for (const id of ['leave-confirm', 'delete-confirm', 'circle-error', 'circle-gone', 'members-error']) expect(page.el(id).hidden, id).toBe(true);

    const list = rows(page);
    expect(list).toHaveLength(4);
    expect(slot(list[0], 'name').textContent).toBe('User 1 (you)');
    expect(slot(list[0], 'meta').textContent).toBe('@user1 · Owner · joined 2026-01-01');
    expect(slot(list[0], 'roleWords').textContent).toContain('Everything');
    expect(slot(list[0], 'manage').hidden).toBe(true); // nothing beside your own row
    for (const i of [1, 2, 3]) expect(slot(list[i], 'manage').hidden, `row ${i}`).toBe(false);
    expect(options(list[1])).toEqual(['owner', 'manager', 'member', 'observer']);
    expect(slot(list[1], 'role').value).toBe('manager');
    expect(slot(list[3], 'role').value).toBe('observer');
    expect(page.el('invite-role-owner').hidden).toBe(false);
    expect(page.el('invite-role-words').textContent).toBe('Everything: rename and delete the circle, invite and remove anyone, give anyone any role, including owner.');

    const open = rows(page, 'circle-invitations-list');
    expect(open).toHaveLength(2);
    expect(slot(open[0], 'who').textContent).toBe('For guest1');
    expect(slot(open[0], 'meta').textContent).toBe('They would be: Member');
    expect(slot(open[0], 'from').textContent).toBe('Invited by Ann A');
    expect(slot(open[0], 'ends').textContent).toBe('Ends 2026-01-20');
    expect(slot(open[1], 'withdraw').hidden).toBe(false);
  });

  it('the page says circles share no data and members see each other\'s names', async () => {
    const { page } = await start(base('owner', [member(1, 'owner')], []));
    expect(page.el('circle-invitations-empty').hidden).toBe(false);
    expect(page.el('circle-invitations-empty').textContent).toBe('There are no open invitations.');
  });
});

describe('what a manager sees', () => {
  it('may invite members and observers only, and manage only members and observers', async () => {
    const { page } = await start(base('manager', [member(1, 'manager'), member(2, 'owner'), member(5, 'manager'), member(3, 'member'), member(4, 'observer')], [inv(1, 'member'), inv(2, 'manager'), inv(3, 'owner')]));
    expect(page.el('rename-section').hidden).toBe(false);
    expect(page.el('invite-section').hidden).toBe(false);
    expect(page.el('delete-button').hidden).toBe(true);
    expect(page.el('leave-button').hidden).toBe(false);
    for (const r of ['owner', 'manager']) {
      expect(page.el(`invite-role-${r}`).hidden).toBe(true);
      expect(page.el(`invite-role-${r}`).disabled).toBe(true);
    }
    for (const r of ['member', 'observer']) expect(page.el(`invite-role-${r}`).hidden).toBe(false);
    expect(page.el('invite-role').value).toBe('member');
    const list = rows(page);
    expect(list.map((r) => slot(r, 'manage').hidden)).toEqual([true, true, true, false, false]); // me, an owner, another manager: nothing
    expect(options(list[3])).toEqual(['member', 'observer']);
    const open = rows(page, 'circle-invitations-list');
    expect(open.map((r) => slot(r, 'withdraw').hidden)).toEqual([false, true, true]);
  });
});

describe('what a member or observer sees', () => {
  it('only the circle, the people and a way to leave', async () => {
    for (const role of ['member', 'observer']) {
      const { page, svc } = await start(base(role, [member(1, role), member(2, 'owner')], []));
      expect(page.el('circle-body').hidden).toBe(false);
      expect(page.el('rename-section').hidden).toBe(true);
      expect(page.el('invite-section').hidden).toBe(true);
      expect(page.el('circle-invitations-section').hidden).toBe(true);
      expect(page.el('delete-button').hidden).toBe(true);
      expect(page.el('leave-button').hidden).toBe(false);
      expect(rows(page).every((r) => slot(r, 'manage').hidden)).toBe(true);
      expect(svc.keys().some((k) => k.includes('/invitations?'))).toBe(false); // not even asked for
    }
  });
});

describe('a circle that cannot be shown', () => {
  it('is "no such circle" for a stranger and for a made-up one, with a way back', async () => {
    const { page } = await start({ 'GET /api/me': { status: 200, body: { user: USER } }, [`GET /api/circles/${C}`]: refuse(404, 'NOT_FOUND', 'no such circle') });
    expect(page.el('circle-gone').hidden).toBe(false);
    expect(page.el('circle-gone').textContent).toBe('No such circle, or you are not in it.');
    expect(page.el('circle-body').hidden).toBe(true);
    expect(page.el('circle-heading').textContent).toBe('Circle');
  });

  it('a failed load shows the problem and the body stays hidden; Refresh tries again', async () => {
    let n = 0;
    const { page } = await start({ 'GET /api/me': { status: 200, body: { user: USER } }, [`GET /api/circles/${C}`]: () => (++n === 1 ? refuse(500, 'STORAGE_ERROR', 'secret') : { status: 200, body: { circle: circle('member') } }), [`GET /api/circles/${C}/members?limit=50`]: pageOf([member(1, 'member')]) });
    expect(page.el('circle-error').hidden).toBe(false);
    expect(page.el('circle-error').textContent).not.toContain('secret');
    expect(page.el('circle-body').hidden).toBe(true);
    page.el('circle-refresh').fire('click');
    await settle();
    expect(page.el('circle-error').hidden).toBe(true);
    expect(page.el('circle-body').hidden).toBe(false);
  });

  it('a bad id in the address never reaches a path', async () => {
    const { svc, page } = await start({ 'GET /api/me': { status: 200, body: { user: USER } } }, '#/circles/..%2f..');
    expect(svc.keys().every((k) => !k.includes('..'))).toBe(true);
    expect(page.el('view-home').hidden).toBe(false);
  });
});

describe('rename and describe', () => {
  const t = (extra) => base('owner', OWNER_MEMBERS, [], extra);

  it('sends the values (an empty description removes it), says "Saved." with the focus there, and shows the new name', async () => {
    const { page, svc } = await start(t({ [`PATCH /api/circles/${C}`]: { status: 200, body: { circle: circle('owner', { name: 'New', updatedAt: 9, description: undefined }) } } }));
    fill(page, 'rename', { name: ' New ', description: '' });
    page.el('rename-form').fire('submit');
    await settle();
    expect(svc.calls.find((c) => c.key.startsWith('PATCH')).body).toEqual({ name: 'New', description: null });
    expect(page.el('rename-notice').hidden).toBe(false);
    expect(page.el('rename-notice').textContent).toBe('Saved.');
    expect(page.focused().id).toBe('rename-notice');
    expect(page.el('circle-heading').textContent).toBe('New');
    expect(page.el('circle-description').hidden).toBe(true);
  });

  it('an empty name is refused beside the field and nothing is sent; the service\'s field problem shows beside its field', async () => {
    const { page, svc } = await start(t({ [`PATCH /api/circles/${C}`]: refuse(422, 'INVALID_INPUT', 'name is not allowed', { field: 'name' }) }));
    fill(page, 'rename', { name: '' });
    page.el('rename-form').fire('submit');
    await settle();
    expect(page.el('rename-name-error').hidden).toBe(false);
    expect(page.el('rename-name').getAttribute('aria-invalid')).toBe('true');
    expect(page.focused().id).toBe('rename-name');
    expect(svc.keys().some((k) => k.startsWith('PATCH'))).toBe(false);
    fill(page, 'rename', { name: 'Team' });
    page.el('rename-form').fire('submit');
    await settle();
    expect(page.el('rename-name-error').textContent).toBe('name is not allowed');
    expect(page.el('rename-notice').hidden).toBe(true);
  });

  it('a refusal for rights shows the service\'s words at the top of the form and the view catches up with the role', async () => {
    let n = 0;
    const { page } = await start(t({ [`GET /api/circles/${C}`]: () => ({ status: 200, body: { circle: circle(++n === 1 ? 'owner' : 'member') } }), [`PATCH /api/circles/${C}`]: refuse(403, 'FORBIDDEN', 'x') }));
    fill(page, 'rename', { name: 'New' });
    page.el('rename-form').fire('submit');
    await settle();
    expect(page.el('rename-error').textContent).toBe('Your role in this circle does not allow that.');
    expect(page.focused().id).toBe('rename-error');
    expect(page.el('rename-section').hidden).toBe(true);
    expect(page.el('circle-role').textContent).toBe('Your role: member');
  });

  it('typing is not overwritten by a reload that changed nothing', async () => {
    const { page } = await start(t());
    fill(page, 'rename', { name: 'Half typed' });
    page.el('circle-refresh').fire('click');
    await settle();
    expect(page.el('rename-name').value).toBe('Half typed');
  });
});

describe('inviting', () => {
  const t = (extra) => base('owner', OWNER_MEMBERS, [], extra);

  it('sends the clean name and the chosen role; the notice names the username and nothing more; the list reloads', async () => {
    let n = 0;
    const { page, svc } = await start(t({ [`POST /api/circles/${C}/invitations`]: { status: 202, body: { invited: true } }, [`GET /api/circles/${C}/invitations?limit=50`]: () => pageOf(++n === 1 ? [] : [inv(1)]) }));
    fill(page, 'invite', { username: ' Bob ' });
    page.el('invite-role').value = 'manager';
    page.el('invite-form').fire('submit');
    await settle();
    expect(svc.calls.find((c) => c.key.startsWith('POST') && c.key.endsWith('/invitations')).body).toEqual({ username: 'bob', role: 'manager' });
    expect(page.el('invite-notice').textContent).toBe('Invitation recorded for "bob".');
    expect(page.el('invite-notice').hidden).toBe(false);
    expect(page.focused().id).toBe('invite-notice');
    expect(page.el('invite-username').value).toBe('');
    expect(rows(page, 'circle-invitations-list')).toHaveLength(1);
  });

  it('the notice is the same for a name with no account and the page never says whether one exists', async () => {
    const { page } = await start(t({ [`POST /api/circles/${C}/invitations`]: { status: 202, body: { invited: true } } }));
    fill(page, 'invite', { username: 'nobody.here' });
    page.el('invite-form').fire('submit');
    await settle();
    expect(page.el('invite-notice').textContent).toBe('Invitation recorded for "nobody.here".');
    const all = ['circle-error', 'invite-error', 'invite-username-error', 'members-error'].map((id) => page.el(id).textContent).join('');
    expect(all).toBe('');
  });

  it('a bad name is refused beside the field with no request; a role the person may not give is not even offered', async () => {
    const { page, svc } = await start(t());
    fill(page, 'invite', { username: 'x' });
    page.el('invite-form').fire('submit');
    await settle();
    expect(page.el('invite-username-error').hidden).toBe(false);
    expect(page.focused().id).toBe('invite-username');
    expect(svc.keys().some((k) => k.startsWith('POST'))).toBe(false);
  });

  it('the service\'s refusals show in its words: a full circle at the top, a field beside its field', async () => {
    const { page } = await start(t({ [`POST /api/circles/${C}/invitations`]: refuse(429, 'LIMIT_REACHED', 'That circle is full.') }));
    fill(page, 'invite', { username: 'bob' });
    page.el('invite-form').fire('submit');
    await settle();
    expect(page.el('invite-error').textContent).toBe('That circle is full.');
    expect(page.focused().id).toBe('invite-error');
    expect(page.el('invite-username').value).toBe('bob');
  });

  it('choosing a role shows what it means', async () => {
    const { page } = await start(t());
    page.el('invite-role').value = 'observer';
    page.el('invite-role').fire('change');
    expect(page.el('invite-role-words').textContent).toBe('The same as a member for now.');
    page.el('invite-role').value = 'manager';
    page.el('invite-role').fire('change');
    expect(page.el('invite-role-words').textContent).toContain('Never touches an owner or another manager.');
  });
});

describe('changing a role', () => {
  const t = (extra) => base('owner', OWNER_MEMBERS, [], extra);

  it('sends the chosen role, reloads the people and puts the focus on their heading', async () => {
    let n = 0;
    const { page, svc } = await start(t({ [`PATCH /api/circles/${C}/members/${U(3)}`]: { status: 200, body: { member: member(3, 'manager') } }, [`GET /api/circles/${C}/members?limit=50`]: () => pageOf(++n === 1 ? OWNER_MEMBERS : [member(1, 'owner'), member(2, 'manager'), member(3, 'manager'), member(4, 'observer')]) }));
    const row = nameRow(page, 'User 3');
    slot(row, 'role').value = 'manager';
    slot(row, 'save').fire('click');
    await settle();
    expect(svc.calls.find((c) => c.key.startsWith('PATCH')).body).toEqual({ role: 'manager' });
    expect(slot(nameRow(page, 'User 3'), 'role').value).toBe('manager');
    expect(page.focused().id).toBe('members-heading');
  });

  it('a refusal is shown in the service\'s words next to the people, with the focus there', async () => {
    const { page } = await start(t({ [`PATCH /api/circles/${C}/members/${U(3)}`]: refuse(409, 'LAST_OWNER', 'A circle must keep an owner.') }));
    const row = nameRow(page, 'User 3');
    slot(row, 'role').value = 'observer';
    slot(row, 'save').fire('click');
    await settle();
    expect(page.el('members-error').hidden).toBe(false);
    expect(page.el('members-error').textContent).toBe('A circle must keep an owner.');
    expect(page.focused().id).toBe('members-error');
  });

  it('a person who has left says so and the people reload', async () => {
    const { page } = await start(t({ [`PATCH /api/circles/${C}/members/${U(3)}`]: refuse(404, 'NOT_FOUND', 'x') }));
    slot(nameRow(page, 'User 3'), 'save').fire('click');
    await settle();
    expect(page.el('members-error').textContent).toBe('That person is no longer in this circle.');
  });
});

describe('removing someone (two steps)', () => {
  const t = (extra) => base('owner', OWNER_MEMBERS, [], extra);

  it('asking shows the question in that row with the focus on Cancel and sends nothing; Cancel closes it and returns the focus', async () => {
    const { page, svc } = await start(t());
    const sent = svc.calls.length;
    const row = nameRow(page, 'User 3');
    slot(row, 'remove').fire('click');
    const asked = nameRow(page, 'User 3');
    expect(slot(asked, 'removeAsk').hidden).toBe(false);
    expect(slot(asked, 'removeText').textContent).toBe('Remove User 3 from this circle? They will lose their place in it.');
    expect(slot(asked, 'manage').hidden).toBe(true);
    expect(slot(nameRow(page, 'User 2'), 'removeAsk').hidden).toBe(true);
    expect(page.focused()).toBe(slot(asked, 'removeNo'));
    expect(svc.calls.length).toBe(sent);
    slot(asked, 'removeNo').fire('click');
    const back = nameRow(page, 'User 3');
    expect(slot(back, 'removeAsk').hidden).toBe(true);
    expect(slot(back, 'manage').hidden).toBe(false);
    expect(page.focused()).toBe(slot(back, 'remove'));
    expect(svc.calls.length).toBe(sent);
  });

  it('confirming removes, reloads the people and moves the focus to their heading', async () => {
    let n = 0;
    const { page, svc } = await start(t({ [`DELETE /api/circles/${C}/members/${U(3)}`]: { status: 204 }, [`GET /api/circles/${C}/members?limit=50`]: () => pageOf(++n === 1 ? OWNER_MEMBERS : OWNER_MEMBERS.filter((m) => m.userId !== U(3))) }));
    slot(nameRow(page, 'User 3'), 'remove').fire('click');
    slot(nameRow(page, 'User 3'), 'removeYes').fire('click');
    await settle();
    expect(svc.keys()).toContain(`DELETE /api/circles/${C}/members/${U(3)}`);
    expect(rows(page)).toHaveLength(3);
    expect(page.focused().id).toBe('members-heading');
  });

  it('a refusal shows in the service\'s words and the question closes', async () => {
    const { page } = await start(t({ [`DELETE /api/circles/${C}/members/${U(3)}`]: refuse(403, 'FORBIDDEN', 'x') }));
    slot(nameRow(page, 'User 3'), 'remove').fire('click');
    slot(nameRow(page, 'User 3'), 'removeYes').fire('click');
    await settle();
    expect(page.el('members-error').textContent).toBe('Your role in this circle does not allow that.');
    expect(slot(nameRow(page, 'User 3'), 'removeAsk').hidden).toBe(true);
  });
});

describe('leaving and deleting (two steps)', () => {
  const t = (extra) => base('owner', OWNER_MEMBERS, [], extra);

  it('leaving asks first; Cancel changes nothing; Yes leaves and goes to the list', async () => {
    const { page, svc, addr } = await start(t({ [`POST /api/circles/${C}/leave`]: { status: 204 } }));
    page.el('leave-button').fire('click');
    expect(page.el('leave-confirm').hidden).toBe(false);
    expect(page.el('leave-confirm-text').textContent).toContain('you need a new invitation to come back');
    expect(page.el('leave-button').hidden).toBe(true);
    expect(page.focused().id).toBe('leave-no');
    expect(svc.keys().some((k) => k.endsWith('/leave'))).toBe(false);
    page.el('leave-no').fire('click');
    expect(page.el('leave-confirm').hidden).toBe(true);
    expect(page.el('leave-button').hidden).toBe(false);
    expect(page.focused().id).toBe('leave-button');
    page.el('leave-button').fire('click');
    page.el('leave-yes').fire('click');
    await settle();
    expect(svc.keys()).toContain(`POST /api/circles/${C}/leave`);
    expect(addr.get()).toBe('#/circles');
    expect(page.el('view-circles').hidden).toBe(false);
    expect(page.focused().id).toBe('circles-heading');
  });

  it('the only owner is told in the service\'s own words and stays on the circle', async () => {
    const { page, addr } = await start(t({ [`POST /api/circles/${C}/leave`]: refuse(409, 'LAST_OWNER', 'You are the only owner: make someone else an owner, or delete the circle.') }));
    page.el('leave-button').fire('click');
    page.el('leave-yes').fire('click');
    await settle();
    expect(page.el('circle-error').hidden).toBe(false);
    expect(page.el('circle-error').textContent).toBe('You are the only owner: make someone else an owner, or delete the circle.');
    expect(page.focused().id).toBe('circle-error');
    expect(addr.get()).toBe(`#/circles/${C}`);
    expect(page.el('leave-confirm').hidden).toBe(true);
    expect(page.el('circle-body').hidden).toBe(false);
  });

  it('deleting says what it removes, needs Yes, and goes to the list', async () => {
    const { page, svc, addr } = await start(t({ [`DELETE /api/circles/${C}`]: { status: 204 } }));
    page.el('delete-button').fire('click');
    expect(page.el('delete-confirm').hidden).toBe(false);
    expect(page.el('delete-confirm-text').textContent).toContain('removes the circle, its members and its invitations');
    expect(page.focused().id).toBe('delete-no');
    page.el('delete-no').fire('click');
    expect(page.focused().id).toBe('delete-button');
    expect(svc.keys()).not.toContain(`DELETE /api/circles/${C}`);
    page.el('delete-button').fire('click');
    page.el('delete-yes').fire('click');
    await settle();
    expect(svc.keys()).toContain(`DELETE /api/circles/${C}`);
    expect(addr.get()).toBe('#/circles');
  });

  it('a delete refused for rights shows the words and the view catches up', async () => {
    let n = 0;
    const { page } = await start(t({ [`GET /api/circles/${C}`]: () => ({ status: 200, body: { circle: circle(++n === 1 ? 'owner' : 'manager') } }), [`DELETE /api/circles/${C}`]: refuse(403, 'FORBIDDEN', 'x') }));
    page.el('delete-button').fire('click');
    page.el('delete-yes').fire('click');
    await settle();
    expect(page.el('circle-error').textContent).toBe('Your role in this circle does not allow that.');
    expect(page.el('delete-button').hidden).toBe(true);
    expect(page.el('circle-role').textContent).toBe('Your role: manager');
  });
});

describe('open invitations', () => {
  it('withdraw removes the row, and the focus goes to the section heading; a gone invitation says so', async () => {
    let n = 0;
    const { page, svc } = await start(base('owner', OWNER_MEMBERS, [], {
      [`GET /api/circles/${C}/invitations?limit=50`]: () => pageOf(++n === 1 ? [inv(1), inv(2)] : n === 2 ? [inv(2)] : []),
      [`DELETE /api/circles/${C}/invitations/${I(1)}`]: { status: 204 },
      [`DELETE /api/circles/${C}/invitations/${I(2)}`]: refuse(404, 'NOT_FOUND', 'x'),
    }));
    slot(rows(page, 'circle-invitations-list')[0], 'withdraw').fire('click');
    await settle();
    expect(svc.keys()).toContain(`DELETE /api/circles/${C}/invitations/${I(1)}`);
    expect(rows(page, 'circle-invitations-list')).toHaveLength(1);
    expect(page.focused().id).toBe('circle-invitations-heading');
    slot(rows(page, 'circle-invitations-list')[0], 'withdraw').fire('click');
    await settle();
    expect(page.el('circle-invitations-error').textContent).toBe('No such invitation: it may have been withdrawn, used or expired.');
    expect(page.focused().id).toBe('circle-invitations-error');
    expect(page.el('circle-invitations-empty').hidden).toBe(false);
  });

  it('show more adds the next page of people and of invitations', async () => {
    const { page } = await start(base('owner', [member(1, 'owner')], [inv(1)], {
      [`GET /api/circles/${C}/members?limit=50`]: pageOf([member(1, 'owner')], 'm2'),
      [`GET /api/circles/${C}/members?limit=50&cursor=m2`]: pageOf([member(2)]),
      [`GET /api/circles/${C}/invitations?limit=50`]: pageOf([inv(1)], 'i2'),
      [`GET /api/circles/${C}/invitations?limit=50&cursor=i2`]: pageOf([inv(2)]),
    }));
    expect(page.el('members-more').hidden).toBe(false);
    expect(page.el('circle-invitations-more').hidden).toBe(false);
    page.el('members-more').fire('click');
    await settle();
    page.el('circle-invitations-more').fire('click');
    await settle();
    expect(rows(page)).toHaveLength(2);
    expect(rows(page, 'circle-invitations-list')).toHaveLength(2);
    expect(page.el('members-more').hidden).toBe(true);
    expect(page.el('circle-invitations-more').hidden).toBe(true);
  });
});

describe('details the first mutation run found', () => {
  const flags = (page, row) => Object.fromEntries(['owner', 'manager', 'member', 'observer'].map((r) => [r, [slot(row, `opt-${r}`).hidden, slot(row, `opt-${r}`).disabled]]));

  it('shows a loading line, not the circle, while it loads', async () => {
    const g = gate();
    const { page } = await start(base('owner', OWNER_MEMBERS, [], { [`GET /api/circles/${C}`]: () => g.promise }));
    expect(page.el('circle-status').hidden).toBe(false);
    expect(page.el('circle-status').textContent).toBe('Loading…');
    expect(page.el('circle-body').hidden).toBe(true);
    g.release({ status: 200, body: { circle: circle('owner') } });
    await settle();
    expect(page.el('circle-status').hidden).toBe(true);
  });

  it('role choices: a role that may not be given is hidden and disabled, the person\'s own is always listed, and a row that cannot be changed has a disabled choice', async () => {
    const { page } = await start(base('manager', [member(1, 'manager'), member(2, 'owner'), member(3, 'member')], []));
    expect(flags(page, rows(page)[2])).toEqual({ owner: [true, true], manager: [true, true], member: [false, false], observer: [false, false] });
    expect(flags(page, rows(page)[1])).toEqual({ owner: [false, false], manager: [true, true], member: [true, true], observer: [true, true] });
    expect(slot(rows(page)[1], 'role').disabled).toBe(true);
    expect(slot(rows(page)[2], 'role').disabled).toBe(false);
  });

  it('"show more" for people is disabled while a request is out', async () => {
    const g = gate();
    const { page } = await start(base('owner', [member(1, 'owner')], [], { [`GET /api/circles/${C}/members?limit=50`]: pageOf([member(1, 'owner')], 'm2'), [`GET /api/circles/${C}/members?limit=50&cursor=m2`]: () => g.promise }));
    page.el('members-more').fire('click');
    await settle();
    expect(page.el('members-more').disabled).toBe(true);
    g.release(pageOf([]));
    await settle();
    expect(page.el('members-more').disabled).toBe(false);
  });

  it('an invitations list that cannot be loaded shows a problem, and the "none" text stays hidden then', async () => {
    const { page } = await start(base('owner', OWNER_MEMBERS, [], { [`GET /api/circles/${C}/invitations?limit=50`]: refuse(500, 'STORAGE_ERROR', 'x') }));
    expect(page.el('circle-invitations-error').hidden).toBe(false);
    expect(page.el('circle-invitations-error').textContent.length).toBeGreaterThan(5);
    expect(page.el('circle-invitations-empty').hidden).toBe(true);
  });

  it('with no open invitations the list is hidden and the "none" text shows', async () => {
    const { page } = await start(base('owner', OWNER_MEMBERS, []));
    expect(page.el('circle-invitations-list').hidden).toBe(true);
    expect(page.el('circle-invitations-empty').hidden).toBe(false);
    const { page: p2 } = await start(base('owner', OWNER_MEMBERS, [inv(1)]));
    expect(p2.el('circle-invitations-list').hidden).toBe(false);
    expect(p2.el('circle-invitations-empty').hidden).toBe(true);
  });

  it('the rename form: old messages go on the next try, and the name\'s problem gets the focus before the description\'s', async () => {
    const { page } = await start(base('owner', OWNER_MEMBERS, [], { [`PATCH /api/circles/${C}`]: { status: 200, body: { circle: circle('owner', { name: 'New', updatedAt: 5 }) } } }));
    fill(page, 'rename', { name: '', description: 'x'.repeat(501) });
    page.el('rename-form').fire('submit');
    await settle();
    expect(page.el('rename-name-error').hidden).toBe(false);
    expect(page.el('rename-description-error').hidden).toBe(false);
    expect(page.focused().id).toBe('rename-name');
    fill(page, 'rename', { name: 'New', description: '' });
    page.el('rename-form').fire('submit');
    await settle();
    expect(page.el('rename-name-error').hidden).toBe(true);
    expect(page.el('rename-description-error').hidden).toBe(true);
    expect(page.el('rename-name').getAttribute('aria-invalid')).toBeNull();
    expect(page.el('rename-notice').textContent).toBe('Saved.');
    fill(page, 'rename', { name: '' });
    page.el('rename-form').fire('submit');
    await settle();
    expect(page.el('rename-notice').hidden).toBe(true); // the old "Saved." goes with the next try
  });

  it('the invite form: the previous messages go on the next try, and the top message clears', async () => {
    let n = 0;
    const { page } = await start(base('owner', OWNER_MEMBERS, [], { [`POST /api/circles/${C}/invitations`]: () => (++n === 1 ? refuse(429, 'LIMIT_REACHED', 'Full.') : { status: 202, body: { invited: true } }) }));
    fill(page, 'invite', { username: 'bob' });
    page.el('invite-form').fire('submit');
    await settle();
    expect(page.el('invite-error').hidden).toBe(false);
    page.el('invite-form').fire('submit');
    await settle();
    expect(page.el('invite-error').hidden).toBe(true);
    expect(page.el('invite-notice').hidden).toBe(false);
    fill(page, 'invite', { username: 'x' });
    page.el('invite-form').fire('submit');
    await settle();
    expect(page.el('invite-notice').hidden).toBe(true);
    expect(page.el('invite-username').getAttribute('aria-invalid')).toBe('true');
    fill(page, 'invite', { username: 'bob' });
    page.el('invite-form').fire('submit');
    await settle();
    expect(page.el('invite-username').getAttribute('aria-invalid')).toBeNull();
    expect(page.el('invite-username-error').hidden).toBe(true);
  });

  it('a second submit while one is out says nothing', async () => {
    const g = gate();
    const { page } = await start(base('owner', OWNER_MEMBERS, [], { [`PATCH /api/circles/${C}`]: () => g.promise, [`POST /api/circles/${C}/invitations`]: () => g.promise }));
    fill(page, 'rename', { name: 'New' });
    page.el('rename-form').fire('submit');
    await settle();
    page.el('rename-form').fire('submit');
    await settle();
    expect(page.el('rename-error').hidden).toBe(true);
    expect(page.el('rename-name-error').hidden).toBe(true);
    fill(page, 'invite', { username: 'bob' });
    page.el('invite-form').fire('submit');
    await settle();
    expect(page.el('invite-error').hidden).toBe(true);
    expect(page.el('invite-username-error').hidden).toBe(true);
    expect(page.el('invite-notice').hidden).toBe(true);
    g.release({ status: 200, body: { circle: circle('owner', { name: 'New' }) } });
    await settle();
  });

  it('older problems go on the next withdraw and on the next removal', async () => {
    let w = 0;
    let d = 0;
    const { page } = await start(base('owner', OWNER_MEMBERS, [inv(1), inv(2)], {
      [`DELETE /api/circles/${C}/invitations/${I(1)}`]: () => (++w === 1 ? refuse(500, 'STORAGE_ERROR', 'x') : { status: 204 }),
      [`DELETE /api/circles/${C}/members/${U(3)}`]: () => (++d === 1 ? refuse(500, 'STORAGE_ERROR', 'x') : { status: 204 }),
    }));
    slot(rows(page, 'circle-invitations-list')[0], 'withdraw').fire('click');
    await settle();
    expect(page.el('circle-invitations-error').hidden).toBe(false);
    slot(rows(page, 'circle-invitations-list')[0], 'withdraw').fire('click');
    await settle();
    expect(page.el('circle-invitations-error').hidden).toBe(true);
    slot(nameRow(page, 'User 3'), 'remove').fire('click');
    slot(nameRow(page, 'User 3'), 'removeYes').fire('click');
    await settle();
    expect(page.el('members-error').hidden).toBe(false);
    slot(nameRow(page, 'User 3'), 'remove').fire('click');
    slot(nameRow(page, 'User 3'), 'removeYes').fire('click');
    await settle();
    expect(page.el('members-error').hidden).toBe(true);
  });

  it('a problem with leaving goes away on the next try', async () => {
    let n = 0;
    const { page } = await start(base('owner', OWNER_MEMBERS, [], { [`POST /api/circles/${C}/leave`]: () => (++n === 1 ? refuse(409, 'LAST_OWNER', 'Only owner.') : refuse(500, 'STORAGE_ERROR', 'x')) }));
    page.el('leave-button').fire('click');
    page.el('leave-yes').fire('click');
    await settle();
    expect(page.el('circle-error').textContent).toBe('Only owner.');
    page.el('leave-button').fire('click');
    page.el('leave-yes').fire('click');
    await settle();
    expect(page.el('circle-error').textContent).not.toBe('Only owner.');
  });

  it('opening another circle, or leaving this screen, forgets what was typed', async () => {
    const C2 = 'c0000000000000002';
    const table = base('owner', OWNER_MEMBERS, [], { [`GET /api/circles/${C2}`]: { status: 200, body: { circle: circle('owner', { id: C2, name: 'Other' }) } }, [`GET /api/circles/${C2}/members?limit=50`]: pageOf([member(1, 'owner')]), [`GET /api/circles/${C2}/invitations?limit=50`]: pageOf([]) });
    const { page, addr } = await start(table);
    fill(page, 'invite', { username: 'half' });
    fill(page, 'rename', { name: 'Half typed' });
    addr.change(`#/circles/${C2}`);
    await settle();
    expect(page.el('invite-username').value).toBe('');
    expect(page.el('rename-name').value).toBe('Other');
    fill(page, 'invite', { username: 'half' });
    addr.change('#/circles');
    await settle();
    expect(page.el('invite-username').value).toBe('');
    expect(page.el('rename-name').value).toBe('');
  });
});

describe('text only, busy and leaving the screen', () => {
  it('names and descriptions made of markup stay text', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { page } = await start(base('owner', [member(1, 'owner', { displayName: evil }), member(2, 'member', { displayName: '<b>Bob</b>', username: 'bob' })], [{ ...inv(1), username: 'x<script>' }], { [`GET /api/circles/${C}`]: { status: 200, body: { circle: circle('owner', { name: '<script>x</script>', description: evil }) } } }));
    expect(page.el('circle-heading').textContent).toBe('<script>x</script>');
    expect(page.el('circle-description').textContent).toBe(evil);
    expect(slot(rows(page)[0], 'name').textContent).toBe(`${evil} (you)`);
    expect(slot(rows(page)[1], 'name').textContent).toBe('<b>Bob</b>');
    expect(slot(rows(page)[1], 'name').children).toEqual([]);
    expect(slot(rows(page, 'circle-invitations-list')[0], 'who').textContent).toBe('For x<script>');
  });

  it('controls are disabled while a request is out', async () => {
    const g = gate();
    const { page } = await start(base('owner', OWNER_MEMBERS, [inv(1)], { [`PATCH /api/circles/${C}`]: () => g.promise }));
    fill(page, 'rename', { name: 'New' });
    page.el('rename-form').fire('submit');
    await settle();
    expect(page.el('rename-submit').disabled).toBe(true);
    expect(page.el('invite-submit').disabled).toBe(true);
    expect(page.el('leave-button').disabled).toBe(true);
    expect(page.el('delete-button').disabled).toBe(true);
    expect(page.el('circle-refresh').disabled).toBe(true);
    expect(slot(rows(page)[1], 'save').disabled).toBe(true);
    expect(slot(rows(page)[1], 'remove').disabled).toBe(true);
    expect(slot(rows(page, 'circle-invitations-list')[0], 'withdraw').disabled).toBe(true);
    g.release({ status: 200, body: { circle: circle('owner', { name: 'New' }) } });
    await settle();
    expect(page.el('rename-submit').disabled).toBe(false);
  });

  it('going away and back loads the circle again, and nothing of the old screen stays in the forms', async () => {
    const { page, addr, svc } = await start(base('owner', OWNER_MEMBERS, []));
    fill(page, 'invite', { username: 'half' });
    addr.change('#/circles');
    await settle();
    addr.change(`#/circles/${C}`);
    await settle();
    expect(page.el('invite-username').value).toBe('');
    expect(svc.keys().filter((k) => k === `GET /api/circles/${C}`)).toHaveLength(2);
  });

  it('signing out clears the circle, and its screen is not shown', async () => {
    const { page } = await start(base('owner', OWNER_MEMBERS, [], { 'POST /api/logout': { status: 204 } }));
    page.el('signout').fire('click');
    await settle();
    expect(visibleScreens(page)).toEqual(['signed-out']);
    expect(rows(page)).toHaveLength(0);
    expect(page.el('circle-body').hidden).toBe(true);
  });

  it('mounting fails loudly if the page lacks an element the circle screen needs', () => {
    const page = fakePage();
    const broken = { title: '', getElementById: (id) => (id === 'delete-yes' ? null : page.document.getElementById(id)) };
    expect(() => mount(broken, service().fetchFn)).toThrow(/no element "delete-yes"/);
  });
});
