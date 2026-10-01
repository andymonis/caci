export type GraphId = string;
export type Partition = 'item' | 'category';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Keyset paging: `cursor` is opaque to callers and `null` starts from the beginning. */
export interface Page {
  readonly limit: number;
  readonly cursor: string | null;
}

export interface Paged<T> {
  readonly items: readonly T[];
  /** `null` when there are no more results. */
  readonly nextCursor: string | null;
}

export interface NodeRecord {
  readonly partition: Partition;
  readonly id: string;
  readonly data?: JsonObject;
}

export interface EdgeKey {
  readonly item: string;
  readonly category: string;
}

export interface EdgeRecord extends EdgeKey {
  readonly weight?: number;
  readonly data?: JsonObject;
}

/** Category-id set clauses: `all` is AND, `any` is OR, `none` is NOT. */
export interface SetClause {
  readonly all?: readonly string[];
  readonly any?: readonly string[];
  readonly none?: readonly string[];
}

export interface AdapterCapabilities {
  readonly transactions: boolean;
  readonly idempotency: boolean;
  readonly nativeSetQueries: boolean;
}

/** Primitives available inside a transaction, scoped to the graph the transaction was opened for. */
export interface AdapterTx {
  getNodes(p: Partition, ids: string[]): Promise<NodeRecord[]>;
  putNodes(nodes: NodeRecord[]): Promise<void>;
  deleteNodes(p: Partition, ids: string[]): Promise<void>;
  putEdges(edges: EdgeRecord[]): Promise<void>;
  deleteEdges(keys: EdgeKey[]): Promise<void>;
  edgesOf(p: Partition, id: string, page: Page): Promise<Paged<EdgeRecord>>;
  listNodes(p: Partition, page: Page): Promise<Paged<NodeRecord>>;
  /** Optional fast path, used when `capabilities.nativeSetQueries` is true. */
  itemsByCategories?(clause: SetClause, page: Page): Promise<Paged<NodeRecord>>;
}

/**
 * Storage backend. All graph logic (validation, bipartite rules, cascade, query planning)
 * lives in the core; an adapter only provides these primitives.
 */
export interface StorageAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;

  transaction<T>(graphId: GraphId, fn: (tx: AdapterTx) => Promise<T>): Promise<T>;

  graphs: {
    create(id: GraphId): Promise<void>;
    exists(id: GraphId): Promise<boolean>;
    list(page: Page): Promise<Paged<GraphId>>;
    drop(id: GraphId): Promise<void>;
  };
}
