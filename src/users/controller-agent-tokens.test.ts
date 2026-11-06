import { describe, expect, it } from 'vitest';
import { CTX, must, PW, reg, T0, world, type World } from './controller.test-util.js';
import type { User } from './types.js';

const DAY = 86_400_000;
const CIRCLE = 'circle:cabcdefghij012345';

async function signedIn(w: World, name: string): Promise<{ user: User; token: string }> {
  const user = await must<User>(reg(w.controller, name));
  const { token } = await must<{ token: string }>(w.controller.login({ username: name, password: PW }, CTX));
  return { user, token };
}
const make = (w: World, session: string, extra: object = {}) => w.controller.createAgentToken(session, { name: 'My agent', scopes: ['personal'], ...extra });

describe('createAgentToken', () => {
  it('makes a read-only token, shown once, expiring in 90 days unless asked otherwise', async () => {
    const w = world();
    const { user, token } = await signedIn(w, 'ann');
    const made = await must<{ token: string; agentToken: Record<string, unknown> }>(make(w, token, { scopes: ['personal', CIRCLE], checks: true }));
    expect(made.token).toMatch(/^cpat_[A-Za-z0-9_-]{43}$/);
    expect(made.agentToken).toEqual({ id: expect.stringMatching(/^t[a-z0-9]{16}$/), name: 'My agent', scopes: ['personal', CIRCLE], checks: true, createdAt: T0, expiresAt: T0 + 90 * DAY, lastUsedAt: null });
    expect(JSON.stringify(made.agentToken)).not.toContain(user.id); // the person's own id is not in the view
    expect(await w.agentTokens.resolve(made.token, T0 + 1)).toMatchObject({ userId: user.id, scopes: ['personal', CIRCLE], checks: true });
  });

  it('has the checks flag off unless it is asked for', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    expect((await must<{ agentToken: { checks: boolean } }>(make(w, token))).agentToken.checks).toBe(false);
    expect((await must<{ agentToken: { checks: boolean } }>(make(w, token, { checks: true }))).agentToken.checks).toBe(true);
  });

  it('takes days from 1 to 365 and refuses anything else, naming the field', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    expect((await must<{ agentToken: { expiresAt: number } }>(make(w, token, { days: 1 }))).agentToken.expiresAt).toBe(T0 + DAY);
    expect((await must<{ agentToken: { expiresAt: number } }>(make(w, token, { days: 365 }))).agentToken.expiresAt).toBe(T0 + 365 * DAY);
    for (const days of [0, 366, -1, 1.5, '30', null, Number.NaN]) expect(await make(w, token, { days }), String(days)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'days' } });
  });

  it('names the field of a bad name, scopes or checks, and refuses unknown fields', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    expect(await make(w, token, { name: '' })).toMatchObject({ ok: false, error: { field: 'name' } });
    expect(await make(w, token, { scopes: [] })).toMatchObject({ ok: false, error: { field: 'scopes' } });
    expect(await make(w, token, { scopes: ['circle:nope'] })).toMatchObject({ ok: false, error: { field: 'scopes' } });
    expect(await make(w, token, { checks: 'yes' })).toMatchObject({ ok: false, error: { field: 'checks' } });
    expect(await make(w, token, { userId: 'u0000000000000009' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'token' } });
    expect(await make(w, token, { mode: 'write' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    for (const input of [null, undefined, 5, 'x', ['personal']]) expect(await w.controller.createAgentToken(token, input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await w.agentTokens.list((await must<{ user: User }>(w.controller.getMe(token))).user.id, T0)).toEqual([]); // nothing was made
  });

  it('refuses the eleventh token, as a conflict', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    for (let i = 0; i < 10; i++) await must(make(w, token, { name: `a${i}` }));
    expect(await make(w, token)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('needs a live session, and gives the same answer for any bad one', async () => {
    const w = world();
    await signedIn(w, 'ann');
    for (const bad of [undefined, null, 5, '', 'garbage', 'A'.repeat(43)]) expect(await make(w, bad as string)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('a token is not a session: an agent token cannot be used to make another', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    const made = await must<{ token: string }>(make(w, token));
    expect(await make(w, made.token)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(await w.controller.listAgentTokens(made.token)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('answers NOT_FOUND when agent access is not set up', async () => {
    const w = world({ agentTokens: false });
    const { token } = await signedIn(w, 'ann');
    expect(await make(w, token)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await w.controller.listAgentTokens(token)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await w.controller.revokeAgentToken(token, 't0000000000000000')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('listAgentTokens and revokeAgentToken', () => {
  it('lists only the caller\'s live tokens, newest first, never a token', async () => {
    const w = world();
    const ann = await signedIn(w, 'ann');
    const bob = await signedIn(w, 'bob');
    const a1 = await must<{ token: string }>(make(w, ann.token, { name: 'first' }));
    w.now.value += 1000;
    await must(make(w, ann.token, { name: 'second' }));
    await must(make(w, bob.token, { name: 'bobs' }));
    await must(make(w, ann.token, { name: 'short', days: 1 }));
    w.now.value += 2 * DAY; // sessions idle out after 30 minutes, so sign in again
    const again = await must<{ token: string }>(w.controller.login({ username: 'ann', password: PW }, CTX));
    const list = await must<{ items: ReadonlyArray<{ name: string }> }>(w.controller.listAgentTokens(again.token));
    expect(list.items.map((i) => i.name)).toEqual(['second', 'first']);
    expect(JSON.stringify(list)).not.toContain(a1.token);
    expect(list.items.every((i) => !('userId' in i))).toBe(true);
  });

  it('ends one of the caller\'s tokens, once; another person cannot end it', async () => {
    const w = world();
    const ann = await signedIn(w, 'ann');
    const bob = await signedIn(w, 'bob');
    const made = await must<{ token: string; agentToken: { id: string } }>(make(w, ann.token));
    expect(await w.controller.revokeAgentToken(bob.token, made.agentToken.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await w.agentTokens.resolve(made.token, T0 + 1)).toBeDefined();
    expect(await w.controller.revokeAgentToken(ann.token, made.agentToken.id)).toEqual({ ok: true, value: true });
    expect(await w.agentTokens.resolve(made.token, T0 + 1)).toBeUndefined();
    expect(await w.controller.revokeAgentToken(ann.token, made.agentToken.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    for (const odd of [undefined, 5, '', {}]) expect(await w.controller.revokeAgentToken(ann.token, odd)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('ending tokens', () => {
  it('changing your password ends ALL your agent tokens (and only yours)', async () => {
    const w = world();
    const ann = await signedIn(w, 'ann');
    const bob = await signedIn(w, 'bob');
    const mine = await must<{ token: string }>(make(w, ann.token));
    const his = await must<{ token: string }>(make(w, bob.token));
    await must(w.controller.changePassword(ann.token, { currentPassword: PW, newPassword: 'a different long passphrase 9' }, CTX));
    expect(await w.agentTokens.resolve(mine.token, T0 + 1)).toBeUndefined();
    expect(await w.agentTokens.resolve(his.token, T0 + 1)).toBeDefined();
    expect(await w.controller.getMe(ann.token)).toMatchObject({ ok: true }); // the session you used survives, as before
  });

  it('an admin resetting a password ends all of that person\'s tokens', async () => {
    const w = world();
    const admin = await signedIn(w, 'root');
    const ann = await signedIn(w, 'ann');
    const mine = await must<{ token: string }>(make(w, ann.token));
    await must(w.controller.resetPassword(admin.token, ann.user.id, { newPassword: 'a different long passphrase 9' }));
    expect(await w.agentTokens.resolve(mine.token, T0 + 1)).toBeUndefined();
  });

  it('deleting the account ends the tokens (the controller does it for stores that do not do it themselves)', async () => {
    const w = world();
    await signedIn(w, 'root');
    const ann = await signedIn(w, 'ann');
    const mine = await must<{ token: string }>(make(w, ann.token));
    await must(w.controller.deleteMe(ann.token, { password: PW }, CTX));
    expect(await w.agentTokens.resolve(mine.token, T0 + 1)).toBeUndefined();
  });

  it('a failure to end the tokens is reported and says the password WAS changed', async () => {
    const w = world();
    const ann = await signedIn(w, 'ann');
    const broken = { ...w.agentTokens, revokeAllFor: async () => { throw new Error('boom'); } };
    const w2 = world({ reuse: { users: w.users, sessions: w.sessions, graphs: w.graphs }, agentTokens: broken });
    const again = await must<{ token: string }>(w2.controller.login({ username: 'ann', password: PW }, CTX));
    const r = await w2.controller.changePassword(again.token, { currentPassword: PW, newPassword: 'a different long passphrase 9' }, CTX);
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(JSON.stringify(r)).toContain('was changed');
    expect(JSON.stringify(r)).not.toContain('boom');
    void ann;
  });
});
