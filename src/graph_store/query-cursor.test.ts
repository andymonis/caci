import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, decodeQueryCursor, encodeQueryCursor, queryFingerprint } from './query-cursor.js';
import type { NodeRef, Query } from './types.js';

const query = (over: Partial<Query> = {}): Query => ({
  version: 1,
  graphId: 'user_42',
  from: { partition: 'category', ids: ['doctor-x'] },
  traverse: { depth: 1 },
  return: { shape: 'subgraph', includeData: true },
  page: { limit: 50, cursor: null },
  ...over,
});
const after: NodeRef = { partition: 'item', id: 'visit-17' };

describe('canonicalJson', () => {
  it('gives the same text whatever the key order, and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('tells different values apart, including array order and types', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }));
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('x')).toBe('"x"');
  });
});

describe('queryFingerprint', () => {
  it('ignores the page, so every page of one query shares a fingerprint', () => {
    expect(queryFingerprint(query({ page: { limit: 10, cursor: null } }))).toBe(queryFingerprint(query({ page: { limit: 500, cursor: 'abc' } })));
  });

  it('ignores key order', () => {
    const a = query();
    const b = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse()))) as Query;
    expect(queryFingerprint(a)).toBe(queryFingerprint(b));
  });

  it.each([
    ['another graph', query({ graphId: 'user_43' })],
    ['other seeds', query({ from: { partition: 'category', ids: ['doctor-y'] } })],
    ['seeds in another partition', query({ from: { partition: 'item', ids: ['doctor-x'] } })],
    ['everything instead of seeds', query({ from: { all: true } })],
    ['another depth', query({ traverse: { depth: 2 } })],
    ['another shape', query({ return: { shape: 'nodes', includeData: true } })],
    ['data switched off', query({ return: { shape: 'subgraph', includeData: false } })],
    ['a filter', query({ filter: { partition: 'item' } })],
  ])('changes with %s', (_name, other) => {
    expect(queryFingerprint(other)).not.toBe(queryFingerprint(query()));
  });

  it('is short, readable text', () => {
    expect(queryFingerprint(query())).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('query cursors', () => {
  const fp = queryFingerprint(query());

  it('round-trips the position it was made from', () => {
    for (const node of [after, { partition: 'category' as const, id: 'doctor-x' }, { partition: 'item' as const, id: 'ünï/../ \u0000 "quote"' }]) {
      expect(decodeQueryCursor(encodeQueryCursor(fp, node), fp)).toEqual({ ok: true, value: node });
    }
  });

  it('is opaque URL-safe text, not readable JSON', () => {
    const cursor = encodeQueryCursor(fp, after);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain('visit-17');
    expect(cursor.length).toBeLessThan(200);
  });

  it('is deterministic', () => {
    expect(encodeQueryCursor(fp, after)).toBe(encodeQueryCursor(fp, after));
  });

  it('works for any page size of the same query', () => {
    const cursor = encodeQueryCursor(queryFingerprint(query({ page: { limit: 10, cursor: null } })), after);
    expect(decodeQueryCursor(cursor, queryFingerprint(query({ page: { limit: 1000, cursor: null } }))).ok).toBe(true);
  });

  it('is refused by a different query (foreign cursor)', () => {
    const cursor = encodeQueryCursor(fp, after);
    for (const other of [query({ graphId: 'user_43' }), query({ from: { all: true } }), query({ traverse: { depth: 2 } }), query({ return: { shape: 'ids' } })]) {
      expect(decodeQueryCursor(cursor, queryFingerprint(other))).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_ERROR', path: ['page', 'cursor'] },
      });
    }
  });

  it('is refused when any single character is changed (tampering or corruption)', () => {
    const cursor = encodeQueryCursor(fp, after);
    let refused = 0;
    for (let i = 0; i < cursor.length; i++) {
      const swap = cursor[i] === 'A' ? 'B' : 'A';
      const edited = cursor.slice(0, i) + swap + cursor.slice(i + 1);
      const r = decodeQueryCursor(edited, fp);
      if (!r.ok) refused += 1;
      else expect(r.value).toEqual(after); // a change that decodes must not move the position
    }
    expect(refused).toBeGreaterThan(cursor.length * 0.9);
  });

  it('is refused when truncated or extended', () => {
    const cursor = encodeQueryCursor(fp, after);
    for (const edited of [cursor.slice(0, -1), cursor.slice(0, 10), cursor + 'A', `${cursor}=`, `x${cursor}`]) {
      expect(decodeQueryCursor(edited, fp).ok).toBe(false);
    }
  });

  it('is refused when the position is edited and the checksum re-made by hand', () => {
    const body = JSON.stringify({ v: 1, q: fp, p: 'item', id: 'someone-else' });
    const forged = Buffer.from(`00000000.${body}`, 'utf8').toString('base64url');
    expect(decodeQueryCursor(forged, fp).ok).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['not base64', '!!!not a cursor!!!'],
    ['plain words', 'next-page'],
    ['a number as text', '12345'],
    ['JSON, not a cursor', Buffer.from('{"v":1}').toString('base64url')],
    ['very long', 'A'.repeat(5000)],
    ['an old-style position', Buffer.from('visit-17').toString('base64url')],
  ])('refuses %s with a path to page.cursor and never throws', (_name, garbage) => {
    expect(decodeQueryCursor(garbage, fp)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', path: ['page', 'cursor'] } });
  });

  it.each([
    ['an unknown version', { v: 2, q: 'FP', p: 'item', id: 'a' }],
    ['no version', { q: 'FP', p: 'item', id: 'a' }],
    ['an extra field', { v: 1, q: 'FP', p: 'item', id: 'a', extra: true }],
    ['a partition that does not exist', { v: 1, q: 'FP', p: 'edge', id: 'a' }],
    ['an empty id', { v: 1, q: 'FP', p: 'item', id: '' }],
    ['a numeric id', { v: 1, q: 'FP', p: 'item', id: 5 }],
    ['a missing id', { v: 1, q: 'FP', p: 'item' }],
    ['another query\'s fingerprint', { v: 1, q: 'ffffffffffffffff', p: 'item', id: 'a' }],
    ['an array instead of an object', ['FP', 'item', 'a']],
    ['null', null],
  ])('is refused even with a correct checksum when it carries %s', (_name, contents) => {
    const body = JSON.stringify(contents).replace('"FP"', JSON.stringify(fp));
    const checksum = createHash('sha256').update(body).digest('hex').slice(0, 8);
    const cursor = Buffer.from(`${checksum}.${body}`, 'utf8').toString('base64url');
    expect(decodeQueryCursor(cursor, fp)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', path: ['page', 'cursor'] } });
  });

  it('accepts the same envelope when the contents are right (so the cases above fail for the stated reason)', () => {
    const body = JSON.stringify({ v: 1, q: fp, p: 'item', id: 'a' });
    const checksum = createHash('sha256').update(body).digest('hex').slice(0, 8);
    const cursor = Buffer.from(`${checksum}.${body}`, 'utf8').toString('base64url');
    expect(decodeQueryCursor(cursor, fp)).toEqual({ ok: true, value: { partition: 'item', id: 'a' } });
  });

  it('survives hostile inputs of the wrong type', () => {
    for (const hostile of [null, undefined, 5, {}, [], Symbol.iterator]) {
      expect(decodeQueryCursor(hostile as unknown as string, fp).ok).toBe(false);
    }
  });

  it('refuses random strings (fuzz) and never throws', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.={}":,';
    for (let i = 0; i < 2000; i++) {
      const length = Math.floor(rand() * 120);
      const text = Array.from({ length }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
      expect(decodeQueryCursor(text, fp).ok).toBe(false);
    }
  });

  it('says why in words a caller can act on', () => {
    const r = decodeQueryCursor('nonsense', fp);
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringContaining('different query') } });
  });
});
