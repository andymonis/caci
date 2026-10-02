import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ParsedMutation, ParsedOp } from './schema/mutation.js';
import type { ParsedQuery } from './schema/query.js';
import type { CountOutput, IdsOutput, NodesOutput, QueryOutput, SubgraphOutput } from './types.js';
import type { Mutation, Op, Query } from './types.js';

// The hand-written public types and the Zod-inferred types must be mutually assignable.
describe('public types match the Zod schemas', () => {
  it('Op', () => {
    expectTypeOf<ParsedOp>().toExtend<Op>();
    expectTypeOf<Op>().toExtend<ParsedOp>();
  });

  it('Mutation', () => {
    expectTypeOf<ParsedMutation>().toExtend<Mutation>();
    expectTypeOf<Mutation>().toExtend<ParsedMutation>();
  });

  it('Query', () => {
    expectTypeOf<ParsedQuery>().toExtend<Query>();
    expectTypeOf<Query>().toExtend<ParsedQuery>();
  });

  it('has no tautological gaps', () => {
    // A field present on one side only would break mutual assignability above; guard the guard.
    expectTypeOf<{ a: 1 }>().not.toExtend<{ a: 1; b: 2 }>();
  });

  it('query results: each shape has its own keys, so a result can be told apart', () => {
    expectTypeOf<SubgraphOutput>().toExtend<NodesOutput>(); // a subgraph is a nodes result plus edges
    expectTypeOf<NodesOutput>().not.toExtend<SubgraphOutput>();
    expectTypeOf<IdsOutput>().not.toExtend<NodesOutput>();
    expectTypeOf<CountOutput>().not.toExtend<IdsOutput>();
    expectTypeOf<QueryOutput>().toEqualTypeOf<SubgraphOutput | NodesOutput | IdsOutput | CountOutput>();

    const describe = (r: QueryOutput): string =>
      'edges' in r ? `subgraph ${r.edges.length}` : 'nodes' in r ? `nodes ${r.nodes.length}` : 'ids' in r ? `ids ${r.ids.length}` : `count ${r.count}`;
    expect(describe({ nodes: [], edges: [{ item: 'a', category: 'c', weight: 1 }], nextCursor: null, truncated: false })).toBe('subgraph 1');
    expect(describe({ nodes: [], nextCursor: null, truncated: false })).toBe('nodes 0');
    expect(describe({ ids: [{ partition: 'item', id: 'a' }], nextCursor: null, truncated: false })).toBe('ids 1');
    expect(describe({ count: 7, truncated: true })).toBe('count 7');
  });
});
