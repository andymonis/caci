/**
 * How a node id is stored in SQLite, and how listings are paged.
 *
 * A node id is stored as its UTF-16 code units, big-endian, in a BLOB. Two facts force this:
 *
 * - The adapter contract orders ids by UTF-16 code unit, the order JavaScript's `<` gives. SQLite
 *   compares text by UTF-8 bytes, which differs for characters outside the basic plane (`😀` sorts
 *   after `U+FF5E` in SQLite but before `U+E000` in JavaScript), and `node:sqlite` has no way to add
 *   a collation. Comparing the big-endian UTF-16 bytes of two ids gives exactly their `<` order.
 * - Text columns corrupt a lone surrogate (it comes back as `U+FFFD`), which would break "node ids
 *   round-trip unchanged". The blob is the identity too: ids are decoded from it, exactly.
 *
 * Every key starts with one fixed byte. `node:sqlite` binds a zero-length byte array as NULL, so the
 * empty id would otherwise become a NULL key; with the prefix a key is never empty. Every key
 * has the prefix, so the order is unchanged.
 *
 * Pure; no database here.
 */

/** The fixed first byte of every key. */
const KEY_PREFIX = 0x01;

/** The id as a key: a prefix byte, then big-endian UTF-16 bytes. Never empty. */
export function toKey(id: string): Uint8Array {
  const key = new Uint8Array(1 + id.length * 2);
  key[0] = KEY_PREFIX;
  const view = new DataView(key.buffer);
  for (let i = 0; i < id.length; i++) view.setUint16(1 + i * 2, id.charCodeAt(i), false);
  return key;
}

/** The id a key stands for. Returns `undefined` for bytes that cannot be a key (no prefix, or half a UTF-16 unit). */
export function fromKey(key: Uint8Array): string | undefined {
  if (key.length < 1 || key[0] !== KEY_PREFIX || (key.length - 1) % 2 !== 0) return undefined;
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  const CHUNK = 4096;
  let id = '';
  for (let start = 1; start < key.length; start += CHUNK * 2) {
    const units: number[] = [];
    for (let at = start; at < Math.min(key.length, start + CHUNK * 2); at += 2) units.push(view.getUint16(at, false));
    id += String.fromCharCode(...units);
  }
  return id;
}

/** Orders keys the way SQLite orders BLOBs (byte by byte, a prefix first), which is the contract's id order. */
export function compareKeys(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

const CURSOR_PREFIX = 'k';
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * A page cursor: the last key of the previous page, so the next page is "everything after it"
 * (keyset paging). Never empty text, as a page's cursor must not be.
 */
export function encodeCursor(key: Uint8Array): string {
  return CURSOR_PREFIX + Buffer.from(key).toString('base64url');
}

/** The key a cursor stands for, or `undefined` if it is not one this adapter could have given. */
export function decodeCursor(cursor: unknown): Uint8Array | undefined {
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR_PREFIX)) return undefined;
  const body = cursor.slice(CURSOR_PREFIX.length);
  if (!BASE64URL.test(body) || body.length % 4 === 1) return undefined;
  const key = new Uint8Array(Buffer.from(body, 'base64url'));
  // reject anything that does not re-encode to the same text (stray bits in the last character) or is not a key
  if (encodeCursor(key) !== cursor || fromKey(key) === undefined) return undefined;
  return key;
}
