import { z } from 'zod';
import { GRAPH_ID_PATTERN, GRAPH_ID_RULE, MAX_GRAPH_ID_LENGTH } from '../graph-id.js';

const id = z.string().min(1);
const graphId = z
  .string()
  .min(1)
  .max(MAX_GRAPH_ID_LENGTH)
  .regex(GRAPH_ID_PATTERN, `graphId must be ${GRAPH_ID_RULE}`);
const partition = z.enum(['item', 'category']);
const data = z.record(z.string(), z.json());

const upsertNode = z.strictObject({
  op: z.literal('upsertNode'),
  partition,
  id,
  data: data.optional(),
  mode: z.enum(['replace', 'merge']).default('replace'),
});

const deleteNode = z.strictObject({
  op: z.literal('deleteNode'),
  partition,
  id,
});

const link = z.strictObject({
  op: z.literal('link'),
  item: id,
  category: id,
  weight: z.number().finite().optional(),
  data: data.optional(),
  ensureNodes: z.boolean().default(false),
});

const unlink = z.strictObject({
  op: z.literal('unlink'),
  item: id,
  category: id,
});

export const opSchema = z.discriminatedUnion('op', [upsertNode, deleteNode, link, unlink]);

export const mutationSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('mutation'),
  graphId,
  requestId: z.string().min(1).optional(),
  createIfMissing: z.boolean().default(false),
  ops: z.array(opSchema),
});

export type ParsedOp = z.infer<typeof opSchema>;
export type ParsedMutation = z.infer<typeof mutationSchema>;
