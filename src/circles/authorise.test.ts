import { describe, expect, it } from 'vitest';
import { authorise, CIRCLE_ACTIONS, type AuthoriseContext } from './authorise.js';
import { CIRCLE_ROLES, type CircleRole } from './types.js';

// The permission table of R-004, written out as data on purpose, separately from the function, and
// compared over every combination.

const ROLES: readonly (CircleRole | undefined)[] = [undefined, ...CIRCLE_ROLES];
const OTHER_ROLES: readonly (CircleRole | undefined)[] = [undefined, ...CIRCLE_ROLES];
const SELF: readonly (boolean | undefined)[] = [undefined, true, false];
const LOW = ['member', 'observer'] as const;

const key = (actor: string | undefined, action: string, role: string | undefined, target: string | undefined, self: boolean | undefined) => `${actor}|${action}|role=${role}|target=${target}|self=${self}`;

const allowed = new Set<string>();
for (const actor of ROLES) for (const action of CIRCLE_ACTIONS) for (const role of OTHER_ROLES) for (const target of OTHER_ROLES) for (const self of SELF) {
  const add = (): void => void allowed.add(key(actor, action, role, target, self));
  if (actor === undefined) continue; // not a member: nothing, ever
  if (action === 'viewCircle' || action === 'listMembers' || action === 'leave') add();
  if (action === 'updateCircle' && (actor === 'owner' || actor === 'manager')) add();
  if (action === 'deleteCircle' && actor === 'owner') add();
  if ((action === 'invite' || action === 'revokeInvitation') && role !== undefined) {
    if (actor === 'owner') add();
    if (actor === 'manager' && (LOW as readonly string[]).includes(role)) add();
  }
  if (action === 'changeRole' && self === false && role !== undefined && target !== undefined) {
    if (actor === 'owner') add();
    if (actor === 'manager' && (LOW as readonly string[]).includes(target) && (LOW as readonly string[]).includes(role)) add();
  }
  if (action === 'removeMember' && self === false && target !== undefined) {
    if (actor === 'owner') add();
    if (actor === 'manager' && (LOW as readonly string[]).includes(target)) add();
  }
}

describe('the circle permission table', () => {
  it('has the nine actions the spec lists', () => {
    expect([...CIRCLE_ACTIONS].sort()).toEqual(['changeRole', 'deleteCircle', 'invite', 'leave', 'listMembers', 'removeMember', 'revokeInvitation', 'updateCircle', 'viewCircle']);
  });

  it('agrees with the table for every role, action, offered role, target role and self flag', () => {
    let checked = 0;
    const wrong: string[] = [];
    for (const actor of ROLES) for (const action of CIRCLE_ACTIONS) for (const role of OTHER_ROLES) for (const target of OTHER_ROLES) for (const self of SELF) {
      const context: { role?: CircleRole; target?: CircleRole; self?: boolean } = {};
      if (role !== undefined) context.role = role;
      if (target !== undefined) context.target = target;
      if (self !== undefined) context.self = self;
      const got = authorise(actor, action, context as AuthoriseContext);
      const want = allowed.has(key(actor, action, role, target, self));
      if (got !== want) wrong.push(`${key(actor, action, role, target, self)}: got ${got}, want ${want}`);
      checked++;
    }
    expect(checked).toBe(5 * 9 * 5 * 5 * 3);
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(allowed.size).toBeGreaterThan(300);
  });

  it('says the headline rules plainly', () => {
    // a manager cannot touch an owner or another manager
    for (const target of ['owner', 'manager'] as const) {
      expect(authorise('manager', 'changeRole', { target, role: 'member', self: false })).toBe(false);
      expect(authorise('manager', 'removeMember', { target, self: false })).toBe(false);
    }
    // nobody gives a role above their own: a manager cannot invite owners or managers
    expect(authorise('manager', 'invite', { role: 'owner' })).toBe(false);
    expect(authorise('manager', 'invite', { role: 'manager' })).toBe(false);
    expect(authorise('manager', 'invite', { role: 'member' })).toBe(true);
    // nobody changes their own role
    for (const actor of CIRCLE_ROLES) for (const role of CIRCLE_ROLES) expect(authorise(actor, 'changeRole', { target: actor, role, self: true })).toBe(false);
    // members and observers run nothing
    for (const actor of LOW) for (const action of ['updateCircle', 'deleteCircle', 'invite', 'revokeInvitation', 'changeRole', 'removeMember'] as const) {
      expect(authorise(actor, action, { role: 'member', target: 'member', self: false }), `${actor} ${action}`).toBe(false);
    }
    // only owners delete
    expect(CIRCLE_ROLES.filter((r) => authorise(r, 'deleteCircle'))).toEqual(['owner']);
    // a non-member can do nothing, even with a full context
    for (const action of CIRCLE_ACTIONS) expect(authorise(undefined, action, { role: 'member', target: 'member', self: false })).toBe(false);
  });

  it('refuses anything unrecognised', () => {
    expect(authorise('admin' as never, 'viewCircle')).toBe(false);
    expect(authorise('' as never, 'viewCircle')).toBe(false);
    expect(authorise('owner', 'transferEverything' as never)).toBe(false);
    expect(authorise('owner', 'invite', { role: 'wizard' as never })).toBe(false);
    expect(authorise('owner', 'changeRole', { target: 'wizard' as never, role: 'member', self: false })).toBe(false);
    expect(authorise('toString' as never, 'viewCircle')).toBe(false);
    expect(authorise('owner', '__proto__' as never)).toBe(false);
  });

  it('does not depend on anything but its arguments', () => {
    const context = Object.freeze({ role: 'member', target: 'observer', self: false } as const);
    const first = authorise('manager', 'changeRole', context);
    for (let i = 0; i < 5; i++) expect(authorise('manager', 'changeRole', context)).toBe(first);
  });
});
