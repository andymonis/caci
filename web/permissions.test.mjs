import { describe, expect, it } from 'vitest';
import { authorise } from '../src/circles/authorise.ts';
import { ACTIONS, can, circleControls, personControls, ROLE_WORDS, ROLES, rolesToGive, rolesToOffer } from './permissions.js';

const MAP = { rename: 'updateCircle', delete: 'deleteCircle', invite: 'invite', withdraw: 'revokeInvitation', changeRole: 'changeRole', remove: 'removeMember', leave: 'leave' };
const ACTORS = [...ROLES, undefined, 'admin', 'OWNER', null, 5];

describe('the page agrees with the service', () => {
  it('rename, delete and leave, for every actor', () => {
    for (const actor of ACTORS) for (const action of ['rename', 'delete', 'leave']) expect(can(actor, action), `${actor} ${action}`).toBe(authorise(actor, MAP[action]));
  });

  it('invite and withdraw, for every actor and every offered role', () => {
    for (const actor of ACTORS) for (const action of ['invite', 'withdraw']) for (const role of [...ROLES, undefined, 'admin']) expect(can(actor, action, { role }), `${actor} ${action} ${role}`).toBe(authorise(actor, MAP[action], { role }));
  });

  it('change a role, for every actor, target, new role and self flag', () => {
    let n = 0;
    for (const actor of ACTORS) for (const target of [...ROLES, undefined]) for (const role of [...ROLES, undefined]) for (const self of [false, true, undefined]) {
      expect(can(actor, 'changeRole', { target, role, self }), JSON.stringify({ actor, target, role, self })).toBe(authorise(actor, 'changeRole', { target, role, self }));
      n++;
    }
    expect(n).toBe(ACTORS.length * 5 * 5 * 3);
  });

  it('remove, for every actor, target and self flag', () => {
    for (const actor of ACTORS) for (const target of [...ROLES, undefined]) for (const self of [false, true, undefined]) expect(can(actor, 'remove', { target, self }), JSON.stringify({ actor, target, self })).toBe(authorise(actor, 'removeMember', { target, self }));
  });

  it('every page action has a service action', () => {
    expect(Object.keys(MAP).sort()).toEqual([...ACTIONS].sort());
  });
});

describe('the helpers', () => {
  it('what each role may offer', () => {
    expect(rolesToOffer('owner')).toEqual(['owner', 'manager', 'member', 'observer']);
    expect(rolesToOffer('manager')).toEqual(['member', 'observer']);
    expect(rolesToOffer('member')).toEqual([]);
    expect(rolesToOffer('observer')).toEqual([]);
    expect(rolesToOffer(undefined)).toEqual([]);
  });

  it('what each role may give to someone else', () => {
    expect(rolesToGive('owner', 'member')).toEqual(['owner', 'manager', 'member', 'observer']);
    expect(rolesToGive('manager', 'member')).toEqual(['member', 'observer']);
    expect(rolesToGive('manager', 'observer')).toEqual(['member', 'observer']);
    expect(rolesToGive('manager', 'manager')).toEqual([]);
    expect(rolesToGive('manager', 'owner')).toEqual([]);
    expect(rolesToGive('member', 'observer')).toEqual([]);
  });

  it('circle controls by role', () => {
    expect(circleControls('owner')).toEqual({ rename: true, delete: true, invite: true, leave: true });
    expect(circleControls('manager')).toEqual({ rename: true, delete: false, invite: true, leave: true });
    expect(circleControls('member')).toEqual({ rename: false, delete: false, invite: false, leave: true });
    expect(circleControls('observer')).toEqual({ rename: false, delete: false, invite: false, leave: true });
    expect(circleControls(undefined)).toEqual({ rename: false, delete: false, invite: false, leave: false });
    expect(Object.isFrozen(circleControls('owner'))).toBe(true);
  });

  it('person controls: nothing beside your own row, and managers only touch members and observers', () => {
    for (const actor of ROLES) for (const target of ROLES) {
      expect(personControls(actor, target, true), `${actor} ${target} self`).toEqual({ changeRole: false, remove: false });
      expect(personControls(actor, target, undefined), `${actor} ${target} unknown`).toEqual({ changeRole: false, remove: false });
    }
    expect(personControls('owner', 'owner', false)).toEqual({ changeRole: true, remove: true });
    expect(personControls('manager', 'member', false)).toEqual({ changeRole: true, remove: true });
    expect(personControls('manager', 'manager', false)).toEqual({ changeRole: false, remove: false });
    expect(personControls('manager', 'owner', false)).toEqual({ changeRole: false, remove: false });
    expect(personControls('member', 'observer', false)).toEqual({ changeRole: false, remove: false });
    expect(Object.isFrozen(personControls('owner', 'member', false))).toBe(true);
  });

  it('never throws on odd context', () => {
    for (const ctx of [undefined, null, 5, 'x', [], {}]) for (const action of [...ACTIONS, 'x', 5, undefined]) expect(() => can('owner', action, ctx)).not.toThrow();
  });
});

describe('the words', () => {
  it('each role has its plain words, as the spec says, frozen', () => {
    expect(Object.keys(ROLE_WORDS)).toEqual([...ROLES]);
    expect(ROLE_WORDS.owner).toBe('Everything: rename and delete the circle, invite and remove anyone, give anyone any role, including owner.');
    expect(ROLE_WORDS.manager).toBe('Invite and remove members and observers, and move people between those two. Never touches an owner or another manager.');
    expect(ROLE_WORDS.member).toBe('See the circle and who is in it, and leave.');
    expect(ROLE_WORDS.observer).toBe('The same as a member for now.');
    expect(Object.isFrozen(ROLE_WORDS) && Object.isFrozen(ROLES) && Object.isFrozen(ACTIONS)).toBe(true);
  });

  it('are the same as the spec table', async () => {
    const { readFileSync } = await import('node:fs');
    const spec = readFileSync(new URL('../specs/R-006-web-circles.md', import.meta.url), 'utf8');
    for (const role of ROLES) expect(spec).toContain(`| \`${role}\` | ${ROLE_WORDS[role]} |`);
  });
});
