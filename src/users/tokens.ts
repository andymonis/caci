import { createHash, randomBytes } from 'node:crypto';

/** A session token is 256 random bits as base64url: 43 characters. */
export const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type RandomBytes = (length: number) => Uint8Array;

export function newSessionToken(random: RandomBytes = (n) => randomBytes(n)): string {
  const bytes = random(TOKEN_BYTES);
  if (bytes.length !== TOKEN_BYTES) throw new Error('the random source gave the wrong number of bytes');
  return Buffer.from(bytes).toString('base64url');
}

/** True only for text shaped like a token. Anything else is turned away before a store is touched. */
export const isWellFormedToken = (value: unknown): value is string => typeof value === 'string' && TOKEN_PATTERN.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;

/** What a store keeps instead of the token: its SHA-256 in hex. A copy of the database cannot be replayed. */
export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
