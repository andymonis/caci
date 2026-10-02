import { describe, expect, it } from 'vitest';
import { querySchema } from './query.js';

const references = {
  version: 1,
  graphId: 'user_42',
  from: { partition: 'category', ids: ['doctor-x'] },
  traverse: { depth: 1 },
  return: { shape: 'subgraph', includeData: true },
  page: { limit: 100, cursor: null },
};

const byDataMatch = {
  version: 1,
  graphId: 'user_42',
  from: { partition: 'category', where: { 'data.name': { eq: 'Dr X' } } },
  traverse: { depth: 1 },
  filter: { partition: 'item', where: { 'data.type': { eq: 'appointment' } } },
  return: { shape: 'nodes' },
};

const wholeGraph = {
  version: 1,
  graphId: 'user_42',
  from: { all: true },
  return: { shape: 'subgraph' },
};

describe('querySchema', () => {
  it.each([
    ['references example', references],
    ['data-match example', byDataMatch],
    ['whole-graph example', wholeGraph],
  ])('parses the spec %s', (_name, input) => {
    expect(querySchema.safeParse(input).success).toBe(true);
  });

  it('applies defaults: depth 1, limit 50, cursor null', () => {
    const r = querySchema.parse(wholeGraph);
    expect(r.traverse).toEqual({ depth: 1 });
    expect(r.page).toEqual({ limit: 50, cursor: null });
    expect(querySchema.parse({ ...wholeGraph, traverse: {} }).traverse.depth).toBe(1);
    expect(querySchema.parse({ ...wholeGraph, page: {} }).page).toEqual({ limit: 50, cursor: null });
  });

  it('accepts depth 0 to 3 and rejects 4, negatives and fractions', () => {
    const withDepth = (depth: number) => querySchema.safeParse({ ...references, traverse: { depth } });
    for (const d of [0, 1, 2, 3]) expect(withDepth(d).success).toBe(true);
    for (const d of [4, -1, 1.5]) expect(withDepth(d).success).toBe(false);
  });

  it('rejects depth 4 with a path to depth', () => {
    const r = querySchema.safeParse({ ...references, traverse: { depth: 4 } });
    expect(r.error?.issues[0]?.path).toEqual(['traverse', 'depth']);
  });

  it('enforces limit between 1 and 1000', () => {
    const withLimit = (limit: number) => querySchema.safeParse({ ...references, page: { limit } });
    expect(withLimit(1000).success).toBe(true);
    expect(withLimit(1001).success).toBe(false);
    expect(withLimit(0).success).toBe(false);
  });

  it('accepts only the closed where operator set', () => {
    const withWhere = (cond: object) =>
      querySchema.safeParse({ ...byDataMatch, from: { partition: 'category', where: { 'data.x': cond } } });
    expect(withWhere({ eq: 1 }).success).toBe(true);
    expect(withWhere({ ne: 'a' }).success).toBe(true);
    expect(withWhere({ in: [1, 'a'] }).success).toBe(true);
    expect(withWhere({ contains: 'a' }).success).toBe(true);
    expect(withWhere({ startsWith: 'a' }).success).toBe(true);
    expect(withWhere({ exists: true }).success).toBe(true);
    expect(withWhere({ regex: 'a' }).success).toBe(false);
    expect(withWhere({ gt: 1 }).success).toBe(false);
    expect(withWhere({ eq: 1, ne: 2 }).success).toBe(false);
  });

  it('requires where keys to be dotted paths into data', () => {
    const withKey = (key: string) =>
      querySchema.safeParse({ ...byDataMatch, from: { partition: 'category', where: { [key]: { eq: 1 } } } });
    expect(withKey('data.a.b').success).toBe(true);
    expect(withKey('name').success).toBe(false);
    expect(withKey('data').success).toBe(false);
  });

  it('rejects unknown return shapes, unknown keys, and mutation payloads', () => {
    expect(querySchema.safeParse({ ...references, return: { shape: 'table' } }).success).toBe(false);
    expect(querySchema.safeParse({ ...references, extra: 1 }).success).toBe(false);
    const mutation = { version: 1, kind: 'mutation', graphId: 'g', ops: [] };
    expect(querySchema.safeParse(mutation).success).toBe(false);
  });

  it('rejects empty ids and a missing return', () => {
    expect(querySchema.safeParse({ ...references, from: { partition: 'category', ids: [] } }).success).toBe(false);
    const noReturn: Record<string, unknown> = { ...references };
    delete noReturn.return;
    expect(querySchema.safeParse(noReturn).success).toBe(false);
  });

  describe('graphId character set (safe for file names)', () => {
    const withGraphId = (graphId: unknown) => ({ ...wholeGraph, graphId });

    it.each(['a', '0', 'user_42', 'a-b_c-9', 'x'.repeat(128)])('accepts %s', (id) => {
      expect(querySchema.safeParse(withGraphId(id)).success).toBe(true);
    });

    it.each([
      ['empty', ''],
      ['upper case', 'Graph'],
      ['a slash', 'a/b'],
      ['a parent path', '../x'],
      ['a dot', 'a.b'],
      ['a space', 'a b'],
      ['non-ASCII text', 'ünï'],
      ['a leading dash', '-a'],
      ['a leading underscore', '_a'],
      ['129 characters', 'x'.repeat(129)],
      ['a number', 7],
    ])('rejects %s with a path to graphId', (_name, bad) => {
      const r = querySchema.safeParse(withGraphId(bad));
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(['graphId']);
    });
  });

});
