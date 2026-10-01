import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { mutationJsonSchema, queryJsonSchema } from './json-schema.js';

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));

const mutationExample = {
  version: 1,
  kind: 'mutation',
  graphId: 'user_42',
  requestId: 'b7c1-1',
  createIfMissing: true,
  ops: [
    { op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 'Q3 plan' } },
    { op: 'upsertNode', partition: 'category', id: 'planning' },
    { op: 'link', item: 'note-1', category: 'planning', weight: 0.8 },
    { op: 'unlink', item: 'note-1', category: 'drafts' },
    { op: 'deleteNode', partition: 'item', id: 'note-0' },
  ],
};

const queryExamples = [
  {
    version: 1,
    graphId: 'user_42',
    from: { partition: 'category', ids: ['doctor-x'] },
    traverse: { depth: 1 },
    return: { shape: 'subgraph', includeData: true },
    page: { limit: 100, cursor: null },
  },
  {
    version: 1,
    graphId: 'user_42',
    from: { partition: 'category', where: { 'data.name': { eq: 'Dr X' } } },
    traverse: { depth: 1 },
    filter: { partition: 'item', where: { 'data.type': { eq: 'appointment' } } },
    return: { shape: 'nodes' },
  },
  { version: 1, graphId: 'user_42', from: { all: true }, return: { shape: 'subgraph' } },
];

const ajv = new Ajv2020({ strict: false });
const validateMutation = ajv.compile(read('schema/mutation.v1.schema.json') as object);
const validateQuery = ajv.compile(read('schema/query.v1.schema.json') as object);

describe('committed JSON Schema files', () => {
  it('match the generator output (run `npm run schema` if this fails)', () => {
    expect(read('schema/mutation.v1.schema.json')).toEqual(mutationJsonSchema());
    expect(read('schema/query.v1.schema.json')).toEqual(queryJsonSchema());
  });
});

describe('mutation JSON Schema', () => {
  it("accepts the spec's mutation example", () => {
    expect(validateMutation(mutationExample)).toBe(true);
  });

  it('accepts a minimal mutation (defaults are optional)', () => {
    expect(validateMutation({ version: 1, kind: 'mutation', graphId: 'g', ops: [] })).toBe(true);
  });

  it.each([
    ['unknown op', { ...mutationExample, ops: [{ op: 'explode' }] }],
    ['kind: query', { ...mutationExample, kind: 'query' }],
    ['unknown key', { ...mutationExample, extra: 1 }],
    ['missing category', { ...mutationExample, ops: [{ op: 'link', item: 'a' }] }],
  ])('rejects %s', (_name, input) => {
    expect(validateMutation(input)).toBe(false);
  });
});

describe('query JSON Schema', () => {
  it.each(queryExamples.map((q, i) => [`spec example ${i + 1}`, q] as const))('accepts %s', (_n, q) => {
    expect(validateQuery(q)).toBe(true);
  });

  it.each([
    ['depth 4', { ...queryExamples[0], traverse: { depth: 4 } }],
    ['limit 1001', { ...queryExamples[0], page: { limit: 1001 } }],
    ['unknown operator', { ...queryExamples[1], from: { partition: 'category', where: { 'data.x': { gt: 1 } } } }],
    ['mutation payload', mutationExample],
  ])('rejects %s', (_name, input) => {
    expect(validateQuery(input)).toBe(false);
  });
});
