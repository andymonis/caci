import { describe, expectTypeOf, it } from 'vitest';
import type { ParsedMutation, ParsedOp } from './schema/mutation.js';
import type { ParsedQuery } from './schema/query.js';
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
});
