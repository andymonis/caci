// The words and small decisions behind the home, circles and invitations screens (R-006). Pure: no page
// access, so every sentence can be tested exactly. `circles-pages.js` only puts them on the page.

import { ROLE_WORDS } from './permissions.js';
import { hashFor } from './router.js';

export const EMPTY_CIRCLES = 'You are not in any circle yet. Make one below, or ask someone to invite you.';
export const EMPTY_INVITATIONS = 'You have no open invitations.';

const ROLE_NAMES = Object.freeze({ owner: 'Owner', manager: 'Manager', member: 'Member', observer: 'Observer' });
const TITLES = Object.freeze({ home: 'CaCi', circles: 'Circles – CaCi', circle: 'Circle – CaCi', invitations: 'Invitations – CaCi' });

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
