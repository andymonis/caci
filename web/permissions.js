// What a role may do in a circle (R-004, R-006). Pure. This is a HINT for which controls to show: the
// service decides, and a test compares this table with the service's own over every combination, so a
// control is never shown that is always refused and never hidden when it is always allowed.

export const ROLES = Object.freeze(['owner', 'manager', 'member', 'observer']);

/** The plain words for each role, as the spec words them. */
export const ROLE_WORDS = Object.freeze({
  owner: 'Everything: rename and delete the circle, invite and remove anyone, give anyone any role, including owner.',
  manager: 'Invite and remove members and observers, and move people between those two. Never touches an owner or another manager.',
  member: 'See the circle and who is in it, and leave.',
  observer: 'The same as a member for now.',
});

export const ACTIONS = Object.freeze(['rename', 'delete', 'invite', 'withdraw', 'changeRole', 'remove', 'leave']);

const isRole = (value) => typeof value === 'string' && ROLES.includes(value);
const isLow = (role) => role === 'member' || role === 'observer';

/**
 * May someone whose role is `actor` do `action`? Anything unknown is no.
 * - invite, withdraw: `context.role` is the role offered.
 * - changeRole: `context.target` is the other person's role now, `context.role` the new one.
 * - remove: `context.target` is the other person's role.
 * changeRole and remove are about someone else: for your own row the answer is always no.
 */
export function can(actor, action, context = {}) {
  if (!isRole(actor)) return false;
  const { role, target } = context ?? {};
  switch (action) {
    case 'leave':
      return true;
    case 'rename':
      return actor === 'owner' || actor === 'manager';
    case 'delete':
      return actor === 'owner';
    case 'invite':
    case 'withdraw':
      return isRole(role) && (actor === 'owner' || (actor === 'manager' && isLow(role)));
    case 'changeRole':
      return isRole(target) && isRole(role) && context.self === false && (actor === 'owner' || (actor === 'manager' && isLow(target) && isLow(role)));
    case 'remove':
      return isRole(target) && context.self === false && (actor === 'owner' || (actor === 'manager' && isLow(target)));
    default:
      return false;
  }
}

/** The roles this person may offer in an invitation, in the order they are shown. */
export const rolesToOffer = (actor) => ROLES.filter((role) => can(actor, 'invite', { role }));

/** The roles this person may give someone else who has `target` now (their current role included, which is no change). */
export const rolesToGive = (actor, target) => ROLES.filter((role) => can(actor, 'changeRole', { target, role, self: false }));

/** What a role may do to a circle as a whole, for showing or hiding the buttons. */
export const circleControls = (actor) =>
  Object.freeze({
    rename: can(actor, 'rename'),
    delete: can(actor, 'delete'),
    invite: rolesToOffer(actor).length > 0,
    leave: can(actor, 'leave'),
  });

/** What a role may do to one other person on the roster. */
export const personControls = (actor, target, self) =>
  Object.freeze({
    changeRole: rolesToGive(actor, target).length > 0 && self === false,
    remove: can(actor, 'remove', { target, self }),
  });
