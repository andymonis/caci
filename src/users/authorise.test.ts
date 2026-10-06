import { describe, expect, it } from 'vitest';
import { ACTIONS, authorise, type Action } from './authorise.js';

const ME = 'u0000000000000001';
const OTHER = 'u0000000000000002';

/** The whole decision table, written out: every action, for each kind of caller and target. */
const TABLE: ReadonlyArray<readonly [Action, { admin: { self: boolean; other: boolean }; user: { self: boolean; other: boolean } }]> = [
  ['listUsers', { admin: { self: true, other: true }, user: { self: false, other: false } }],
  ['getUser', { admin: { self: true, other: true }, user: { self: true, other: false } }],
  ['updateUser', { admin: { self: true, other: true }, user: { self: true, other: false } }],
  ['changeRole', { admin: { self: true, other: true }, user: { self: false, other: false } }],
  ['resetPassword', { admin: { self: true, other: true }, user: { self: false, other: false } }],
  ['deleteUser', { admin: { self: true, other: true }, user: { self: false, other: false } }],
];

describe('authorise: the whole table, every role and action', () => {
  it('knows every action it is tested for, and no others', () => {
    expect([...ACTIONS].sort()).toEqual(TABLE.map(([action]) => action).sort());
  });

  it.each(TABLE)('%s', (action, expected) => {
    expect(authorise({ id: ME, role: 'admin' }, action, ME)).toBe(expected.admin.self);
    expect(authorise({ id: ME, role: 'admin' }, action, OTHER)).toBe(expected.admin.other);
    expect(authorise({ id: ME, role: 'user' }, action, ME)).toBe(expected.user.self);
    expect(authorise({ id: ME, role: 'user' }, action, OTHER)).toBe(expected.user.other);
  });

  it('an admin may do anything, even with no target (a list has none)', () => {
    for (const action of ACTIONS) expect(authorise({ id: ME, role: 'admin' }, action)).toBe(true);
  });

  it('a user with no target may do nothing, not even what they could do to themselves', () => {
    for (const action of ACTIONS) expect(authorise({ id: ME, role: 'user' }, action)).toBe(false);
  });

  it('a user may never change a role, not even their own: no promoting yourself', () => {
    expect(authorise({ id: ME, role: 'user' }, 'changeRole', ME)).toBe(false);
  });

  it('a role that is not user or admin gets nothing at all', () => {
    for (const role of ['root', '', 'ADMIN', 'Admin', undefined, null]) {
      for (const action of ACTIONS) {
        expect(authorise({ id: ME, role: role as never }, action, ME), `${String(role)} ${action}`).toBe(false);
        expect(authorise({ id: ME, role: role as never }, action, OTHER)).toBe(false);
      }
    }
  });

  it('compares ids exactly: a different case or a lookalike is someone else', () => {
    const actor = { id: ME, role: 'user' as const };
    for (const target of [ME.toUpperCase(), ME + ' ', ' ' + ME, ME.slice(0, -1), '']) expect(authorise(actor, 'getUser', target), target).toBe(false);
  });

  it('an action it does not know is refused, for a user (an admin is allowed everything by design)', () => {
    expect(authorise({ id: ME, role: 'user' }, 'dropEverything' as never, ME)).toBe(false);
  });
});
