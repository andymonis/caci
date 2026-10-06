import { usersError, type UsersError } from './errors.js';

/** Decision of a throttle: go ahead, or wait this long. */
export type Verdict = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number };

/** `THROTTLED`, with the wait, in words that say how long without saying which key was over. */
export function throttledError(retryAfterMs: number): UsersError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return usersError('THROTTLED', `too many attempts: try again in ${seconds} second${seconds === 1 ? '' : 's'}`, { retryAfterMs });
}

export interface LockRule {
  /** Failures within the window before attempts are held back. */
  readonly threshold: number;
  /** The first hold, after the threshold is reached. It doubles with every further failure. */
  readonly baseDelayMs: number;
  /** The longest hold. */
  readonly maxDelayMs: number;
  /** Failures older than this are forgotten. */
  readonly windowMs: number;
}

export interface LoginThrottleOptions {
  /** One username, whether or not such an account exists. Default: 5 failures, 1 s doubling to 15 min, 15 min window. */
  readonly perUsername?: Partial<LockRule>;
  /** One client (an address or whatever the caller keys on), over every username. More generous: a household shares an address. Default 20 failures. */
  readonly perClient?: Partial<LockRule>;
  /** How many usernames and how many clients are remembered, each. Default 10,000. */
  readonly maxEntries?: number;
}

export interface LoginThrottle {
  /** May this attempt go ahead? Looks at both keys and gives the longer wait. Changes nothing. */
  check(username: string, clientKey: string, now: number): Verdict;
  /** A wrong password or an unknown username. Call it for both, identically, so the throttle cannot reveal which accounts exist. */
  recordFailure(username: string, clientKey: string, now: number): void;
  /** A right password: forgets that username's failures (the client's stay: one good login does not forgive an address). */
  recordSuccess(username: string, clientKey: string, now: number): void;
  /** Forgets everything that has expired by `now`. */
  purge(now: number): void;
  /** How many keys are remembered: usernames plus clients. */
  readonly size: number;
}

export interface RegistrationThrottleOptions {
  /** Registrations one client may make per window. Default 10. */
  readonly max?: number;
  /** Default 1 hour. */
  readonly windowMs?: number;
  /** Default 10,000 clients. */
  readonly maxEntries?: number;
}

export interface RegistrationThrottle {
  check(clientKey: string, now: number): Verdict;
  /** An attempt to register, counted whether or not it succeeds (a refused name still costs the client). */
  record(clientKey: string, now: number): void;
  purge(now: number): void;
  readonly size: number;
}

export const DEFAULT_USERNAME_RULE: LockRule = Object.freeze({ threshold: 5, baseDelayMs: 1000, maxDelayMs: 15 * 60_000, windowMs: 15 * 60_000 });
export const DEFAULT_CLIENT_RULE: LockRule = Object.freeze({ threshold: 20, baseDelayMs: 1000, maxDelayMs: 15 * 60_000, windowMs: 15 * 60_000 });
const DEFAULT_MAX_ENTRIES = 10_000;
/** A key longer than this is cut, so one request cannot make an entry of any size. */
const MAX_KEY_LENGTH = 128;

const normalise = (key: unknown): string => String(key).toLowerCase().slice(0, MAX_KEY_LENGTH);

function rule(defaults: LockRule, given: Partial<LockRule> | undefined, name: string): LockRule {
  const merged = { ...defaults, ...given };
  for (const [field, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name}.${field} must be a positive whole number`);
  }
  if (merged.baseDelayMs > merged.maxDelayMs) throw new TypeError(`${name}.baseDelayMs must not be longer than maxDelayMs`);
  return Object.freeze(merged);
}

function entries(value: number | undefined): number {
  const max = value ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError('maxEntries must be a positive whole number');
  return max;
}

interface Failures {
  count: number;
  lastAt: number;
}

/** Failure counts per key, with a bound on how many keys are kept. */
function createLockTable(lock: LockRule, maxEntries: number) {
  const table = new Map<string, Failures>(); // oldest update first: every update moves its key to the end

  const live = (f: Failures, now: number): boolean => now - f.lastAt < lock.windowMs;
  const delay = (count: number): number => Math.min(lock.baseDelayMs * 2 ** Math.min(count - lock.threshold, 30), lock.maxDelayMs);
  const wait = (f: Failures, now: number): number => (f.count >= lock.threshold ? Math.max(0, f.lastAt + delay(f.count) - now) : 0);

  /** Room for one more key. An attacker flooding made-up names must not push a real lock out, so go in this order: forgotten, never locked, then the oldest. */
  function makeRoom(now: number): void {
    if (table.size < maxEntries) return;
    let victim: string | undefined;
    let neverLocked: string | undefined;
    for (const [key, f] of table) {
      if (!live(f, now)) {
        victim = key;
        break;
      }
      if (neverLocked === undefined && f.count < lock.threshold) neverLocked = key;
    }
    table.delete(victim ?? neverLocked ?? (table.keys().next().value as string));
  }

  return {
    wait(key: string, now: number): number {
      const f = table.get(key);
      return f === undefined || !live(f, now) ? 0 : wait(f, now);
    },
    fail(key: string, now: number): void {
      const old = table.get(key);
      table.delete(key);
      if (old === undefined) makeRoom(now);
      table.set(key, { count: old !== undefined && live(old, now) ? old.count + 1 : 1, lastAt: now });
    },
    clear: (key: string): void => void table.delete(key),
    purge(now: number): void {
      for (const [key, f] of [...table]) if (!live(f, now)) table.delete(key);
    },
    get size(): number {
      return table.size;
    },
  };
}

/** Holds back guessing: exponential waits after repeated failures for one username and for one client. Pure apart from its own memory; time is passed in. */
export function createLoginThrottle(options: LoginThrottleOptions = {}): LoginThrottle {
  const max = entries(options.maxEntries);
  const users = createLockTable(rule(DEFAULT_USERNAME_RULE, options.perUsername, 'perUsername'), max);
  const clients = createLockTable(rule(DEFAULT_CLIENT_RULE, options.perClient, 'perClient'), max);
  return {
    check(username, clientKey, now) {
      const retryAfterMs = Math.max(users.wait(normalise(username), now), clients.wait(normalise(clientKey), now));
      return retryAfterMs > 0 ? { allowed: false, retryAfterMs } : { allowed: true };
    },
    recordFailure(username, clientKey, now) {
      users.fail(normalise(username), now);
      clients.fail(normalise(clientKey), now);
    },
    recordSuccess(username) {
      users.clear(normalise(username));
    },
    purge(now) {
      users.purge(now);
      clients.purge(now);
    },
    get size() {
      return users.size + clients.size;
    },
  };
}

/** Limits how often one client may register: at most `max` attempts per window, counted from the oldest. */
export function createRegistrationThrottle(options: RegistrationThrottleOptions = {}): RegistrationThrottle {
  const maxAttempts = options.max ?? 10;
  const windowMs = options.windowMs ?? 60 * 60_000;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('max must be a positive whole number');
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new TypeError('windowMs must be a positive whole number');
  const maxEntries = entries(options.maxEntries);
  const table = new Map<string, number[]>(); // each client's attempt times, oldest first, at most maxAttempts of them

  const recent = (times: readonly number[], now: number): number[] => times.filter((t) => now - t < windowMs);

  return {
    check(clientKey, now) {
      const times = recent(table.get(normalise(clientKey)) ?? [], now);
      if (times.length < maxAttempts) return { allowed: true };
      return { allowed: false, retryAfterMs: Math.max(1, (times[0] as number) + windowMs - now) };
    },
    record(clientKey, now) {
      const key = normalise(clientKey);
      const times = recent(table.get(key) ?? [], now);
      table.delete(key);
      if (times.length === 0 && table.size >= maxEntries) {
        let victim: string | undefined;
        for (const [k, v] of table) {
          if (recent(v, now).length === 0) {
            victim = k;
            break;
          }
        }
        // nothing has expired: forget the client whose latest attempt is oldest, which is the first one kept
        table.delete(victim ?? (table.keys().next().value as string));
      }
      times.push(now);
      table.set(key, times.slice(-maxAttempts));
    },
    purge(now) {
      for (const [key, times] of [...table]) if (recent(times, now).length === 0) table.delete(key);
    },
    get size() {
      return table.size;
    },
  };
}
