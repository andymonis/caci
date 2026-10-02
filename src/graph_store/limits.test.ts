import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from './limits.js';
import { parseMutation, parseQuery } from './parse.js';

const mutation = (ops: unknown[], graphId = 'g') => ({ version: 1, kind: 'mutation', graphId, ops });
const upsert = (over: object = {}) => ({ op: 'upsertNode', partition: 'item', id: 'a', ...over });
const query = (over: object = {}) => ({
  version: 1,
  graphId: 'g',
  from: { partition: 'category', ids: ['c'] },
  return: { shape: 'ids' },
  ...over,
});

const failure = (r: ReturnType<typeof parseMutation>) => (r.ok ? undefined : r.error);

describe('defaults', () => {
  it('are 1000 ops, 64 KB data, 256-char ids, 10,000 reached nodes', () => {
    expect(DEFAULT_LIMITS).toEqual({ maxOps: 1000, maxDataBytes: 65536, maxIdLength: 256, maxReachedNodes: 10000 });
  });
});

describe('ops per mutation', () => {
  it('accepts exactly the cap and rejects one over', () => {
    const ops = (n: number) => Array.from({ length: n }, (_, i) => upsert({ id: `n${i}` }));
    expect(parseMutation(mutation(ops(1000))).ok).toBe(true);
    expect(failure(parseMutation(mutation(ops(1001))))).toMatchObject({
      code: 'VALIDATION_ERROR',
      path: ['ops'],
    });
  });

  it('is overridable', () => {
    const ops = [upsert(), upsert({ id: 'b' }), upsert({ id: 'c' })];
    expect(parseMutation(mutation(ops), { limits: { maxOps: 2 } }).ok).toBe(false);
    expect(parseMutation(mutation(ops), { limits: { maxOps: 3 } }).ok).toBe(true);
  });

  it('rejects before the full schema parse (cheap for huge junk batches)', () => {
    const junk = Array.from({ length: 2000 }, () => ({ nonsense: true }));
    expect(failure(parseMutation(mutation(junk)))?.path).toEqual(['ops']);
  });
});

describe('id length', () => {
  const long = (n: number) => 'x'.repeat(n);

  it('accepts 256 chars and rejects 257 in every op field', () => {
    expect(parseMutation(mutation([upsert({ id: long(256) })])).ok).toBe(true);
    expect(failure(parseMutation(mutation([upsert({ id: long(257) })])))?.path).toEqual(['ops', 0, 'id']);
    expect(
      failure(parseMutation(mutation([{ op: 'link', item: long(257), category: 'c' }])))?.path,
    ).toEqual(['ops', 0, 'item']);
    expect(
      failure(parseMutation(mutation([{ op: 'unlink', item: 'a', category: long(257) }])))?.path,
    ).toEqual(['ops', 0, 'category']);
    expect(
      failure(parseMutation(mutation([{ op: 'deleteNode', partition: 'item', id: long(257) }])))?.path,
    ).toEqual(['ops', 0, 'id']);
  });

  it('applies to graphId and to query ids', () => {
    expect(failure(parseMutation(mutation([], long(257))))?.path).toEqual(['graphId']);
    expect(parseQuery(query({ from: { partition: 'category', ids: [long(257)] } })).ok).toBe(false);
    expect(failure(parseQuery(query({ filter: { none: ['ok', long(257)] } })) as never)?.path).toEqual([
      'filter',
      'none',
      1,
    ]);
  });

  it('is overridable', () => {
    expect(parseMutation(mutation([upsert({ id: 'abcd' })]), { limits: { maxIdLength: 3 } }).ok).toBe(false);
    expect(parseMutation(mutation([upsert({ id: long(300) })]), { limits: { maxIdLength: 300 } }).ok).toBe(true);
  });
});

describe('data size', () => {
  const payload = (bytes: number) => ({ s: 'x'.repeat(bytes - '{"s":""}'.length) });

  it('accepts exactly 64 KB and rejects one byte over', () => {
    expect(parseMutation(mutation([upsert({ data: payload(65536) })])).ok).toBe(true);
    expect(failure(parseMutation(mutation([upsert({ data: payload(65537) })])))).toMatchObject({
      code: 'VALIDATION_ERROR',
      path: ['ops', 0, 'data'],
    });
  });

  it('applies to link data and counts bytes, not characters', () => {
    const link = (data: object) => ({ op: 'link', item: 'a', category: 'c', data });
    expect(failure(parseMutation(mutation([link(payload(65537))])))?.path).toEqual(['ops', 0, 'data']);
    // 'é' is 2 bytes in UTF-8, so 40000 of them exceed 64 KB although only 40000 characters.
    expect(parseMutation(mutation([upsert({ data: { s: 'é'.repeat(40000) } })])).ok).toBe(false);
  });

  it('is overridable', () => {
    const op = upsert({ data: { a: 1 } });
    expect(parseMutation(mutation([op]), { limits: { maxDataBytes: 5 } }).ok).toBe(false);
    expect(parseMutation(mutation([op]), { limits: { maxDataBytes: 100 } }).ok).toBe(true);
  });
});
