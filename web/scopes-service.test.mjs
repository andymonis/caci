import { describe, expect, it } from 'vitest';
import { createBrainSession } from './brain-session.js';
import { createScopeSession } from './scope-session.js';
import { world } from './sharing-world.test-util.mjs';

// The scope client and sessions against the real service: real SQLite files, real HTTP, four accounts.

describe('scopes against the real service', () => {
  it('lists the scopes by role, captures into a circle, and browses circle and combined views', async () => {
    const w = await world();
    const c = w.ann.circles;
    // cat becomes an observer
    const roster = (await c.listMembers(w.circle)).value.items;
    expect((await c.changeRole(w.circle, w.cat.id, 'observer')).ok).toBe(true);
    expect(roster.length).toBe(3);

    const catScopes = createScopeSession({ client: w.cat.notes });
    await catScopes.load();
    const circleOfCat = catScopes.getState().scopes.find((x) => x.scope?.kind === 'circle');
    expect(circleOfCat.canCapture).toBe(false); // an observer reads but cannot capture
    expect(await catScopes.chooseCapture(circleOfCat.key)).toBe(false);
    expect(await catScopes.chooseBrowse(circleOfCat.key)).toBe(true);

    const bobScopes = createScopeSession({ client: w.bob.notes });
    await bobScopes.load();
    const target = bobScopes.getState().scopes.find((x) => x.scope?.kind === 'circle');
    expect(target.canCapture).toBe(true);
    expect(target.scope.circleId).toBe(w.circle);
    const proposed = await w.bob.notes.propose('Dentist appointment on Friday', target.scope);
    expect(proposed.ok).toBe(true);
    expect(proposed.value.scope).toMatchObject({ kind: 'circle', circleId: w.circle });
    expect((await w.bob.notes.approve(proposed.value.id)).ok).toBe(true);

    // the observer reads it; the observer cannot capture
    expect((await w.cat.notes.propose('hello there', { kind: 'circle', circleId: w.circle })).ok).toBe(false);
    const brain = createBrainSession({ client: w.cat.notes });
    brain.setScope({ kind: 'circle', circleId: w.circle, circleName: 'Club' });
    await brain.load();
    expect(brain.getState().categories.items.length).toBeGreaterThan(0);
    brain.setScope('mine');
    await brain.load();
    expect(brain.getState().categories.items.length).toBeGreaterThan(0);
    expect(brain.getState().categories.items.every((i) => i.scope !== undefined)).toBe(true);

    // a stranger reads a circle like a made-up one
    const dan = createBrainSession({ client: w.dan.notes });
    dan.setScope({ kind: 'circle', circleId: w.circle });
    await dan.load();
    expect(dan.getState().categories.status).toBe('gone');
  });
});
