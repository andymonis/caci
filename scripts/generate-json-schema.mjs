// Writes schema/graph_store/*.json from the Zod schemas. Run via `npm run schema` (builds first).
import { writeFileSync } from 'node:fs';
import { mutationJsonSchema, queryJsonSchema } from '../dist/graph_store/schema/json-schema.js';

const files = {
  'schema/graph_store/mutation.v1.schema.json': mutationJsonSchema(),
  'schema/graph_store/query.v1.schema.json': queryJsonSchema(),
};

for (const [path, doc] of Object.entries(files)) {
  writeFileSync(new URL(`../${path}`, import.meta.url), JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote ${path}`);
}
