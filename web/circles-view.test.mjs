import { describe, expect, it } from 'vitest';
import { circleInvitationRow, circleRow, countText, DELETE_TEXT, LEAVE_TEXT, memberRow, EMPTY_CIRCLES, EMPTY_INVITATIONS, formatDate, headingIdFor, invitationRow, navFor, peopleText, roleName, titleFor } from './circles-view.js';
import { ROLE_WORDS } from './permissions.js';

const C = 'c0123456789abcdef';

describe('titles, headings and the current link', () => {
  it('each screen has its title, heading and link; anything else is home', () => {
    expect(titleFor({ name: 'home' })).toBe('CaCi');
    expect(titleFor({ name: 'circles' })).toBe('Circles – CaCi');
    expect(titleFor({ name: 'circle', id: C })).toBe('Circle – CaCi');
    expect(titleFor({ name: 'invitations' })).toBe('Invitations – CaCi');
    expect(headingIdFor({ name: 'home' })).toBe('home-heading');
    expect(headingIdFor({ name: 'circles' })).toBe('circles-heading');
    expect(headingIdFor({ name: 'circle' })).toBe('circle-heading');
    expect(headingIdFor({ name: 'invitations' })).toBe('invitations-heading');
    expect(navFor({ name: 'home' })).toBe('home');
    expect(navFor({ name: 'circles' })).toBe('circles');
    expect(navFor({ name: 'circle' })).toBe('circles');
    expect(navFor({ name: 'invitations' })).toBe('invitations');
    for (const odd of [undefined, null, {}, { name: 'admin' }, { name: '__proto__' }, { name: 'toString' }, 5]) {
      expect(titleFor(odd), String(odd)).toBe('CaCi');
      expect(headingIdFor(odd), String(odd)).toBe('home-heading');
      expect(navFor(odd), String(odd)).toBe('home');
    }
  });
});

describe('words', () => {
  it('dates are UTC days, or nothing', () => {
    expect(formatDate(0)).toBe('1970-01-01');
    expect(formatDate(Date.UTC(2026, 9, 8, 23, 59))).toBe('2026-10-08');
    for (const bad of [-1, 1.5, NaN, Infinity, '5', null, undefined, 8.64e15 + 1]) expect(formatDate(bad), String(bad)).toBe('');
  });
  it('roles and people', () => {
    expect([roleName('owner'), roleName('manager'), roleName('member'), roleName('observer'), roleName('admin'), roleName('__proto__')]).toEqual(['Owner', 'Manager', 'Member', 'Observer', '', '']);
    expect([peopleText(1), peopleText(2), peopleText(0), peopleText(50)]).toEqual(['1 person', '2 people', '0 people', '50 people']);
  });
  it('a circle row', () => {
    expect(circleRow({ id: C, name: 'Team', role: 'manager', memberCount: 3 })).toEqual({ name: 'Team', meta: 'Your role: Manager · 3 people', href: `#/circles/${C}`, label: 'Open the circle Team' });
    expect(circleRow({ id: C, name: '<b>x</b>', role: 'owner', memberCount: 1 }).name).toBe('<b>x</b>');
  });
  it('an invitation row names the sender, the role in plain words and when it ends', () => {
    const row = invitationRow({ circle: { id: C, name: 'Team' }, role: 'member', invitedBy: { displayName: 'Bob' }, expiresAt: Date.UTC(2026, 0, 2) });
    expect(row).toEqual({ circle: 'Team', meta: 'You would be: Member', roleWords: ROLE_WORDS.member, from: 'Invited by Bob', ends: 'Ends 2026-01-02', acceptLabel: 'Accept the invitation to Team', declineLabel: 'Decline the invitation to Team' });
    expect(invitationRow({ circle: { name: 'T' }, role: 'owner', invitedBy: {}, expiresAt: -1 })).toMatchObject({ from: 'Invited by someone', ends: '' });
    expect(invitationRow({ circle: { name: 'T' }, role: 'owner', expiresAt: 1 }).from).toBe('Invited by someone');
    expect(invitationRow({ circle: { name: 'T' }, role: 'owner', invitedBy: { displayName: '' }, expiresAt: 1 }).from).toBe('Invited by someone');
    expect(invitationRow({ circle: { name: 'T' }, role: 'nope', invitedBy: {}, expiresAt: 1 }).roleWords).toBe('');
  });
});

describe('the invitation count sentence', () => {
  const inv = (x) => ({ status: 'loaded', error: null, count: 0, atLeast: false, ...x });
  it('says only what the last answer gave', () => {
    expect(countText(inv({ status: 'idle', count: null }))).toBe('Not checked yet.');
    expect(countText(inv({ count: 0 }))).toBe(EMPTY_INVITATIONS);
    expect(countText(inv({ count: 1 }))).toBe('You have 1 open invitation.');
    expect(countText(inv({ count: 2 }))).toBe('You have 2 open invitations.');
    expect(countText(inv({ count: 100, atLeast: true }))).toBe('You have 100 or more open invitations.');
    expect(countText(inv({ status: 'error', error: 'Down.', count: null }))).toBe('Could not check your invitations: Down.');
  });
  it('never shows a number when the state has none or is not loaded', () => {
    expect(countText(inv({ count: null }))).toBe('Not checked yet.');
    expect(countText(inv({ status: 'loading', count: 5 }))).toBe('Not checked yet.');
    expect(countText(inv({ status: 'error', error: 'x', count: 5 }))).not.toMatch(/\d/);
  });
  it('has a sentence for an empty circle list', () => {
    expect(EMPTY_CIRCLES).toContain('Make one below');
  });
});

describe('the circle screen\'s words', () => {
  const m = { userId: 'u0000000000000002', username: 'bob', displayName: 'Bob B', role: 'manager', joinedAt: Date.UTC(2026, 0, 5) };
  it('a roster row', () => {
    expect(memberRow(m, false)).toEqual({
      name: 'Bob B',
      meta: '@bob · Manager · joined 2026-01-05',
      roleWords: ROLE_WORDS.manager,
      removeText: 'Remove Bob B from this circle? They will lose their place in it.',
      saveLabel: 'Save the role for Bob B',
      removeLabel: 'Remove Bob B',
      roleLabel: 'Role for Bob B',
    });
    expect(memberRow(m, true).name).toBe('Bob B (you)');
  });
  it('a person without a display name is shown by username, and one with neither as "Someone"', () => {
    expect(memberRow({ ...m, displayName: '' }, false).name).toBe('bob');
    expect(memberRow({ ...m, displayName: undefined }, false).name).toBe('bob');
    const bare = memberRow({ userId: m.userId, role: 'member', joinedAt: -1 }, false);
    expect(bare.name).toBe('Someone');
    expect(bare.meta).toBe('Member');
    expect(bare.saveLabel).toBe('Save the role for Someone');
    expect(memberRow({ ...m, username: '' }, false).meta).toBe('Manager · joined 2026-01-05');
    expect(memberRow({ ...m, role: 'nope' }, false).roleWords).toBe('');
    expect(memberRow({ ...m, role: '__proto__' }, false).roleWords).toBe('');
  });
  it('an open invitation row', () => {
    const inv = { id: 'i0000000000000001', username: 'guest', role: 'observer', invitedBy: { displayName: 'Ann' }, expiresAt: Date.UTC(2026, 0, 9) };
    expect(circleInvitationRow(inv)).toEqual({ who: 'For guest', meta: 'They would be: Observer', from: 'Invited by Ann', ends: 'Ends 2026-01-09', withdrawLabel: 'Withdraw the invitation for guest' });
    expect(circleInvitationRow({ ...inv, invitedBy: {}, expiresAt: -1 })).toMatchObject({ from: 'Invited by someone', ends: '' });
    expect(circleInvitationRow({ ...inv, invitedBy: undefined }).from).toBe('Invited by someone');
    expect(circleInvitationRow({ ...inv, invitedBy: { displayName: '' } }).from).toBe('Invited by someone');
  });
  it('the two questions say what will happen', () => {
    expect(LEAVE_TEXT).toContain('no longer see it');
    expect(DELETE_TEXT).toBe('Delete this circle? This removes the circle, its members and its invitations. It cannot be undone.');
  });
});
