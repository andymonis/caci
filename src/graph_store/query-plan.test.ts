import { describe, expect, it } from 'vitest';
import { parseQuery } from './parse.js';
import { encodeQueryCursor, queryFingerprint } from './query-cursor.js';
import { planQuery } from './query-plan.js';
import type { Query } from './types.js';

/** Goes through the real parser, so the planner sees defaults filled in exactly as in production. */
function parsed(input: unknown): Query {
  const r = parseQuery(input);
  if (!r.ok) throw new Error(`test query was invalid: ${r.error.message}`);
  return r.value;
}
const base = { version: 1, graphId: 'user_42', from: { all: true }, return: { shape: 'nodes' } };
const plan = (input: object) => planQuery(parsed({ ...base, ...input }));
const planOk = (input: object) => {
  const r = plan(input);
  if (!r.ok) throw new Error(`expected a plan, got ${r.error.code}: ${r.error.message}`);
  return r.value;
};

describe("planQuery: the spec's own query examples", () => {
  it('everything about doctor X at depth 1, as a subgraph with data', () => {
    const r = planQuery(
      parsed({
        version: 1,
        graphId: 'user_42',
        from: { partition: 'category', ids: ['doctor-x'] },
        traverse: { depth: 1 },
        return: { shape: 'subgraph', includeData: true },
        page: { limit: 100, cursor: null },
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      value: {
        graphId: 'user_42',
        seeds: { kind: 'ids', partition: 'category', ids: ['doctor-x'] },
        depth: 1,
        excludeSeeds: false,
        partition: undefined,
        shape: 'subgraph',
        includeData: true,
        limit: 100,
        after: null,
      },
    });
  });

  it('doctor X found by a field in data is refused by name, because matching on data comes later', () => {
    const r = planQuery(
      parsed({
        version: 1,
        graphId: 'user_42',
        from: { partition: 'category', where: { 'data.name': { eq: 'Dr X' } } },
        traverse: { depth: 1 },
        filter: { partition: 'item', where: { 'data.type': { eq: 'appointment' } } },
        return: { shape: 'nodes' },
      }),
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', path: ['from', 'where'] } });
    if (!r.ok) expect(r.error.message).toContain('not supported yet');
  });

  it('the whole graph as a subgraph', () => {
    const value = planOk({ return: { shape: 'subgraph' } });
    expect(value).toMatchObject({ seeds: { kind: 'all' }, depth: 0, shape: 'subgraph', includeData: false, limit: 50, after: null });
  });
});

describe('planQuery: seeds and depth', () => {
  it('lists named seeds once each, in a fixed order, whatever order they were given in', () => {
    const value = planOk({ from: { partition: 'item', ids: ['b', 'a', 'b', 'B', 'a'] } });
    expect(value.seeds).toEqual({ kind: 'ids', partition: 'item', ids: ['B', 'a', 'b'] });
  });

  it.each([0, 1, 2, 3])('keeps depth %i for named seeds', (depth) => {
    expect(planOk({ from: { partition: 'category', ids: ['c'] }, traverse: { depth } }).depth).toBe(depth);
  });

  it('defaults to depth 1 for named seeds', () => {
    expect(planOk({ from: { partition: 'category', ids: ['c'] } }).depth).toBe(1);
  });

  it('ignores traverse for `all`, which already is the whole graph', () => {
    expect(planOk({ from: { all: true }, traverse: { depth: 3 } }).depth).toBe(0);
  });
});

describe('planQuery: filter and shape', () => {
  it('passes the partition filter and excludeSeeds through', () => {
    const value = planOk({ from: { partition: 'category', ids: ['c'] }, filter: { partition: 'item', excludeSeeds: true } });
    expect(value).toMatchObject({ partition: 'item', excludeSeeds: true });
  });

  it('defaults to no partition filter and keeping the seeds', () => {
    expect(planOk({})).toMatchObject({ partition: undefined, excludeSeeds: false });
  });

  it.each(['subgraph', 'nodes', 'ids', 'count'] as const)('carries the %s shape', (shape) => {
    expect(planOk({ return: { shape } }).shape).toBe(shape);
  });

  it('includeData defaults to false and can be switched on or off explicitly', () => {
    expect(planOk({}).includeData).toBe(false);
    expect(planOk({ return: { shape: 'nodes', includeData: true } }).includeData).toBe(true);
    expect(planOk({ return: { shape: 'nodes', includeData: false } }).includeData).toBe(false);
  });

  it('passes an excludeSeeds request on `all` through unchanged (the result is simply empty)', () => {
    expect(planOk({ from: { all: true }, filter: { excludeSeeds: true } })).toMatchObject({ seeds: { kind: 'all' }, excludeSeeds: true });
  });
});

describe('planQuery: paging', () => {
  it('uses the default and the given limit', () => {
    expect(planOk({}).limit).toBe(50);
    expect(planOk({ page: { limit: 1000 } }).limit).toBe(1000);
    expect(planOk({ page: { limit: 1 } }).limit).toBe(1);
  });

  it('turns a cursor from the same query into a position, whatever the page size', () => {
    const first = parsed({ ...base, page: { limit: 10 } });
    const cursor = encodeQueryCursor(queryFingerprint(first), { partition: 'item', id: 'visit-17' });
    expect(planQuery(parsed({ ...base, page: { limit: 500, cursor } }))).toMatchObject({
      ok: true,
      value: { after: { partition: 'item', id: 'visit-17' }, limit: 500 },
    });
  });

  it('refuses a cursor made for a different query, with a path to the cursor', () => {
    const other = parsed({ ...base, graphId: 'someone_else' });
    const cursor = encodeQueryCursor(queryFingerprint(other), { partition: 'item', id: 'a' });
    expect(plan({ page: { cursor } })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', path: ['page', 'cursor'] } });
  });

  it('refuses a cursor that is not a cursor', () => {
    expect(plan({ page: { cursor: 'next-page-please' } })).toMatchObject({ ok: false, error: { path: ['page', 'cursor'] } });
  });

  it('refuses a cursor on a count, which is not paged', () => {
    const cursor = encodeQueryCursor(queryFingerprint(parsed({ ...base, return: { shape: 'count' } })), { partition: 'item', id: 'a' });
    const r = plan({ return: { shape: 'count' }, page: { cursor } });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', path: ['page', 'cursor'] } });
    if (!r.ok) expect(r.error.message).toContain('not paged');
  });

  it('records the fingerprint that cursors will be bound to', () => {
    const q = parsed(base);
    expect(planOk(base).fingerprint).toBe(queryFingerprint(q));
  });
});

describe('planQuery: features that are accepted but not yet executed are refused by name', () => {
  const seeds = { from: { partition: 'category', ids: ['c'] } };

  it.each([
    ['filter.where', { filter: { where: { 'data.type': { eq: 'appointment' } } } }, ['filter', 'where']],
    ['filter.all', { filter: { all: ['a'] } }, ['filter', 'all']],
    ['filter.any', { filter: { any: ['a', 'b'] } }, ['filter', 'any']],
    ['filter.none', { filter: { none: ['a'] } }, ['filter', 'none']],
    ['an empty filter.all (not silently treated as "no constraint")', { filter: { all: [] } }, ['filter', 'all']],
    ['an empty filter.any', { filter: { any: [] } }, ['filter', 'any']],
    ['an empty filter.none', { filter: { none: [] } }, ['filter', 'none']],
  ])('%s', (_name, extra, path) => {
    const r = plan({ ...seeds, ...extra });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', path } });
    if (!r.ok) expect(r.error.message).toContain('not supported yet');
  });

  it('refuses rather than half-running when supported and unsupported parts are mixed', () => {
    const r = plan({ ...seeds, filter: { partition: 'item', excludeSeeds: true, any: ['x'] } });
    expect(r).toMatchObject({ ok: false, error: { path: ['filter', 'any'] } });
  });

  it('always reports the same first problem, in a fixed order: from.where, filter.where, all, any, none', () => {
    const where = { 'data.x': { eq: 1 } };
    const everything = { from: { partition: 'category', where }, filter: { where, all: ['a'], any: ['b'], none: ['c'] } };
    expect(plan(everything)).toMatchObject({ error: { path: ['from', 'where'] } });
    expect(plan({ ...seeds, filter: { where, all: ['a'], any: ['b'], none: ['c'] } })).toMatchObject({ error: { path: ['filter', 'where'] } });
    expect(plan({ ...seeds, filter: { all: ['a'], any: ['b'], none: ['c'] } })).toMatchObject({ error: { path: ['filter', 'all'] } });
    expect(plan({ ...seeds, filter: { any: ['b'], none: ['c'] } })).toMatchObject({ error: { path: ['filter', 'any'] } });
    expect(plan({ ...seeds, filter: { none: ['c'] } })).toMatchObject({ error: { path: ['filter', 'none'] } });
  });
});

describe('planQuery: purity', () => {
  it('does not change the query it is given', () => {
    const q = parsed({ ...base, from: { partition: 'item', ids: ['b', 'a'] }, filter: { partition: 'category' } });
    const frozen = JSON.stringify(q);
    planQuery(q);
    expect(JSON.stringify(q)).toBe(frozen);
    expect(q.from).toEqual({ partition: 'item', ids: ['b', 'a'] }); // seed order untouched; only the plan is sorted
  });

  it('gives the same plan for the same query every time', () => {
    const q = parsed({ ...base, from: { partition: 'item', ids: ['b', 'a'] } });
    expect(planQuery(q)).toEqual(planQuery(q));
  });

  it('gives the same plan however the keys of the query are ordered', () => {
    const a = parsed({ version: 1, graphId: 'g', from: { all: true }, return: { shape: 'ids' }, page: { limit: 5 } });
    const b = parsed({ page: { limit: 5 }, return: { shape: 'ids' }, from: { all: true }, graphId: 'g', version: 1 });
    expect(planQuery(a)).toEqual(planQuery(b));
  });
});
