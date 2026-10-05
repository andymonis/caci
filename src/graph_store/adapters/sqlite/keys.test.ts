import { describe, expect, it } from 'vitest';
import { openDb } from './db.js';
import { compareKeys, decodeCursor, encodeCursor, fromKey, toKey } from './keys.js';

/** The order the adapter contract asks for: UTF-16 code units, which is JavaScript's `<`. */
const jsOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Awkward ids: empty, ASCII, accents, the private-use and full-width characters around the astral boundary, an emoji, and every kind of lone surrogate. */
const BATTERY: readonly string[] = [
  '', 'a', 'B', 'ab', 'a\u0000', 'Z', 'z', '0', 'é', 'é', '', '～', '\u{1F600}', '\u{10000}', '￿',
  '\uD800', '\uDBFF', '\uDC00', '\uDFFF', 'x\uD800y', '\uD83D', '\uDE00', '😀', '../..', 'a/b', ' ', '\n',
];

function randomString(next: () => number): string {
  const pieces = ['a', 'Z', '0', ' ', '/', 'é', '中', '', '～', '\u{1F600}', '\u{1D11E}', '\uD800', '\uDC00', '\u0000'];
  const length = Math.floor(next() * 9);
  let out = '';
  for (let i = 0; i < length; i++) out += pieces[Math.floor(next() * pieces.length)];
  return out;
}
function seeded(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

describe('toKey / fromKey', () => {
  it('encodes UTF-16 code units, big-endian', () => {
    expect([...toKey('a')]).toEqual([0x01, 0x00, 0x61]);
    expect([...toKey('é')]).toEqual([0x01, 0x00, 0xe9]);
    expect([...toKey('\u{1F600}')]).toEqual([0x01, 0xd8, 0x3d, 0xde, 0x00]); // the surrogate pair, high unit first
    expect([...toKey('\uD800')]).toEqual([0x01, 0xd8, 0x00]); // a lone surrogate keeps its own code unit
    expect([...toKey('')]).toEqual([0x01]); // never zero-length: node:sqlite would bind that as NULL
  });

  it('round-trips every awkward id exactly, lone surrogates included', () => {
    for (const id of BATTERY) expect(fromKey(toKey(id))).toBe(id);
  });

  it('round-trips 10,000 random strings exactly', () => {
    const next = seeded(7);
    for (let i = 0; i < 10_000; i++) {
      const id = randomString(next);
      expect(fromKey(toKey(id))).toBe(id);
    }
  });

  it('round-trips ids of the longest allowed length (256 characters) and far longer ones', () => {
    for (const length of [256, 10_000]) {
      const id = Array.from({ length }, (_, i) => String.fromCharCode(0xd800 + (i % 0x800))).join(''); // all surrogates, mostly lone
      expect(fromKey(toKey(id))).toBe(id);
    }
  });

  it('decodes a key that is a view into a larger buffer', () => {
    const big = new Uint8Array([9, 9, 0x01, 0x00, 0x61, 0x00, 0x62, 9]);
    expect(fromKey(big.subarray(2, 7))).toBe('ab');
  });

  it('refuses bytes that cannot be a key (empty, no prefix, or half a UTF-16 unit)', () => {
    expect(fromKey(new Uint8Array([]))).toBeUndefined();
    expect(fromKey(new Uint8Array([0x00, 0x00, 0x61]))).toBeUndefined();
    expect(fromKey(new Uint8Array([0x01, 0x00]))).toBeUndefined();
    expect(fromKey(new Uint8Array([0x01, 0, 0x61, 0]))).toBeUndefined();
  });

  it('does not change what it is given', () => {
    const key = toKey('abc');
    const copy = [...key];
    fromKey(key);
    expect([...key]).toEqual(copy);
  });
});

describe('the order of keys is the contract\'s id order', () => {
  it('compareKeys agrees with JavaScript\'s < on every pair of the battery', () => {
    for (const a of BATTERY) for (const b of BATTERY) expect(Math.sign(compareKeys(toKey(a), toKey(b))), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(jsOrder(a, b));
  });

  it('compareKeys agrees with JavaScript\'s < on 5,000 random pairs', () => {
    const next = seeded(11);
    for (let i = 0; i < 5000; i++) {
      const a = randomString(next);
      const b = randomString(next);
      expect(Math.sign(compareKeys(toKey(a), toKey(b)))).toBe(jsOrder(a, b));
    }
  });

  it('a prefix sorts before what extends it, and equal keys compare equal', () => {
    expect(compareKeys(toKey('a'), toKey('ab'))).toBeLessThan(0);
    expect(compareKeys(toKey('ab'), toKey('a'))).toBeGreaterThan(0);
    expect(compareKeys(toKey('ab'), toKey('ab'))).toBe(0);
    expect(compareKeys(toKey(''), toKey(''))).toBe(0);
  });

  it('AS SQLITE SORTS THEM: ORDER BY on the blob equals JavaScript\'s order, for the battery and 2,000 random ids', () => {
    const db = openDb();
    db.exec('CREATE TABLE t (k BLOB PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID'); // like the real tables: stored in key order
    const next = seeded(23);
    const ids = [...new Set([...BATTERY, ...Array.from({ length: 2000 }, () => randomString(next))])];
    ids.forEach((id, n) => db.run('INSERT INTO t (k, n) VALUES (?, ?)', toKey(id), n));
    const fromSqlite = db.all<{ n: number }>('SELECT n FROM t ORDER BY k').map((r) => ids[r.n] as string);
    expect(fromSqlite).toEqual([...ids].sort(jsOrder));
    // and the primary key itself scans in that order, with nothing to sort
    const scanned = db.all<{ n: number }>('SELECT n FROM t').map((r) => ids[r.n] as string);
    expect(scanned).toEqual([...ids].sort(jsOrder));
    db.close();
  });

  it('AS SQLITE COMPARES THEM: > and < on blobs match compareKeys, which is how keyset paging asks "after this key"', () => {
    const db = openDb();
    for (const a of BATTERY) {
      for (const b of BATTERY) {
        const row = db.get<{ gt: number; lt: number }>('SELECT (? > ?) AS gt, (? < ?) AS lt', toKey(a), toKey(b), toKey(a), toKey(b));
        expect(row).toEqual({ gt: jsOrder(a, b) > 0 ? 1 : 0, lt: jsOrder(a, b) < 0 ? 1 : 0 });
      }
    }
    db.close();
  });

  it('is the same as storing and reading the keys back (blobs round-trip through SQLite untouched)', () => {
    const db = openDb();
    db.exec('CREATE TABLE t (k BLOB NOT NULL)');
    for (const id of BATTERY) db.run('INSERT INTO t (k) VALUES (?)', toKey(id));
    const back = db.all<{ k: Uint8Array }>('SELECT k FROM t').map((r) => fromKey(r.k));
    expect(back).toEqual([...BATTERY]);
    db.close();
  });
});

describe('why the blob: what SQLite does with the ids as text (these guard the premise, so a driver change is noticed)', () => {
  it('its own text order is not JavaScript\'s: the emoji sorts last', () => {
    const db = openDb();
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    const ids = ['a', '～', '\u{1F600}', '', 'B'];
    for (const id of ids) db.run('INSERT INTO t (id) VALUES (?)', id);
    const text = db.all<{ id: string }>('SELECT id FROM t ORDER BY id').map((r) => r.id);
    expect(text).not.toEqual([...ids].sort(jsOrder));
    expect(text.at(-1)).toBe('\u{1F600}');
    expect([...ids].sort(jsOrder).indexOf('\u{1F600}')).toBeLessThan([...ids].sort(jsOrder).indexOf(''));
    db.close();
  });

  it('a lone surrogate does not survive as text', () => {
    const db = openDb();
    db.exec('CREATE TABLE t (id TEXT NOT NULL)');
    db.run('INSERT INTO t (id) VALUES (?)', 'x\uD800y');
    expect(db.get<{ id: string }>('SELECT id FROM t')?.id).not.toBe('x\uD800y');
    db.close();
  });
});

describe('the empty id', () => {
  it('is stored as a real, non-NULL blob, and sorts first', () => {
    const db = openDb();
    db.exec('CREATE TABLE t (k BLOB PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID');
    db.run('INSERT INTO t (k, n) VALUES (?, 1)', toKey('a'));
    db.run('INSERT INTO t (k, n) VALUES (?, 2)', toKey(''));
    expect(db.all<{ n: number }>('SELECT n FROM t ORDER BY k').map((r) => r.n)).toEqual([2, 1]);
    db.close();
  });

  it('the wrapper refuses a bare empty byte array rather than let it become NULL', () => {
    const db = openDb();
    db.exec('CREATE TABLE t (k BLOB)');
    expect(() => db.run('INSERT INTO t (k) VALUES (?)', new Uint8Array(0))).toThrow(/empty byte array/);
    expect(() => db.get('SELECT ?', new Uint8Array(0))).toThrow(/empty byte array/);
    expect(() => db.all('SELECT ?', new Uint8Array(0))).toThrow(/empty byte array/);
    db.close();
  });
});

describe('cursors', () => {
  it('round-trip any key, and are never empty (even for the empty id)', () => {
    for (const id of BATTERY) {
      const cursor = encodeCursor(toKey(id));
      expect(cursor.length).toBeGreaterThan(0);
      expect(cursor).toMatch(/^k[A-Za-z0-9_-]*$/);
      expect(fromKey(decodeCursor(cursor) as Uint8Array)).toBe(id);
    }
    expect(encodeCursor(toKey(''))).toBe('kAQ');
    expect([...(decodeCursor('kAQ') as Uint8Array)]).toEqual([1]);
  });

  it('round-trip 5,000 random ids', () => {
    const next = seeded(31);
    for (let i = 0; i < 5000; i++) {
      const id = randomString(next);
      expect(fromKey(decodeCursor(encodeCursor(toKey(id))) as Uint8Array)).toBe(id);
    }
  });

  it('are plain text safe to hand to callers and to put in a URL', () => {
    for (const id of BATTERY) expect(encodeCursor(toKey(id))).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['empty text', ''],
    ['no prefix', 'AAAA'],
    ['the wrong prefix', 'xAAAA'],
    ['an upper-case prefix', 'KAAAA'],
    ['characters outside base64url', 'k+/=='],
    ['padding', 'kAAA='],
    ['a space', 'kAA A'],
    ['a length that base64 cannot have (1 mod 4)', 'kA'],
    ['stray bits in the last character (not what encoding would give)', 'kAB'],
    ['stray bits that still decode to a real key (a second spelling of the same cursor)', 'kAQAAAAB'],
    ['one character too many for any key', 'kAQAAA'],
    ['half a UTF-16 unit after the prefix', encodeCursor(new Uint8Array([1, 2]))],
    ['bytes without the key prefix', encodeCursor(new Uint8Array([0, 0, 0x61]))],
    ['no bytes at all', 'k'],
    ['null', null],
    ['a number', 5],
    ['an object', {}],
    ['undefined', undefined],
  ])('refuses %s', (_name, cursor) => {
    expect(decodeCursor(cursor)).toBeUndefined();
  });

  it('accepts the canonical form of a three-byte key', () => {
    expect([...(decodeCursor(encodeCursor(new Uint8Array([1, 0, 0]))) as Uint8Array)]).toEqual([1, 0, 0]);
  });

  it('never throws, however odd the input', () => {
    const next = seeded(5);
    for (let i = 0; i < 2000; i++) {
      const junk = 'k' + Array.from({ length: Math.floor(next() * 20) }, () => String.fromCharCode(Math.floor(next() * 0xffff))).join('');
      expect(() => decodeCursor(junk)).not.toThrow();
    }
  });
});
