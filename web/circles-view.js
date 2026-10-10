// The words and small decisions behind the home, circles and invitations screens (R-006). Pure: no page
// access, so every sentence can be tested exactly. `circles-pages.js` only puts them on the page.

import { ROLE_WORDS } from './permissions.js';
import { hashFor } from './router.js';

export const EMPTY_CIRCLES = 'You are not in any circle yet. Make one below, or ask someone to invite you.';
export const EMPTY_INVITATIONS = 'You have no open invitations.';

const ROLE_NAMES = Object.freeze({ owner: 'Owner', manager: 'Manager', member: 'Member', observer: 'Observer' });
const TITLES = Object.freeze({ home: 'CaCi', circles: 'Circles – CaCi', circle: 'Circle – CaCi', invitations: 'Invitations – CaCi', capture: 'Capture – CaCi', brain: 'Brain – CaCi' });

/** The name of a screen, or home for anything that is not one of the four (own keys only, so `toString` is not a screen). */
const screenOf = (route) => (route !== null && typeof route === 'object' && typeof route.name === 'string' && Object.hasOwn(TITLES, route.name) ? route.name : 'home');

/** The tab title for a screen. */
export const titleFor = (route) => TITLES[screenOf(route)];

/** The id of the main heading of a screen, which takes the focus when the screen changes. */
export const headingIdFor = (route) => `${screenOf(route)}-heading`;

/** Which navigation link is the current one (a circle belongs to the circles link). */
export const navFor = (route) => (screenOf(route) === 'circle' ? 'circles' : screenOf(route));

/** A date as `YYYY-MM-DD` (UTC), or nothing for a value that is not a time. */
export function formatDate(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0) return '';
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

export const roleName = (role) => (typeof role === 'string' && Object.hasOwn(ROLE_NAMES, role) ? ROLE_NAMES[role] : '');
export const peopleText = (n) => (n === 1 ? '1 person' : `${n} people`);

/** What a row of the circles list says. */
export function circleRow(circle) {
  return Object.freeze({
    name: circle.name,
    meta: `Your role: ${roleName(circle.role)} · ${peopleText(circle.memberCount)}`,
    href: hashFor({ name: 'circle', id: circle.id }),
    label: `Open the circle ${circle.name}`,
  });
}

/** What a row of the invitations list says. */
export function invitationRow(invitation) {
  const by = invitation.invitedBy && typeof invitation.invitedBy.displayName === 'string' && invitation.invitedBy.displayName !== '' ? invitation.invitedBy.displayName : 'someone';
  const ends = formatDate(invitation.expiresAt);
  return Object.freeze({
    circle: invitation.circle.name,
    meta: `You would be: ${roleName(invitation.role)}`,
    roleWords: typeof invitation.role === 'string' && Object.hasOwn(ROLE_WORDS, invitation.role) ? ROLE_WORDS[invitation.role] : '',
    from: `Invited by ${by}`,
    ends: ends === '' ? '' : `Ends ${ends}`,
    acceptLabel: `Accept the invitation to ${invitation.circle.name}`,
    declineLabel: `Decline the invitation to ${invitation.circle.name}`,
  });
}

/** The sentence about the invitation count: only a number the last answer gave. */
export function countText(invitations) {
  if (invitations.status === 'error') return `Could not check your invitations: ${invitations.error}`;
  if (invitations.count === null || invitations.status !== 'loaded') return 'Not checked yet.';
  if (invitations.atLeast) return `You have ${invitations.count} or more open invitations.`;
  if (invitations.count === 0) return EMPTY_INVITATIONS;
  return `You have ${invitations.count} open ${invitations.count === 1 ? 'invitation' : 'invitations'}.`;
}

// --- the circle screen ---

export const LEAVE_TEXT = 'Leave this circle? You will no longer see it or who is in it, and you need a new invitation to come back.';
export const DELETE_TEXT = 'Delete this circle? This removes the circle, its members and its invitations. It cannot be undone.';
export const NO_INVITATIONS_HERE = 'There are no open invitations.';

const nameOf = (person) => (typeof person.displayName === 'string' && person.displayName !== '' ? person.displayName : typeof person.username === 'string' && person.username !== '' ? person.username : 'Someone');

/** What a row of the roster says. `self` marks the signed-in person's own row. */
export function memberRow(member, self) {
  const joined = formatDate(member.joinedAt);
  const handle = typeof member.username === 'string' && member.username !== '' ? `@${member.username}` : '';
  return Object.freeze({
    name: self ? `${nameOf(member)} (you)` : nameOf(member),
    meta: [handle, roleName(member.role), joined === '' ? '' : `joined ${joined}`].filter((part) => part !== '').join(' · '),
    roleWords: typeof member.role === 'string' && Object.hasOwn(ROLE_WORDS, member.role) ? ROLE_WORDS[member.role] : '',
    removeText: `Remove ${nameOf(member)} from this circle? They will lose their place in it.`,
    saveLabel: `Save the role for ${nameOf(member)}`,
    removeLabel: `Remove ${nameOf(member)}`,
    roleLabel: `Role for ${nameOf(member)}`,
  });
}

/** What a row of the circle's open invitations says. */
export function circleInvitationRow(invitation) {
  const ends = formatDate(invitation.expiresAt);
  return Object.freeze({
    who: `For ${invitation.username}`,
    meta: `They would be: ${roleName(invitation.role)}`,
    from: `Invited by ${invitation.invitedBy && typeof invitation.invitedBy.displayName === 'string' && invitation.invitedBy.displayName !== '' ? invitation.invitedBy.displayName : 'someone'}`,
    ends: ends === '' ? '' : `Ends ${ends}`,
    withdrawLabel: `Withdraw the invitation for ${invitation.username}`,
  });
}

// "What you share" (R-008): the words for the sharing part of a circle's screen.

export const SHARE_NONE = 'Nothing shared';
export const SHARE_NOBODY = 'There is nobody else in this circle yet.';
export const SHARE_LOADING_MINE = 'Loading your categories…';
export const SHARE_NO_CATEGORIES = 'You have no categories yet: file a note first.';
export const SHARE_CAPPED = ' Only the first 1,000 of your categories are listed.';

const categoriesText = (n) => (n === 1 ? '1 category' : `${n} categories`);
const categoryName = (c) => (typeof c.name === 'string' && c.name !== '' ? c.name : c.id);

/** What a row of the other members says: who, and what is shared with them. */
export function shareRow(person) {
  const shared = Array.isArray(person.shared) ? person.shared : [];
  const who = nameOf(person);
  return Object.freeze({
    name: who,
    meta: shared.length === 0 ? SHARE_NONE : `Sharing ${categoriesText(shared.length)}: ${shared.map(categoryName).join(', ')}`,
    changeLabel: `Choose what to share with ${who}`,
    stopLabel: `Stop sharing with ${who}`,
    stopText: `Stop sharing with ${who}? They will no longer be able to read any of your categories.`,
    help: `Tick the categories ${who} may read. The items filed under them come with them.`,
    saveLabel: `Save what is shared with ${who}`,
    cancelLabel: `Cancel changing what is shared with ${who}`,
  });
}

/** One of my categories in the picker. */
export const choiceLabel = (category) => categoryName(category);

// "Shared with you" (R-008): the words for reading what other members share.

export const SHARED_NOBODY = 'Nobody has shared anything with you in this circle.';
export const SHARED_NO_CATEGORIES = 'None of the categories shared with you still exist.';

/** What a row of the people who have shared with you says. */
export function sharedPersonRow(person) {
  const who = nameOf(person);
  const count = person.categoryCount === 1 ? '1 category shared' : `${person.categoryCount} categories shared`;
  return Object.freeze({ name: who, meta: count, label: `Read what ${who} shares with you, ${count}` });
}

/** The heading and the read-only reminder above one person's shared brain. */
export function sharedOwnerWords(person) {
  const who = person === null ? 'Someone' : nameOf(person);
  return Object.freeze({
    heading: `Shared by ${who}`,
    readonly: `Read-only. You can see only the categories ${who} chose to share with you, and the items filed under them.`,
  });
}
