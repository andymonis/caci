import { describe, expect, it } from 'vitest';
import { createApiClient } from './api-client.js';
import { createSettingsSession } from './settings-session.js';
import { world } from './sharing-world.test-util.mjs';

const USER = { id: 'u1', username: 'ann', displayName: 'Ann A' };
const okv = (value = USER) => ({ ok: true, value });
const bad = (kind, message = kind, extra = {}) => ({ ok: false, error: { kind, message, ...extra } });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function make(script = okv(), options = {}) {
  const calls = [];
  const api = {
    updateMe: (...a) => (calls.push(['updateMe', ...a]), Promise.resolve(typeof script === 'function' ? script('updateMe') : script)),
    changePassword: (...a) => (calls.push(['changePassword', ...a]), Promise.resolve(typeof script === 'function' ? script('changePassword') : script)),
  };
  return { calls, s: createSettingsSession({ api, ...options }) };
}

describe('saving the profile', () => {
  it('sends only what is filled in, and says Saved', async () => {
    const { s, calls } = make();
    expect(await s.saveProfile({ displayName: ' New ', email: '' })).toMatchObject({ ok: true, user: USER });
    expect(calls).toEqual([['updateMe', { displayName: 'New' }]]);
    expect(s.getState()).toEqual({ busy: false, notice: 'Saved.' });
  });
  it('sends nothing when nothing was changed, or a field is wrong, and names the field', async () => {
    const { s, calls } = make();
    expect(await s.saveProfile({})).toMatchObject({ ok: false, kind: 'invalid', errors: { displayName: expect.any(String) } });
    expect(await s.saveProfile({ email: 'nope' })).toMatchObject({ ok: false, kind: 'invalid', errors: { email: expect.any(String) } });
    expect(calls).toEqual([]);
    expect(s.getState().notice).toBe('');
  });
  it('removeEmail sends email null', async () => {
    const { s, calls } = make();
    await s.removeEmail();
    expect(calls).toEqual([['updateMe', { email: null }]]);
    expect(s.getState().notice).toBe('Your email was removed.');
  });
  it('a refusal comes back with the service\'s words, the field when it names one, and no notice', async () => {
    const { s } = make(bad('invalid', 'That email is not allowed', { field: 'email' }));
    expect(await s.saveProfile({ email: 'a@b.co' })).toMatchObject({ ok: false, kind: 'invalid', message: 'That email is not allowed', errors: { email: 'That email is not allowed' } });
    expect(s.getState().notice).toBe('');
  });
  it('tells the caller the new user, so the screen can show the new name', async () => {
    const seen = [];
    const { s } = make(okv({ ...USER, displayName: 'New' }), { onUser: (u) => seen.push(u.displayName) });
    await s.saveProfile({ displayName: 'New' });
    expect(seen).toEqual(['New']);
  });
});

describe('changing the password', () => {
  it('checks early, then sends exactly the two passwords, and never keeps them', async () => {
    const { s, calls } = make();
    expect(await s.changePassword({ currentPassword: '', newPassword: 'short' })).toMatchObject({ ok: false, errors: { currentPassword: expect.any(String), newPassword: expect.any(String) } });
    expect(calls).toEqual([]);
    const r = await s.changePassword({ currentPassword: 'old password 1', newPassword: 'brand new password 2', extra: 'x' });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([['changePassword', { currentPassword: 'old password 1', newPassword: 'brand new password 2' }]]);
    expect(s.getState().notice).toBe('Your password was changed. Your other devices were signed out.');
    const everything = JSON.stringify([s.getState(), r]);
    expect(everything).not.toContain('old password 1');
    expect(everything).not.toContain('brand new password 2');
  });
  it('a wrong current password is the service\'s words on that field', async () => {
    const { s } = make(bad('invalid', 'currentPassword is incorrect', { field: 'currentPassword' }));
    const r = await s.changePassword({ currentPassword: 'wrong wrong wrong', newPassword: 'brand new password 2' });
    expect(r).toMatchObject({ ok: false, errors: { currentPassword: 'currentPassword is incorrect' } });
    expect(JSON.stringify(r)).not.toContain('wrong wrong wrong');
  });
  it('a hold-back carries the wait', async () => {
    const { s } = make(bad('throttled', 'Too many tries', { retryAfterSeconds: 30 }));
    expect(await s.changePassword({ currentPassword: 'x', newPassword: 'brand new password 2' })).toMatchObject({ ok: false, kind: 'throttled', retryAfterSeconds: 30 });
  });
});

describe('one request at a time, and signing out', () => {
  it('a second call meanwhile sends nothing', async () => {
    const d = deferred();
    const { s, calls } = make(() => d.promise);
    const first = s.saveProfile({ displayName: 'A' });
    expect(s.getState().busy).toBe(true);
    expect(await s.saveProfile({ displayName: 'B' })).toMatchObject({ ok: false, kind: 'busy' });
    expect(await s.removeEmail()).toMatchObject({ ok: false, kind: 'busy' });
    expect(await s.changePassword({ currentPassword: 'x', newPassword: 'brand new password 2' })).toMatchObject({ ok: false, kind: 'busy' });
    expect(calls).toHaveLength(1);
    d.resolve(okv());
    await first;
    expect(s.getState().busy).toBe(false);
  });
  it('busy clears after a failure or a client that throws', async () => {
    const { s } = make(bad('server'));
    await s.saveProfile({ displayName: 'A' });
    expect(s.getState().busy).toBe(false);
    const t = createSettingsSession({ api: { updateMe: () => Promise.reject(new Error('x')), changePassword: () => okv() } });
    expect(await t.saveProfile({ displayName: 'A' })).toMatchObject({ ok: false, kind: 'server' });
    expect(t.getState().busy).toBe(false);
  });
  it('a signed-out answer is reported, and a throwing hook changes nothing', async () => {
    let told = 0;
    const { s } = make(bad('signed-out'), { onSignedOut: () => told++ });
    await s.saveProfile({ displayName: 'A' });
    expect(told).toBe(1);
    const t = make(bad('signed-out'), { onSignedOut: () => { throw new Error('x'); } });
    await expect(t.s.saveProfile({ displayName: 'A' })).resolves.toMatchObject({ ok: false });
    const other = make(bad('server'), { onSignedOut: () => told++ });
    await other.s.saveProfile({ displayName: 'A' });
    expect(told).toBe(1);
  });
  it('reset forgets the notice; listeners hear the changes; construction needs a client', async () => {
    const { s } = make();
    const seen = [];
    const un = s.subscribe((v) => seen.push(v.busy));
    s.subscribe(() => { throw new Error('x'); });
    await s.saveProfile({ displayName: 'A' });
    expect(seen).toEqual([true, false]);
    s.reset();
    expect(s.getState().notice).toBe('');
    un();
    expect(() => createSettingsSession({})).toThrow(TypeError);
  });
});

describe('against the real service', () => {
  it('changes the name and email, removes the email, and changes the password (this session stays, the old password stops working)', async () => {
    const w = await world();
    const api = createApiClient({ fetchFn: w.cat.fetch });
    const s = createSettingsSession({ api });
    expect((await api.me()).value.displayName).toBe('Display cat');
    expect(await s.saveProfile({ displayName: 'Cat Two', email: 'cat@example.test' })).toMatchObject({ ok: true, user: { displayName: 'Cat Two' } });
    expect((await api.me()).value.displayName).toBe('Cat Two');
    expect(await s.saveProfile({ email: 'bad address' })).toMatchObject({ ok: false, kind: 'invalid' });
    expect(await s.removeEmail()).toMatchObject({ ok: true });

    const other = createApiClient({ fetchFn: w.cat.fetch });
    const second = createApiClient({ fetchFn: (path, init) => w.cat.fetch(path, init) });
    expect((await second.me()).ok).toBe(true);
    const wrong = await s.changePassword({ currentPassword: 'definitely not it 12', newPassword: 'a brand new password 9' });
    expect(wrong).toMatchObject({ ok: false, kind: 'invalid', errors: { currentPassword: expect.any(String) } });
    const done = await s.changePassword({ currentPassword: 'correct horse 7 staple', newPassword: 'a brand new password 9' });
    expect(done.ok).toBe(true);
    expect((await other.me()).ok).toBe(true); // this very session stays
    const fresh = createApiClient({ fetchFn: (await import('./sharing-world.test-util.mjs')).browserFetch(w.service.port) });
    expect((await fresh.login({ username: 'cat', password: 'correct horse 7 staple' })).ok).toBe(false);
    expect((await fresh.login({ username: 'cat', password: 'a brand new password 9' })).ok).toBe(true);
    expect((await s.changePassword({ currentPassword: 'a brand new password 9', newPassword: 'a brand new password 9' })).ok).toBe(false);
  });
  it('a weak new password is refused in the service\'s words, on its field', async () => {
    const w = await world();
    const s = createSettingsSession({ api: createApiClient({ fetchFn: w.bob.fetch }) });
    const r = await s.changePassword({ currentPassword: 'correct horse 7 staple', newPassword: 'passwordpassword' });
    expect(r).toMatchObject({ ok: false, kind: 'invalid', errors: { newPassword: expect.any(String) } });
  });
});
