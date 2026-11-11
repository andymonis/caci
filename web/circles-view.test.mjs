import { describe, expect, it } from 'vitest';
import { circleInvitationRow, circleRow, countText, DELETE_TEXT, LEAVE_TEXT, memberRow, EMPTY_CIRCLES, EMPTY_INVITATIONS, formatDate, headingIdFor, invitationRow, navFor, peopleText, roleName, titleFor, JOIN_CREATED_WORDS, JOIN_NO_LINKS, JOIN_NO_REQUESTS, JOIN_NOTE, joinLinkRow, joinRequestRow, joinUrl, MY_REQUESTS_NONE, MY_REQUESTS_NOTE, myRequestRow, JOIN_MINE_NOTE, JOIN_MISS, JOIN_NO_LINK, JOIN_SIGNED_OUT, JOIN_WARNING, joinPreviewWords, joinResultWords } from './circles-view.js';
import { ROLE_WORDS } from './permissions.js';

const C = 'c0123456789abcdef';

describe('titles, headings and the current link', () => {
  it('each screen has its title, heading and link; anything else is home', () => {
    expect(titleFor({ name: 'home' })).toBe('CaCi');
    expect(titleFor({ name: 'circles' })).toBe('Circles – CaCi');
    expect(titleFor({ name: 'circle', id: C })).toBe('Circle – CaCi');
    expect(titleFor({ name: 'invitations' })).toBe('Invitations – CaCi');
    expect(titleFor({ name: 'status' })).toBe('Status – CaCi');
    expect(titleFor({ name: 'capture' })).toBe('Capture – CaCi');
    expect(titleFor({ name: 'brain' })).toBe('Brain – CaCi');
    expect(titleFor({ name: 'ledger' })).toBe('Change log – CaCi');
    expect(headingIdFor({ name: 'home' })).toBe('home-heading');
    expect(headingIdFor({ name: 'circles' })).toBe('circles-heading');
    expect(headingIdFor({ name: 'circle' })).toBe('circle-heading');
    expect(headingIdFor({ name: 'invitations' })).toBe('invitations-heading');
    expect(headingIdFor({ name: 'status' })).toBe('status-heading');
    expect(headingIdFor({ name: 'capture' })).toBe('capture-heading');
    expect(headingIdFor({ name: 'brain' })).toBe('brain-heading');
    expect(headingIdFor({ name: 'ledger' })).toBe('ledger-heading');
    expect(navFor({ name: 'home' })).toBe('home');
    expect(navFor({ name: 'circles' })).toBe('circles');
    expect(navFor({ name: 'circle' })).toBe('circles');
    expect(navFor({ name: 'invitations' })).toBe('invitations');
    expect(navFor({ name: 'status' })).toBe('status');
    expect(navFor({ name: 'capture' })).toBe('capture');
    expect(navFor({ name: 'brain' })).toBe('brain');
    expect(navFor({ name: 'ledger' })).toBe('ledger');
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

describe('the words for what you share', () => {
  const person = (extra = {}) => ({ userId: 'u0000000000000002', username: 'bob', displayName: 'Bob B', shared: [], ...extra });
  it('says what is shared with a person, by name, singular and plural', async () => {
    const { shareRow, SHARE_NONE } = await import('./circles-view.js');
    expect(shareRow(person()).meta).toBe(SHARE_NONE);
    expect(SHARE_NONE).toBe('Nothing shared');
    expect(shareRow(person({ shared: [{ id: 'a', name: 'Alpha' }] })).meta).toBe('Sharing 1 category: Alpha');
    expect(shareRow(person({ shared: [{ id: 'a', name: 'Alpha' }, { id: 'b' }] })).meta).toBe('Sharing 2 categories: Alpha, b');
  });
  it('names the person by display name, then username, then words, in every label', async () => {
    const { shareRow } = await import('./circles-view.js');
    const v = shareRow(person());
    expect(v.name).toBe('Bob B');
    expect([v.changeLabel, v.stopLabel, v.saveLabel, v.cancelLabel]).toEqual(['Choose what to share with Bob B', 'Stop sharing with Bob B', 'Save what is shared with Bob B', 'Cancel changing what is shared with Bob B']);
    expect(v.stopText).toBe('Stop sharing with Bob B? They will no longer be able to read any of your categories.');
    expect(v.help).toBe('Tick the categories Bob B may read. The items filed under them come with them.');
    expect(shareRow(person({ displayName: undefined })).name).toBe('bob');
    expect(shareRow(person({ displayName: undefined, username: undefined })).name).toBe('Someone');
    expect(shareRow({}).meta).toBe('Nothing shared');
  });
  it('shows a category by its name, else its id', async () => {
    const { choiceLabel } = await import('./circles-view.js');
    expect(choiceLabel({ id: 'x', name: 'Name' })).toBe('Name');
    expect(choiceLabel({ id: 'x' })).toBe('x');
    expect(choiceLabel({ id: 'x', name: '' })).toBe('x');
  });
});

describe('the words for what is shared with you', () => {
  it('names a person and counts what they share, in the singular and the plural', async () => {
    const { sharedPersonRow, SHARED_NOBODY } = await import('./circles-view.js');
    expect(SHARED_NOBODY).toBe('Nobody has shared anything with you in this circle.');
    expect(sharedPersonRow({ displayName: 'Ann A', username: 'ann', categoryCount: 1 })).toEqual({ name: 'Ann A', meta: '1 category shared', label: 'Read what Ann A shares with you, 1 category shared' });
    expect(sharedPersonRow({ username: 'ann', categoryCount: 3 })).toMatchObject({ name: 'ann', meta: '3 categories shared' });
    expect(sharedPersonRow({ categoryCount: 0 })).toMatchObject({ name: 'Someone', meta: '0 categories shared' });
  });
  it('says whose it is and that it is read-only', async () => {
    const { sharedOwnerWords, SHARED_NO_CATEGORIES } = await import('./circles-view.js');
    expect(sharedOwnerWords({ displayName: 'Ann A' })).toEqual({ heading: 'Shared by Ann A', readonly: 'Read-only. You can see only the categories Ann A chose to share with you, and the items filed under them.' });
    expect(sharedOwnerWords(null).heading).toBe('Shared by Someone');
    expect(SHARED_NO_CATEGORIES).toBe('None of the categories shared with you still exist.');
  });
});


describe('join links (R-023)', () => {
  const link = { id: 'j0000000000000001', role: 'member', label: 'Club chat', createdBy: { userId: 'u1' }, createdAt: Date.UTC(2026, 0, 1), expiresAt: Date.UTC(2026, 0, 8), maxUses: 3, uses: 1, approval: true };

  it('the sentences a person must not miss are there', () => {
    expect(JOIN_NOTE).toContain('A link is shown only once');
    expect(JOIN_NOTE).toContain('anyone who has it can pass it on');
    expect(JOIN_NOTE).toContain('read everything this circle holds');
    expect(JOIN_CREATED_WORDS).toContain('It is not shown again and cannot be recovered');
    expect(JOIN_NO_LINKS).toBe('There are no live join links.');
    expect(JOIN_NO_REQUESTS).toBe('Nobody is waiting to join.');
    expect(MY_REQUESTS_NOTE).toContain('an owner or manager of that circle decides');
    expect(MY_REQUESTS_NONE).toBe('You have no requests waiting.');
  });

  it('the address is the user app\'s join screen with the token after the #, and no origin gives a plain path', () => {
    expect(joinUrl('https://caci.example', 'cjoin_x')).toBe('https://caci.example/#/join/cjoin_x');
    expect(joinUrl('', 'cjoin_x')).toBe('/#/join/cjoin_x');
    for (const odd of [undefined, null, 5, {}]) expect(joinUrl(odd, 'cjoin_x')).toBe('/#/join/cjoin_x');
  });

  it('a link row says what it offers, how much is used, whether approval is needed and when it ends', () => {
    expect(joinLinkRow(link)).toEqual({
      title: 'Club chat',
      meta: 'Offers: Member · 1 of 3 uses used · each person needs approval · ends 2026-01-08',
      revokeLabel: 'Withdraw the link Club chat',
      askText: 'Withdraw the link "Club chat"? It stops working at once. Requests already made stay waiting.',
    });
    expect(joinLinkRow({ ...link, role: 'observer', approval: false, maxUses: 1, uses: 0 }).meta).toBe('Offers: Observer · 0 of 1 use used · joins at once · ends 2026-01-08');
    expect(joinLinkRow({ ...link, expiresAt: 'x' }).meta).toBe('Offers: Member · 1 of 3 uses used · each person needs approval');
    expect(Object.isFrozen(joinLinkRow(link))).toBe(true);
  });

  it('a request row names the person by display name, the role asked and the dates', () => {
    const request = { id: 'r0000000000000001', person: { displayName: 'Eve E' }, role: 'observer', createdAt: Date.UTC(2026, 0, 2), expiresAt: Date.UTC(2026, 0, 9) };
    expect(joinRequestRow(request)).toEqual({ title: 'Eve E', meta: 'Wants to join as: Observer · asked 2026-01-02 · lapses 2026-01-09', approveLabel: 'Approve Eve E', declineLabel: 'Decline Eve E' });
    for (const person of [{}, { displayName: '' }, null, undefined]) expect(joinRequestRow({ ...request, person }).title).toBe('Someone');
    expect(joinRequestRow({ ...request, createdAt: 'x', expiresAt: -1 }).meta).toBe('Wants to join as: Observer');
  });

  it('a person\'s own request names the circle and the role, and when it lapses', () => {
    const request = { id: 'r0000000000000001', circle: { name: 'Team' }, role: 'member', createdAt: Date.UTC(2026, 0, 2), expiresAt: Date.UTC(2026, 0, 9) };
    expect(myRequestRow(request)).toEqual({ title: 'Team', meta: 'You asked to join as: Member · asked 2026-01-02 · lapses 2026-01-09' });
    expect(myRequestRow({ ...request, createdAt: 'x', expiresAt: 'y' }).meta).toBe('You asked to join as: Member');
  });
});

describe('the join screen of the everyday app (R-023)', () => {
  it('the sentences a person must not miss are there', () => {
    expect(JOIN_NO_LINK).toBe('This page needs a join link. Open the link you were sent.');
    expect(JOIN_SIGNED_OUT).toBe('You were sent a link to join a circle. Sign in, or create an account, to carry on.');
    expect(JOIN_WARNING).toContain('everyone in it can see your username and display name');
    expect(JOIN_WARNING).toContain('An owner or manager may need to approve you first');
    expect(JOIN_MISS).toContain('used up');
    expect(JOIN_MISS).toContain('If you already asked to join, your request is listed below');
    expect(JOIN_MINE_NOTE).toContain('You are not told when one is decided');
  });

  it('the preview names the circle, the role and who made the link', () => {
    expect(joinPreviewWords({ circle: { name: 'Club' }, role: 'observer', createdBy: { displayName: 'Ben B' } })).toBe('You have been invited to join the circle "Club" as Observer. The link was made by Ben B.');
    for (const createdBy of [{}, { displayName: '' }, undefined, null]) expect(joinPreviewWords({ circle: { name: 'Club' }, role: 'member', createdBy })).toBe('You have been invited to join the circle "Club" as Member.');
  });

  it('each answer to joining says what happened', () => {
    const circle = { id: 'c0000000000000001', name: 'Club', role: 'manager' };
    expect(joinResultWords({ state: 'joined', circle })).toBe('You are now a member of "Club" as Manager.');
    expect(joinResultWords({ state: 'member', circle })).toBe('You are already in "Club" as Manager. Nothing was changed.');
    const asked = { circle: { name: 'Club' }, role: 'member', expiresAt: Date.UTC(2026, 0, 9) };
    expect(joinResultWords({ state: 'requested', ...asked })).toBe('Your request to join "Club" as Member has been sent. An owner or manager will decide. It lapses on 2026-01-09.');
    expect(joinResultWords({ state: 'waiting', ...asked })).toBe('Your request to join "Club" is already waiting for an owner or manager. It lapses on 2026-01-09.');
    expect(joinResultWords({ state: 'requested', ...asked, expiresAt: 'x' })).toBe('Your request to join "Club" as Member has been sent. An owner or manager will decide.');
    expect(joinResultWords({ state: 'other', circle })).toBe('');
  });
});
