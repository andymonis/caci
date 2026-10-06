import type { Role } from './types.js';

/**
 * Everything one person can ask to do to an account, other than their own sign-in and password
 * (those act on the caller by construction). The whole of "who may do what" is the table in
 * `authorise`, so there is one place to read and one place to test.
 */
export const ACTIONS = ['listUsers', 'getUser', 'updateUser', 'changeRole', 'resetPassword', 'deleteUser'] as const;
export type Action = (typeof ACTIONS)[number];

export interface Actor {
  readonly id: string;
  readonly role: Role;
}

/** Actions an ordinary user may do to their own record, and only their own. */
const SELF_ACTIONS: readonly Action[] = Object.freeze(['getUser', 'updateUser']);

/**
 * May `actor` do `action` to the account `targetId`?
 *
 * - An admin may do anything.
 * - A user may read and edit their own record (display name and email), and nothing else: not list people, not change a role (not even their own), not reset or delete anyone through this route (they have their own password change and their own account deletion).
 *
 * Pure: it looks at nothing but its arguments, so it cannot be fooled by state.
 */
export function authorise(actor: Actor, action: Action, targetId?: string): boolean {
  if (actor.role === 'admin') return true;
  if (actor.role !== 'user') return false; // an unknown role gets nothing
  return targetId !== undefined && targetId === actor.id && SELF_ACTIONS.includes(action);
}
