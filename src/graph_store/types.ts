import type { JsonObject, JsonValue, Partition } from './adapter.js';

// Public instruction types, written out by hand so the API report records their exact shape.
// `types.test.ts` asserts they stay identical to what the Zod schemas infer.

export type Op =
  | {
      op: 'upsertNode';
      partition: Partition;
      id: string;
      data?: JsonObject | undefined;
      mode: 'replace' | 'merge';
    }
  | { op: 'deleteNode'; partition: Partition; id: string }
  | {
      op: 'link';
      item: string;
      category: string;
      weight?: number | undefined;
      data?: JsonObject | undefined;
      ensureNodes: boolean;
    }
  | { op: 'unlink'; item: string; category: string };

export interface Mutation {
  version: 1;
  kind: 'mutation';
  graphId: string;
  requestId?: string | undefined;
  createIfMissing: boolean;
  ops: Op[];
}

export type WhereCondition =
  | { eq: JsonValue }
  | { ne: JsonValue }
  | { in: JsonValue[] }
  | { contains: JsonValue }
  | { startsWith: string }
  | { exists: boolean };

/** Keys are dotted paths into node data, e.g. `data.name`. */
export type Where = Record<string, WhereCondition>;

export type QueryFrom =
  | { all: true }
  | { partition: Partition; ids: string[] }
  | { partition: Partition; where: Where };

export interface QueryTraverse {
  depth: number;
}

export interface QueryFilter {
  partition?: Partition | undefined;
  where?: Where | undefined;
  all?: string[] | undefined;
  any?: string[] | undefined;
  none?: string[] | undefined;
  excludeSeeds?: boolean | undefined;
}

export interface QueryReturn {
  shape: 'subgraph' | 'nodes' | 'ids' | 'count';
  includeData?: boolean | undefined;
}

export interface QueryPage {
  limit: number;
  cursor: string | null;
}

export interface Query {
  version: 1;
  graphId: string;
  from: QueryFrom;
  traverse: QueryTraverse;
  filter?: QueryFilter | undefined;
  return: QueryReturn;
  page: QueryPage;
}

export interface WriteOutput {
  /** The graph the mutation was applied to. */
  graphId: string;
  /** Ops applied. A mutation is all-or-nothing, so this is every op or the call fails (FR-08). */
  applied: number;
  /** True when this call created the graph (`createIfMissing`). */
  graphCreated: boolean;
}

/** Identifies a graph; returned by `createGraph` and `dropGraph`. */
export interface GraphRef {
  graphId: string;
}
