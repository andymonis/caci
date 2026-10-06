import { randomBytes as nodeRandomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** scrypt cost: `N` (a power of two), block size `r`, parallelism `p`. */
export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/**
 * The default cost: 2^15 iterations, r = 8, p = 1, which needs about 32 MiB and roughly 100 ms on a
 * laptop. Raise it when hardware allows: stored hashes keep the parameters they were made with and
 * are upgraded at the next login (`needsRehash`).
 */
export const DEFAULT_SCRYPT: ScryptParams = Object.freeze({ N: 32768, r: 8, p: 1 });

const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MIN_SALT_BYTES = 4;
const MAX_SALT_BYTES = 64;
/** Longest password that is even tried: longer is refused outright, so a huge body cannot cost CPU. */
const MAX_PASSWORD_CHARS = 1024;
/** 128 * N * r bytes of memory at most (64 MiB), whatever a stored string or a setting asks for. */
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const MAX_P = 16;
const FORMAT = /^scrypt\$(\d{1,8})\$(\d{1,3})\$(\d{1,3})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

/** Makes the derived key. Tests replace it to count calls and to avoid the cost. */
export type Derive = (password: string, salt: Uint8Array, params: ScryptParams, keyBytes: number) => Promise<Uint8Array>;

export interface PasswordHasherOptions {
  /** Cost for new hashes. Default `DEFAULT_SCRYPT`. */
  readonly params?: ScryptParams;
  /** Secure random bytes. Tests replace it. */
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly derive?: Derive;
}

export interface PasswordHasher {
  /** A self-describing string: `scrypt$N$r$p$salt$hash` (base64url), with a fresh random salt each time. */
  hash(password: string): Promise<string>;
  /** True only for the right password. A malformed or unknown stored string is simply false. */
  verify(password: string, stored: string): Promise<boolean>;
  /** For a login with no such user: does the same work as `verify` at the current cost and is always false. */
  verifyAbsent(password: string): Promise<false>;
  /** True when `stored` is a good hash made with weaker parameters than the current ones. */
  needsRehash(stored: string): boolean;
  /** The cost new hashes are made with. */
  readonly params: ScryptParams;
}

const nodeDerive: Derive = (password, salt, params, keyBytes) =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keyBytes, { N: params.N, r: params.r, p: params.p, maxmem: 2 * 128 * params.N * params.r + 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });

const isPowerOfTwo = (n: number): boolean => Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;

function validParams(params: ScryptParams): boolean {
  return isPowerOfTwo(params.N) && params.N >= 16 && Number.isInteger(params.r) && params.r >= 1 && Number.isInteger(params.p) && params.p >= 1 && params.p <= MAX_P && 128 * params.N * params.r <= MAX_MEMORY_BYTES;
}

interface Parsed {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parse(stored: unknown): Parsed | undefined {
  if (typeof stored !== 'string' || stored.length > 512) return undefined;
  const match = FORMAT.exec(stored);
  if (match === null) return undefined;
  const params = { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  if (!validParams(params)) return undefined;
  const salt = Buffer.from(match[4] as string, 'base64url');
  const key = Buffer.from(match[5] as string, 'base64url');
  if (salt.length < MIN_SALT_BYTES || salt.length > MAX_SALT_BYTES || key.length !== KEY_BYTES) return undefined;
  // reject a second spelling of the same bytes
  if (salt.toString('base64url') !== match[4] || key.toString('base64url') !== match[5]) return undefined;
  return { params, salt, key };
}

const normalise = (password: string): string => password.normalize('NFKC');

/**
 * Hashes and checks passwords with scrypt (`node:crypto`, no dependency). Passwords are
 * Unicode-normalised (NFKC) first, so the same password typed in a different form still matches.
 * Errors never contain the password.
 */
export function createPasswordHasher(options: PasswordHasherOptions = {}): PasswordHasher {
  const params = Object.freeze({ ...(options.params ?? DEFAULT_SCRYPT) });
  if (!validParams(params)) throw new TypeError('createPasswordHasher: params need N a power of two from 16, r at least 1, p from 1 to 16, and 128 * N * r at most 64 MiB');
  const random = options.randomBytes ?? ((n: number) => nodeRandomBytes(n));
  const derive = options.derive ?? nodeDerive;
  // a fixed salt for the "no such user" work; it protects nothing, it only has to be a salt
  const dummySalt = Buffer.alloc(SALT_BYTES, 0x5a);

  async function key(password: string, salt: Uint8Array, cost: ScryptParams): Promise<Buffer> {
    try {
      return Buffer.from(await derive(normalise(password), salt, cost, KEY_BYTES));
    } catch {
      throw new Error('password hashing failed'); // never the original message: it could carry the password
    }
  }

  return {
    params,

    async hash(password) {
      if (typeof password !== 'string') throw new TypeError('hash: the password must be text');
      const salt = Buffer.from(random(SALT_BYTES));
      const derived = await key(password, salt, params);
      return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
    },

    async verify(password, stored) {
      if (typeof password !== 'string' || password.length > MAX_PASSWORD_CHARS) return false;
      const parsed = parse(stored);
      if (parsed === undefined) return false;
      const derived = await key(password, parsed.salt, parsed.params);
      return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key);
    },

    async verifyAbsent(password) {
      if (typeof password === 'string' && password.length <= MAX_PASSWORD_CHARS) await key(password, dummySalt, params);
      return false;
    },

    needsRehash(stored) {
      const parsed = parse(stored);
      if (parsed === undefined) return false; // cannot be verified, so cannot be upgraded
      return parsed.params.N < params.N || parsed.params.r < params.r || parsed.params.p < params.p;
    },
  };
}
