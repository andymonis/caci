import type { RandomBytes } from './tokens.js';

export interface SessionOptions {
  /** A session ends this long after it was last used. Default 30 minutes. */
  readonly idleMs?: number;
  /** A session ends this long after login, however busy it is. Default 7 days. */
  readonly absoluteMs?: number;
  /** Use renews the idle clock at most this often (so reading does not write every time). Default 1 minute. */
  readonly renewEveryMs?: number;
  /** A user keeps at most this many sessions; a new login beyond that ends their oldest. Default 20. */
  readonly maxPerUser?: number;
  /** Secure random bytes. Tests replace it. */
  readonly randomBytes?: RandomBytes;
}

export interface ResolvedSessionOptions {
  readonly idleMs: number;
  readonly absoluteMs: number;
  readonly renewEveryMs: number;
  readonly maxPerUser: number;
  readonly randomBytes: RandomBytes | undefined;
}

export const DEFAULT_SESSION_OPTIONS = Object.freeze({ idleMs: 30 * 60_000, absoluteMs: 7 * 24 * 60 * 60_000, renewEveryMs: 60_000, maxPerUser: 20 });

/** Fills in the defaults and refuses nonsense with a `TypeError` (a coding or configuration mistake). */
export function resolveSessionOptions(options: SessionOptions = {}): ResolvedSessionOptions {
  const { idleMs, absoluteMs, renewEveryMs, maxPerUser } = { ...DEFAULT_SESSION_OPTIONS, ...options };
  for (const [name, value] of [['idleMs', idleMs], ['absoluteMs', absoluteMs], ['renewEveryMs', renewEveryMs], ['maxPerUser', maxPerUser]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`session option ${name} must be a positive whole number`);
  }
  if (renewEveryMs > idleMs) throw new TypeError('session option renewEveryMs must not be longer than idleMs');
  if (idleMs > absoluteMs) throw new TypeError('session option idleMs must not be longer than absoluteMs');
  return Object.freeze({ idleMs, absoluteMs, renewEveryMs, maxPerUser, randomBytes: options.randomBytes });
}

/**
 * Logins. A token is given out once, by `create`, and is never stored: stores keep only its hash.
 * Time is passed in (milliseconds since 1970), so nothing here reads a clock.
 */
export interface SessionStore {
  /** Starts a session for a user and returns its token (43 characters). */
  create(userId: string, now: number): Promise<string>;
  /** The user id for a live token, or `undefined` for a malformed, unknown, revoked or expired one (an expired one is removed). Renews the idle clock at most once per `renewEveryMs`. */
  resolve(token: string, now: number): Promise<string | undefined>;
  /** Ends one session. `false` if there was no such live session. */
  revoke(token: string): Promise<boolean>;
  /** Ends every session of a user (except the one token given, if any) and says how many. */
  revokeAllFor(userId: string, options?: { readonly except?: string }): Promise<number>;
  /** Removes every session that has expired by `now`, and says how many. */
  purgeExpired(now: number): Promise<number>;
}
