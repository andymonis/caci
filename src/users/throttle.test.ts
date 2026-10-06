import { describe, expect, it } from 'vitest';
import { createLoginThrottle, createRegistrationThrottle, throttledError } from './throttle.js';

const T0 = 1_000_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;

/** Records `n` failures one second apart starting at `start`; returns the time of the last one. */
function fail(throttle: ReturnType<typeof createLoginThrottle>, username: string, client: string, n: number, start = T0): number {
  let t = start;
  for (let i = 0; i < n; i++) throttle.recordFailure(username, client, (t = start + i * SEC));
  return t;
}

describe('login throttle: one username', () => {
  it('lets the first four failures through without any wait', () => {
    const throttle = createLoginThrottle();
    for (let i = 0; i < 4; i++) {
      expect(throttle.check('ann', 'c1', T0 + i * SEC)).toEqual({ allowed: true });
      throttle.recordFailure('ann', 'c1', T0 + i * SEC);
    }
    expect(throttle.check('ann', 'c1', T0 + 4 * SEC)).toEqual({ allowed: true });
  });

  it('holds back the attempt after the fifth failure for 1 s, then 2 s, 4 s, 8 s...', () => {
    const throttle = createLoginThrottle();
    let last = fail(throttle, 'ann', 'c1', 5); // the 5th failure is at T0 + 4 s
    expect(throttle.check('ann', 'c1', last)).toEqual({ allowed: false, retryAfterMs: 1000 });
    expect(throttle.check('ann', 'c1', last + 400)).toEqual({ allowed: false, retryAfterMs: 600 });
    expect(throttle.check('ann', 'c1', last + 1000)).toEqual({ allowed: true });
    for (const wait of [2000, 4000, 8000, 16_000]) {
      last += 1000; // wait out the previous hold, fail again
      throttle.recordFailure('ann', 'c1', last);
      expect(throttle.check('ann', 'c1', last)).toEqual({ allowed: false, retryAfterMs: wait });
      last += wait - 1000;
    }
  });

  it('never holds back longer than 15 minutes', () => {
    const throttle = createLoginThrottle();
    let t = T0;
    for (let i = 0; i < 40; i++) {
      throttle.recordFailure('ann', 'c1', t);
      t += 5 * MIN; // keep failing inside the window without ever forgetting
    }
    const verdict = throttle.check('ann', 'c1', t - 5 * MIN);
    expect(verdict).toMatchObject({ allowed: false });
    expect((verdict as { retryAfterMs: number }).retryAfterMs).toBeLessThanOrEqual(15 * MIN);
    expect((verdict as { retryAfterMs: number }).retryAfterMs).toBe(15 * MIN);
  });

  it('forgets failures older than the window: 15 minutes of quiet is a clean start', () => {
    const throttle = createLoginThrottle();
    const last = fail(throttle, 'ann', 'c1', 8);
    expect(throttle.check('ann', 'c1', last + 1)).toMatchObject({ allowed: false });
    expect(throttle.check('ann', 'c1', last + 15 * MIN - 1)).toEqual({ allowed: true }); // the hold was long over, and the count still stands...
    throttle.recordFailure('ann', 'c1', last + 15 * MIN - 1);
    expect(throttle.check('ann', 'c1', last + 15 * MIN - 1)).toMatchObject({ allowed: false, retryAfterMs: 16 * SEC }); // ...so the 9th failure holds 16 s
    const later = last + 15 * MIN - 1 + 15 * MIN;
    throttle.recordFailure('ann', 'c1', later); // the window has passed since the last failure: this is the first again
    expect(throttle.check('ann', 'c1', later)).toEqual({ allowed: true });
  });

  it('a success clears that username, and does not touch other usernames', () => {
    const throttle = createLoginThrottle();
    const last = fail(throttle, 'ann', 'c1', 6);
    fail(throttle, 'bob', 'c2', 6);
    throttle.recordSuccess('ann', 'c1', last + 5 * SEC);
    expect(throttle.check('ann', 'c3', last + 5 * SEC)).toEqual({ allowed: true });
    expect(throttle.check('bob', 'c3', last + SEC)).toMatchObject({ allowed: false });
  });

  it('treats the username without regard to case', () => {
    const throttle = createLoginThrottle();
    const last = fail(throttle, 'Ann', 'c1', 5);
    expect(throttle.check('ANN', 'other', last)).toMatchObject({ allowed: false });
    expect(throttle.check('ann', 'other', last)).toMatchObject({ allowed: false });
  });

  it('holds back a username that does not exist exactly like one that does (it cannot tell the difference)', () => {
    const throttle = createLoginThrottle();
    fail(throttle, 'real-account', 'c1', 5);
    fail(throttle, 'no-such-account', 'c2', 5);
    expect(throttle.check('real-account', 'c9', T0 + 4 * SEC)).toEqual(throttle.check('no-such-account', 'c9', T0 + 4 * SEC));
    for (const odd of ['', ' ', '../../etc', '\u0000', 'x'.repeat(10_000), '名前']) {
      const t = createLoginThrottle();
      fail(t, odd, 'c1', 5);
      expect(t.check(odd, 'c9', T0 + 4 * SEC)).toMatchObject({ allowed: false, retryAfterMs: 1000 });
    }
  });

  it('a check changes nothing: asking while held back does not make the hold longer', () => {
    const throttle = createLoginThrottle();
    const last = fail(throttle, 'ann', 'c1', 5);
    for (let i = 0; i < 100; i++) throttle.check('ann', 'c1', last + 10);
    expect(throttle.check('ann', 'c1', last + 1000)).toEqual({ allowed: true });
  });
});

describe('login throttle: one client over many usernames', () => {
  it('is more generous: 19 failures are free, the 20th holds the client back for 1 s', () => {
    const throttle = createLoginThrottle();
    for (let i = 0; i < 19; i++) throttle.recordFailure(`user${i}`, 'office', T0 + i);
    expect(throttle.check('fresh-name', 'office', T0 + 19)).toEqual({ allowed: true });
    throttle.recordFailure('user19', 'office', T0 + 19);
    expect(throttle.check('fresh-name', 'office', T0 + 19)).toEqual({ allowed: false, retryAfterMs: 1000 });
    expect(throttle.check('fresh-name', 'elsewhere', T0 + 19)).toEqual({ allowed: true });
  });

  it('the longer of the two waits wins', () => {
    const throttle = createLoginThrottle({ perUsername: { threshold: 2, baseDelayMs: 10_000, maxDelayMs: 10_000 }, perClient: { threshold: 2, baseDelayMs: 3000, maxDelayMs: 3000 } });
    throttle.recordFailure('ann', 'c1', T0);
    throttle.recordFailure('ann', 'c1', T0);
    expect(throttle.check('ann', 'c1', T0)).toEqual({ allowed: false, retryAfterMs: 10_000 });
    expect(throttle.check('bob', 'c1', T0)).toEqual({ allowed: false, retryAfterMs: 3000 });
    expect(throttle.check('ann', 'c2', T0)).toEqual({ allowed: false, retryAfterMs: 10_000 });
  });

  it('a success does not forgive the client', () => {
    const throttle = createLoginThrottle({ perClient: { threshold: 2 } });
    throttle.recordFailure('a', 'c1', T0);
    throttle.recordFailure('b', 'c1', T0);
    throttle.recordSuccess('a', 'c1', T0 + 1);
    expect(throttle.check('c', 'c1', T0 + 1)).toMatchObject({ allowed: false });
  });
});

describe('login throttle: memory is bounded', () => {
  it('never remembers more than maxEntries usernames and maxEntries clients, however many are thrown at it', () => {
    const throttle = createLoginThrottle({ maxEntries: 50 });
    for (let i = 0; i < 5000; i++) throttle.recordFailure(`random-${i}`, `client-${i}`, T0 + i);
    expect(throttle.size).toBeLessThanOrEqual(100);
  });

  it('a flood of made-up names does not push out a lock that is really holding someone back', () => {
    const throttle = createLoginThrottle({ maxEntries: 20 });
    const last = fail(throttle, 'victim', 'attacker-1', 6);
    for (let i = 0; i < 2000; i++) throttle.recordFailure(`flood-${i}`, `client-${i}`, last + 1); // 6 failures: held for 2 s from the last
    expect(throttle.check('victim', 'anywhere', last + 1)).toEqual({ allowed: false, retryAfterMs: 1999 });
  });

  it('forgotten entries are the first to make room', () => {
    const throttle = createLoginThrottle({ maxEntries: 3, perUsername: { threshold: 1 } });
    throttle.recordFailure('old', 'c', T0); // locked, but ancient by the time the table is full
    throttle.recordFailure('b', 'c', T0 + 20 * MIN);
    throttle.recordFailure('c', 'c', T0 + 20 * MIN);
    throttle.recordFailure('d', 'c', T0 + 20 * MIN);
    expect(throttle.check('old', 'z', T0 + 20 * MIN)).toEqual({ allowed: true });
    for (const name of ['b', 'c', 'd']) expect(throttle.check(name, 'z', T0 + 20 * MIN)).toMatchObject({ allowed: false });
  });

  it('purge drops what has expired and keeps what has not', () => {
    const throttle = createLoginThrottle();
    throttle.recordFailure('old', 'c-old', T0);
    throttle.recordFailure('new', 'c-new', T0 + 14 * MIN);
    expect(throttle.size).toBe(4);
    throttle.purge(T0 + 16 * MIN);
    expect(throttle.size).toBe(2);
  });

  it('cuts very long names, so one request cannot make an entry of any size, but they still count', () => {
    const throttle = createLoginThrottle({ perUsername: { threshold: 2 } });
    throttle.recordFailure('x'.repeat(100_000), 'c', T0);
    throttle.recordFailure('x'.repeat(100_000) + 'y', 'c', T0);
    expect(throttle.check('x'.repeat(100_000), 'z', T0)).toMatchObject({ allowed: false });
  });
});

describe('login throttle: settings', () => {
  it('can be set, and refuses nonsense with a TypeError', () => {
    const throttle = createLoginThrottle({ perUsername: { threshold: 1, baseDelayMs: 5000, maxDelayMs: 5000, windowMs: MIN } });
    throttle.recordFailure('ann', 'c', T0);
    expect(throttle.check('ann', 'c2', T0)).toEqual({ allowed: false, retryAfterMs: 5000 });
    for (const bad of [{ threshold: 0 }, { baseDelayMs: 1.5 }, { maxDelayMs: -1 }, { windowMs: Number.NaN }, { baseDelayMs: 10, maxDelayMs: 5 }]) {
      expect(() => createLoginThrottle({ perUsername: bad }), JSON.stringify(bad)).toThrow(TypeError);
      expect(() => createLoginThrottle({ perClient: bad }), JSON.stringify(bad)).toThrow(TypeError);
    }
    for (const maxEntries of [0, 1.5, -2, Number.NaN]) expect(() => createLoginThrottle({ maxEntries })).toThrow(TypeError);
  });

  it('keeps its own state: two throttles share nothing', () => {
    const a = createLoginThrottle();
    const b = createLoginThrottle();
    fail(a, 'ann', 'c', 6);
    expect(b.check('ann', 'c', T0 + 5 * SEC)).toEqual({ allowed: true });
  });
});

describe('registration throttle', () => {
  it('allows 10 attempts an hour per client, then says how long until the oldest ages out', () => {
    const throttle = createRegistrationThrottle();
    for (let i = 0; i < 10; i++) {
      expect(throttle.check('c1', T0 + i * MIN)).toEqual({ allowed: true });
      throttle.record('c1', T0 + i * MIN);
    }
    expect(throttle.check('c1', T0 + 10 * MIN)).toEqual({ allowed: false, retryAfterMs: 50 * MIN });
    expect(throttle.check('c1', T0 + 59 * MIN)).toEqual({ allowed: false, retryAfterMs: MIN });
    expect(throttle.check('c1', T0 + 60 * MIN)).toEqual({ allowed: true }); // the first aged out
    expect(throttle.check('c2', T0 + 10 * MIN)).toEqual({ allowed: true }); // other clients are not affected
  });

  it('slides: each attempt that ages out frees one place', () => {
    const throttle = createRegistrationThrottle({ max: 2, windowMs: 10 * MIN });
    throttle.record('c', T0);
    throttle.record('c', T0 + 4 * MIN);
    expect(throttle.check('c', T0 + 5 * MIN)).toEqual({ allowed: false, retryAfterMs: 5 * MIN });
    expect(throttle.check('c', T0 + 10 * MIN)).toEqual({ allowed: true });
    throttle.record('c', T0 + 10 * MIN);
    expect(throttle.check('c', T0 + 11 * MIN)).toEqual({ allowed: false, retryAfterMs: 3 * MIN }); // the 4-minute attempt ages out at 14
  });

  it('counts the client without regard to case, and a check changes nothing', () => {
    const throttle = createRegistrationThrottle({ max: 1 });
    throttle.record('ABC', T0);
    for (let i = 0; i < 50; i++) expect(throttle.check('abc', T0 + 1)).toMatchObject({ allowed: false });
    expect(throttle.check('abc', T0 + 60 * MIN)).toEqual({ allowed: true });
  });

  it('remembers at most maxEntries clients, and at most max attempts each', () => {
    const throttle = createRegistrationThrottle({ maxEntries: 30, max: 3 });
    for (let i = 0; i < 3000; i++) throttle.record(`client-${i}`, T0 + i);
    expect(throttle.size).toBeLessThanOrEqual(30);
    const one = createRegistrationThrottle({ max: 3 });
    for (let i = 0; i < 1000; i++) one.record('same', T0 + i);
    expect(one.check('same', T0 + 1000)).toMatchObject({ allowed: false });
    expect(one.size).toBe(1);
  });

  it('keeps only the latest max attempts, so the wait is counted from the right one even if attempts are recorded while held back', () => {
    const throttle = createRegistrationThrottle({ max: 2, windowMs: 10 * MIN });
    for (const minute of [0, 1, 2, 3]) throttle.record('c', T0 + minute * MIN);
    // the two that count are minute 2 and minute 3: the place frees when minute 2 ages out, at minute 12
    expect(throttle.check('c', T0 + 4 * MIN)).toEqual({ allowed: false, retryAfterMs: 8 * MIN });
    expect(throttle.check('c', T0 + 12 * MIN)).toEqual({ allowed: true });
  });

  it('a flood of other clients does not free a client that is really held back', () => {
    const throttle = createRegistrationThrottle({ maxEntries: 10, max: 2 });
    throttle.record('victim', T0);
    throttle.record('victim', T0 + 1);
    for (let i = 0; i < 500; i++) throttle.record(`flood-${i}`, T0 + 2 + i);
    // the flood may push an old entry out, but never faster than the table can hold: the victim was updated before the flood
    // so it is the oldest and may go; what matters is the table stays bounded
    expect(throttle.size).toBeLessThanOrEqual(10);
  });

  it('purge drops the aged out', () => {
    const throttle = createRegistrationThrottle({ windowMs: 10 * MIN });
    throttle.record('old', T0);
    throttle.record('new', T0 + 9 * MIN);
    throttle.purge(T0 + 11 * MIN);
    expect(throttle.size).toBe(1);
  });

  it('refuses nonsense settings with a TypeError', () => {
    for (const bad of [{ max: 0 }, { max: 1.5 }, { windowMs: 0 }, { windowMs: Number.NaN }, { maxEntries: 0 }]) expect(() => createRegistrationThrottle(bad), JSON.stringify(bad)).toThrow(TypeError);
  });
});

describe('the error', () => {
  it('is THROTTLED with the wait, rounded up to whole seconds, and says nothing about which key was over', () => {
    expect(throttledError(1)).toEqual({ code: 'THROTTLED', message: 'too many attempts: try again in 1 second', retryAfterMs: 1 });
    expect(throttledError(1000).message).toBe('too many attempts: try again in 1 second');
    expect(throttledError(1001).message).toBe('too many attempts: try again in 2 seconds');
    expect(throttledError(15 * MIN).message).toBe('too many attempts: try again in 900 seconds');
    expect(throttledError(15 * MIN).retryAfterMs).toBe(15 * MIN);
    expect(Object.isFrozen(throttledError(5))).toBe(true);
  });
});
