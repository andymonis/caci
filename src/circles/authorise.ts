import type { CircleRole } from './types.js';

/**
 * Everything a person can ask to do inside a circle (R-004). The whole of "who may do what" is the
 * table in `authorise`, so there is one place to read and one place to test.
 */
export const CIRCLE_ACTIONS = ['viewCircle', 'listMembers', 'leave', 'updateCircle', 'deleteCircle', 'invite', 'revokeInvitation', 'changeRole', 'removeMember'] as const;
export type CircleAction = (typeof CIRCLE_ACTIONS)[number];

export interface AuthoriseContext {
  /** `invite` and `revokeInvitation`: the role offered. `changeRole`: the new role. */
  readonly role?: CircleRole;
  /** `changeRole` and `removeMember`: the role the other person has now. */
  readonly target?: CircleRole;
  /** `changeRole` and `removeMember`: the other person is the caller (nobody changes their own role, and removing yourself is leaving). */
  readonly self?: boolean;
}

const LOW: readonly CircleRole[] = Object.freeze(['member', 'observer']);
const isLow = (role: CircleRole | undefined): boolean => role !== undefined && LOW.includes(role);
const isRole = (role: unknown): role is CircleRole => role === 'owner' || role === 'manager' || role === 'member' || role === 'observer';

/**
 * May someone whose role in the circle is `actor` do `action`? `actor` is `undefined` for someone who is not a member.
 *
 * - Every member may see the circle and its people, and leave (the last-owner rule is the store's, not this table's).
 * - Owners and managers may rename the circle; only owners delete it.
 * - Owners may invite or revoke for any role; managers only for `member` and `observer`.
 * - Owners may change anyone else's role to any role and remove anyone else; managers may only move people who are `member` or `observer` between those two, and remove only those.
 * - Nobody changes their own role, and removing yourself is leaving.
 *
 * Pure: it looks at nothing but its arguments, so it cannot be fooled by state. Anything missing or
 * unrecognised is refused.
 */
export function authorise(actor: CircleRole | undefined, action: CircleAction, context: AuthoriseContext = {}): boolean {
  if (!isRole(actor)) return false;
  switch (action) {
    case 'viewCircle':
    case 'listMembers':
    case 'leave':
      return true;
    case 'updateCircle':
      return actor === 'owner' || actor === 'manager';
    case 'deleteCircle':
      return actor === 'owner';
    case 'invite':
    case 'revokeInvitation':
      if (!isRole(context.role)) return false;
      return actor === 'owner' || (actor === 'manager' && isLow(context.role));
    case 'changeRole':
      if (context.self !== false || !isRole(context.target) || !isRole(context.role)) return false;
      return actor === 'owner' || (actor === 'manager' && isLow(context.target) && isLow(context.role));
    case 'removeMember':
      if (context.self !== false || !isRole(context.target)) return false;
      return actor === 'owner' || (actor === 'manager' && isLow(context.target));
    default:
      return false;
  }
}
