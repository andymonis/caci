import { z } from 'zod';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../limits.js';

const id = z.string().min(1);
const partition = z.enum(['item', 'category']);
const json = z.json();

/** Dotted path into a node's data payload, e.g. `data.name`. */
const dataPath = z.string().regex(/^data(\.[A-Za-z0-9_-]+)+$/, 'must be a dotted path starting with "data."');

/** Exactly one operator per condition; the operator set is closed. */
const condition = z.union([
  z.strictObject({ eq: json }),
  z.strictObject({ ne: json }),
  z.strictObject({ in: z.array(json) }),
  z.strictObject({ contains: json }),
  z.strictObject({ startsWith: z.string() }),
  z.strictObject({ exists: z.boolean() }),
]);

const where = z.record(dataPath, condition);

const from = z.union([
  z.strictObject({ all: z.literal(true) }),
  z.strictObject({ partition, ids: z.array(id).min(1) }),
  z.strictObject({ partition, where }),
]);

const traverse = z.strictObject({
  depth: z.number().int().min(0).max(3).default(1),
});

const filter = z.strictObject({
  partition: partition.optional(),
  where: where.optional(),
  all: z.array(id).optional(),
  any: z.array(id).optional(),
  none: z.array(id).optional(),
  excludeSeeds: z.boolean().optional(),
});

const returnSpec = z.strictObject({
  shape: z.enum(['subgraph', 'nodes', 'ids', 'count']),
  includeData: z.boolean().optional(),
});

const page = z.strictObject({
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().min(1).nullable().default(null),
});

export const querySchema = z.strictObject({
  version: z.literal(1),
  graphId: id,
  from,
  traverse: traverse.default({ depth: 1 }),
  filter: filter.optional(),
  return: returnSpec,
  page: page.default({ limit: DEFAULT_PAGE_LIMIT, cursor: null }),
});

export type ParsedQuery = z.infer<typeof querySchema>;
