import { describe, expect, it } from 'vitest';
import { createAgentAccessSession } from './agent-access-session.js';

const TOKEN = `cpat_${'A'.repeat(43)}`;
const C1 = 'c0000000000000001';
const key = (id, name, extra = {}) => ({ id, name, scopes: ['personal'], checks: false, createdAt: 1, expiresAt: 2, lastUsedAt: null, ...extra });
const ok = (value) => ({ ok: true, value });
const bad = (kind, message = kind, extra = {}) => ({ ok: false, error: { kind, message, ...extra } });
const CIRCLES = [{ circleId: C1, circleName: 'Club' }];
const gate = () => {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
};

function setup(overrides = {}) {
  const state = { keys: [key('t0000000000000001', 'First')], listReply: undefined, createReply: undefined, revokeReply: undefined, hold: undefined };
  const calls = [];
  const client = {
    list: async () => {
      calls.push('list');
      if (state.hold) await state.hold.promise;
      return state.listReply ?? ok({ items: state.keys });
    },
    create: async (input) => {
      calls.push(['create', input]);
      if (state.hold) await state.hold.promise;
      return state.createReply ?? ok({ token: TOKEN, agentToken: key('t0000000000000002', input.name) });
    },
    revoke: async (id) => {
      calls.push(['revoke', id]);
      return state.revokeReply ?? ok(true);
    },
    ...overrides,
  };
  const signedOut = [];
  const session = createAgentAccessSession({ client, onSignedOut: () => signedOut.push(1) });
  return { session, state, calls, signedOut };
}
const input = { name: 'Desk', scopes: ['personal'], checks: false, days: 90 };

describe('opening', () => {
  it('requests nothing until it is opened, then holds the keys and the choices (own notes first, then each circle by name)', async () => {
    const { session, calls } = setup();
    expect(calls).toEqual([]);
    expect(session.getState()).toMatchObject({ status: 'idle', items: [], created: undefined });
    expect(await session.open(CIRCLES)).toMatchObject({ ok: true });
    const s = session.getState();
    expect(s.status).toBe('ready');
    expect(s.items.map((i) => i.name)).toEqual(['First']);
    expect(s.choices).toEqual([{ key: 'personal', label: 'My own notes' }, { key: `circle:${C1}`, label: 'Circle "Club"' }]);
    expect(Object.isFrozen(s)).toBe(true);
  });

  it('says unavailable when the service has agent access off, and then asks nothing more', async () => {
    const { session, state, calls } = setup();
    state.listReply = bad('unavailable');
    await session.open();
    expect(session.getState().status).toBe('unavailable');
    calls.length = 0;
    expect(await session.open()).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(calls).toEqual([]);
    session.reset();
    await session.open();
    expect(calls).toEqual(['list']); // a fresh start asks again
  });

  it('offers own notes alone when no circles are given, takes the latest circles each time, and reports a session that ended', async () => {
    const { session } = setup();
    await session.open();
    expect(session.getState().choices).toEqual([{ key: 'personal', label: 'My own notes' }]);
    await session.open(CIRCLES);
    expect(session.getState().choices).toHaveLength(2);
    await session.open([]); // the person left the circle
    expect(session.getState().choices).toEqual([{ key: 'personal', label: 'My own notes' }]);
    await session.open(CIRCLES);
    await session.open(undefined); // not given: what was known stays
    expect(session.getState().choices).toHaveLength(2);
    const again = setup();
    again.state.listReply = bad('signed-out');
    await again.session.open();
    expect(again.signedOut).toEqual([1]);
    expect(again.session.getState().status).toBe('error');
  });

  it('keeps what it knew when a later load fails', async () => {
    const { session, state } = setup();
    await session.open();
    state.listReply = bad('network', 'offline');
    await session.open();
    expect(session.getState()).toMatchObject({ status: 'ready', error: 'offline' });
    expect(session.getState().items).toHaveLength(1);
  });

  it('does one thing at a time', async () => {
    const { session, state, calls } = setup();
    state.hold = gate();
    const first = session.open();
    expect(await session.open()).toMatchObject({ ok: false, kind: 'busy' });
    expect(await session.create(input)).toMatchObject({ ok: false, kind: 'busy' });
    expect(session.getState().busy).toBe(true);
    state.hold.release();
    await first;
    expect(calls.filter((c) => c === 'list')).toHaveLength(1);
    expect(session.getState().busy).toBe(false);
  });
});

describe('making a key', () => {
  it('holds the new key once, in memory, with a notice, and lists the keys again without it', async () => {
    const { session, calls } = setup();
    await session.open();
    const r = await session.create(input);
    expect(r).toEqual({ ok: true });
    const s = session.getState();
    expect(s.created).toEqual({ token: TOKEN, name: 'Desk' });
    expect(s.notice).toContain('Copy it now');
    expect(JSON.stringify(s.items)).not.toContain(TOKEN);
    expect(calls.filter((c) => c === 'list')).toHaveLength(2); // opened, then reloaded after making one
    expect(calls.find((c) => Array.isArray(c))).toEqual(['create', input]);
    session.dismissCreated();
    expect(session.getState()).toMatchObject({ created: undefined, notice: '' });
  });

  it('a refusal makes nothing: it names the field, keeps no key, and says the service\'s words', async () => {
    const { session, state, signedOut } = setup();
    await session.open();
    state.createReply = bad('invalid', 'Give the key a name.', { field: 'name' });
    expect(await session.create(input)).toMatchObject({ ok: false, kind: 'invalid', errors: { name: 'Give the key a name.' } });
    expect(session.getState()).toMatchObject({ created: undefined, error: 'Give the key a name.' });
    state.createReply = bad('limit', 'You have the most keys allowed.');
    expect(await session.create(input)).toMatchObject({ ok: false, kind: 'limit', message: 'You have the most keys allowed.' });
    state.createReply = bad('signed-out');
    await session.create(input);
    expect(signedOut).toEqual([1]);
    state.createReply = bad('unavailable');
    await session.create(input);
    expect(session.getState().status).toBe('unavailable');
  });

  it('an old problem and an old notice are cleared when the next request starts', async () => {
    const { session, state } = setup();
    await session.open();
    state.createReply = bad('limit', 'Full.');
    await session.create(input);
    expect(session.getState().error).toBe('Full.');
    await session.open();
    expect(session.getState().error).toBe('');
    state.createReply = undefined;
    await session.create(input);
    expect(session.getState().notice).not.toBe('');
    await session.open();
    expect(session.getState().notice).toBe('');
  });

  it('a client that throws is a fixed server message and the session keeps working', async () => {
    const { session } = setup({ create: async () => { throw new Error('boom'); } });
    await session.open();
    expect(await session.create(input)).toMatchObject({ ok: false, kind: 'server' });
    expect(session.getState().busy).toBe(false);
    expect(JSON.stringify(session.getState())).not.toContain('boom');
  });
});

describe('stopping a key', () => {
  it('asks first (nothing is sent), can be cancelled, and stops the key it asked about', async () => {
    const { session, calls } = setup();
    await session.open();
    expect(session.askRevoke('t0000000000000009')).toBe(false); // not one of the person's keys
    expect(session.askRevoke('t0000000000000001')).toBe(true);
    expect(session.getState().asking).toBe('t0000000000000001');
    expect(calls.some((c) => Array.isArray(c))).toBe(false);
    session.cancel();
    expect(session.getState().asking).toBeUndefined();
    session.cancel(); // silent when nothing is asked
    expect(await session.confirmRevoke()).toMatchObject({ ok: false, kind: 'nothing-asked' });
    session.askRevoke('t0000000000000001');
    expect(await session.confirmRevoke()).toEqual({ ok: true });
    expect(calls).toContainEqual(['revoke', 't0000000000000001']);
    expect(session.getState()).toMatchObject({ asking: undefined });
    expect(session.getState().notice).toContain('Stopped "First"');
  });

  it('a key that is already gone counts as stopped, and any other failure says its words and keeps the key listed', async () => {
    const { session, state } = setup();
    await session.open();
    session.askRevoke('t0000000000000001');
    state.revokeReply = bad('not-found');
    expect(await session.confirmRevoke()).toEqual({ ok: true });
    session.askRevoke('t0000000000000001');
    state.revokeReply = bad('server', 'It did not work.');
    expect(await session.confirmRevoke()).toMatchObject({ ok: false, kind: 'server' });
    expect(session.getState()).toMatchObject({ error: 'It did not work.', asking: undefined });
    expect(session.getState().items).toHaveLength(1);
  });

  it('cannot ask while a request is out', async () => {
    const { session, state } = setup();
    await session.open();
    state.hold = gate();
    const making = session.create(input);
    expect(session.askRevoke('t0000000000000001')).toBe(false);
    state.hold.release();
    await making;
  });
});

describe('forgetting', () => {
  it('reset forgets the keys, the choices and a new key, and an answer still on its way is dropped', async () => {
    const { session, state } = setup();
    await session.open();
    await session.create(input);
    expect(session.getState().created).toBeDefined();
    session.reset();
    expect(session.getState()).toMatchObject({ status: 'idle', items: [], created: undefined, asking: undefined, notice: '', error: '', busy: false });
    expect(session.getState().choices).toEqual([{ key: 'personal', label: 'My own notes' }]);

    state.hold = gate();
    const late = session.create(input);
    session.reset();
    state.hold.release();
    expect(await late).toMatchObject({ ok: false, kind: 'dropped' });
    expect(session.getState()).toMatchObject({ created: undefined, status: 'idle' }); // the late key was not kept
  });

  it('a late open after a reset draws nothing and does not clear a newer request\'s busy mark', async () => {
    const { session, state } = setup();
    const first = gate();
    state.hold = first;
    const old = session.open();
    session.reset();
    const second = gate();
    state.hold = second;
    const fresh = session.open();
    expect(session.getState().busy).toBe(true);
    first.release();
    await old;
    expect(session.getState().busy).toBe(true); // the old request finishing did not clear the newer one's mark
    expect(session.getState().status).not.toBe('ready'); // and drew nothing
    second.release();
    await fresh;
    expect(session.getState()).toMatchObject({ status: 'ready', busy: false });
  });

  it('refuses to be made without clients', () => {
    expect(() => createAgentAccessSession({ client: {} })).toThrow(TypeError);
    expect(() => createAgentAccessSession({})).toThrow(TypeError);
  });

  it('a broken listener does not stop the others, and unsubscribing works', async () => {
    const { session } = setup();
    const seen = [];
    session.subscribe(() => { throw new Error('bad listener'); });
    const stop = session.subscribe((s) => seen.push(s.status));
    await session.open();
    expect(seen.length).toBeGreaterThan(0);
    stop();
    const n = seen.length;
    session.reset();
    expect(seen.length).toBe(n);
  });
});
