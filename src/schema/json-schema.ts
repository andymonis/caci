import { z } from 'zod';
import { mutationSchema } from './mutation.js';
import { querySchema } from './query.js';

const BASE_ID = 'https://github.com/andymonis/caci/schema';

function generate(schema: z.ZodType, name: string, title: string): Record<string, unknown> {
  // `input` so fields with defaults are optional: this describes what callers may send.
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
  return { ...json, $id: `${BASE_ID}/${name}.v1.schema.json`, title };
}

export function mutationJsonSchema(): Record<string, unknown> {
  return generate(mutationSchema, 'mutation', 'Bipartite Graph Store mutation (v1)');
}

export function queryJsonSchema(): Record<string, unknown> {
  return generate(querySchema, 'query', 'Bipartite Graph Store query (v1)');
}
