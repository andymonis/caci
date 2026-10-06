/** A user id is `u` and 16 random lowercase letters or digits, never reused: `u3k9d2x7q0m5a1bz7`. */
export const USER_ID_PATTERN = /^u[a-z0-9]{16}$/;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/** Bytes at or above this are skipped so every character is equally likely (256 is not a multiple of 36). */
const LIMIT = 252;

/** 16 characters from `random(n)`, which gives `n` random bytes (the platform's secure generator by default). */
export function newUserId(random: (length: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  let id = 'u';
  while (id.length < 17) {
    for (const byte of random(32)) {
      if (byte < LIMIT && id.length < 17) id += ALPHABET[byte % 36];
    }
  }
  return id;
}

export const isUserId = (value: unknown): value is string => typeof value === 'string' && USER_ID_PATTERN.test(value);

/**
 * The id of the graph that belongs to a user: `user-` plus the user id, so it follows the graph store's
 * id rules and the same user always gets the same graph. Throws a `TypeError` for something that is not
 * a user id (a coding mistake: an id comes from `newUserId` or the store, never from a request).
 */
export function userGraphId(userId: string): string {
  if (!isUserId(userId)) throw new TypeError('userGraphId: not a user id');
  return `user-${userId}`;
}
