import { describe, expect, it } from 'vitest';
import { parseMutation, parseQuery } from './parse.js';

const mutation = {
  version: 1,
  kind: 'mutation',
  graphId: 'g',
  ops: [{ op: 'upsertNode', partition: 'item', id: 'a' }],
};

const query = {
  version: 1,
  graphId: 'g',
  from: { all: true },
  return: { shape: 'count' },
};

const garbage: [string, unknown][] = [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'hello'],
  ['a number', 42],
  ['an array', []],
  ['an empty object', {}],
  ['a malformed object', { version: 1, kind: 'mutation', ops: 'nope' }],
];

describe.each([
  ['parseMutation', parseMutation, mutation],
  ['parseQuery', parseQuery, query],
] as const)('%s', (_name, parse, valid) => {
  it('accepts valid input', () => {
    expect(parse(valid).ok).toBe(true);
  });

  it.each(garbage)('returns an error and never throws for %s', (_label, input) => {
    const r = parse(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toMatch(/VALIDATION_ERROR|UNSUPPORTED_VERSION/);
  });

  it.each([2, 0, '1', null])('gives UNSUPPORTED_VERSION for version %j', (version) => {
    const r = parse({ ...valid, version });
    expect(r).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_VERSION', path: ['version'] } });
  });

  it('survives hostile objects', () => {
    const hostile = {
      get version(): number {
        throw new Error('boom');
      },
    };
    expect(parse(hostile).ok).toBe(false);
  });
});

describe('parseMutation', () => {
  it('returns the parsed value with defaults applied', () => {
    const r = parseMutation(mutation);
    expect(r).toMatchObject({ ok: true, value: { createIfMissing: false } });
  });

  it('rejects a query with VALIDATION_ERROR', () => {
    expect(parseMutation(query)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('reports a path for schema failures', () => {
    const bad = { ...mutation, ops: [{ op: 'link', item: 'a' }] };
    expect(parseMutation(bad)).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', path: ['ops', 0, 'category'] },
    });
  });
});

describe('parseQuery', () => {
  it('returns the parsed value with defaults applied', () => {
    const r = parseQuery(query);
    expect(r).toMatchObject({ ok: true, value: { traverse: { depth: 1 }, page: { limit: 50 } } });
  });

  it('rejects a mutation with VALIDATION_ERROR', () => {
    expect(parseQuery(mutation)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects depth above 3', () => {
    const bad = { ...query, traverse: { depth: 4 } };
    expect(parseQuery(bad)).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', path: ['traverse', 'depth'] },
    });
  });
});
