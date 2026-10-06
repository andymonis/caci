import { describeGraph, err, ok, query, type CountOutput, type GraphError, type JsonObject, type NodesOutput, type Result, type StorageAdapter, type SubgraphOutput } from '../graph_store/index.js';
import { caciError, type CaciError } from './errors.js';

/** Largest `data` of one node that is returned whole, in characters of JSON. */
export const MAX_DATA_CHARS = 4096;
/** A string value cut to this many characters when its node's data is over the cap. */
const CUT_STRING = 300;
const MAX_ID_CHARS = 256;
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 100;
/** Categories of one item listed in one answer. */
const ITEM_CATEGORIES = 200;
const MAX_NAME = 100;

export interface PageInput {
  readonly limit?: unknown;
  readonly cursor?: unknown;
}

export interface GraphSummary {
  readonly itemCount: number;
  readonly categoryCount: number;
  readonly edgeCount: number;
}

export interface CategoryView {
  readonly id: string;
  /** From the category's data, when it has a text `name`. */
  readonly name?: string;
  /** How many items are filed under it. */
  readonly itemCount: number;
  /** True when the count is a lower bound because a size cap cut the count short. */
  readonly itemCountCapped?: true;
}

export interface CategoryPage {
  readonly items: readonly CategoryView[];
  readonly nextCursor: string | null;
}

export interface ItemView {
  readonly id: string;
  readonly data: JsonObject;
  /** True when the data was over the size cap and was shortened. */
  readonly dataTruncated?: true;
}

export interface CategoryItemsPage {
  readonly category: { readonly id: string; readonly name?: string };
  readonly items: readonly ItemView[];
  readonly nextCursor: string | null;
}

export interface ItemDetail {
  readonly item: ItemView;
  readonly categories: ReadonlyArray<{ readonly id: string; readonly name?: string; readonly weight: number }>;
  /** True when the item is filed under more categories than are listed here. */
  readonly moreCategories?: true;
}

/** `{ limit, cursor }` as the store wants it, or the error naming the field. */
function pageOf(input: PageInput | undefined): Result<{ limit: number; cursor: string | null }, CaciError> {
  const limit = input?.limit === undefined ? DEFAULT_PAGE : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return err(caciError('INVALID_INPUT', `limit must be a whole number from 1 to ${MAX_PAGE}`, { field: 'limit' }));
  const cursor = input?.cursor === undefined ? null : input.cursor;
  if (cursor !== null && (typeof cursor !== 'string' || cursor === '' || cursor.length > 2048)) return err(caciError('INVALID_INPUT', 'cursor must be the nextCursor of an earlier page', { field: 'cursor' }));
  return ok({ limit, cursor });
}

const clip = (text: string, max: number): string => [...text].slice(0, max).join('');
const nameOf = (data: JsonObject | undefined): string | undefined => (typeof data?.name === 'string' && data.name !== '' ? clip(data.name, MAX_NAME) : undefined);

/** Data over the cap is shortened (long text cut, then everything dropped if it is still too big) and flagged. */
export function capData(data: JsonObject | undefined): { data: JsonObject; truncated: boolean } {
  const whole = data ?? {};
  if (JSON.stringify(whole).length <= MAX_DATA_CHARS) return { data: whole, truncated: false };
  const cut: JsonObject = {};
  for (const [key, value] of Object.entries(whole)) cut[key] = typeof value === 'string' ? clip(value, CUT_STRING) : value;
  return { data: JSON.stringify(cut).length <= MAX_DATA_CHARS ? cut : {}, truncated: true };
}

const itemView = (id: string, data: JsonObject | undefined): ItemView => {
  const capped = capData(data);
  return Object.freeze({ id, data: capped.data, ...(capped.truncated ? { dataTruncated: true as const } : {}) });
};

/** A graph store failure, as this controller reports it: a bad cursor is the caller's input; everything else keeps its source. */
function failed(error: GraphError): CaciError {
  if (error.code === 'VALIDATION_ERROR' && error.path?.join('.') === 'page.cursor') return caciError('INVALID_INPUT', 'cursor is not one this service gave for this request', { field: 'cursor' });
  return { source: 'graph', error };
}

/** An id that can be looked up: text, not empty. One too long to exist is simply not found. */
const checkId = (id: unknown): Result<string, CaciError> =>
  typeof id === 'string' && id !== '' ? ok(id) : err(caciError('INVALID_INPUT', 'id must be text', { field: 'id' }));

const base = { version: 1 } as const;

/** Counts, categories, a category's items and one item: all reads of the one graph given, through the public `query`. */
export function createBrowser(adapter: StorageAdapter) {
  const read = async (graphId: string, input: Record<string, unknown>): Promise<Result<unknown, CaciError>> => {
    const r = await query(adapter, { ...base, graphId, ...input });
    return r.ok ? ok(r.value) : err(failed(r.error));
  };

  async function exists(graphId: string, partition: 'item' | 'category', id: string): Promise<Result<boolean, CaciError>> {
    if (id.length > MAX_ID_CHARS) return ok(false);
    const r = await read(graphId, { from: { partition, ids: [id] }, traverse: { depth: 0 }, return: { shape: 'ids' } });
    if (!r.ok) return r;
    return ok((r.value as { ids: unknown[] }).ids.length > 0);
  }

  return {
    async summary(graphId: string): Promise<Result<GraphSummary, CaciError>> {
      const r = await describeGraph(adapter, graphId);
      return r.ok ? ok(Object.freeze({ itemCount: r.value.itemCount, categoryCount: r.value.categoryCount, edgeCount: r.value.edgeCount })) : err({ source: 'graph', error: r.error });
    },

    async categories(graphId: string, input: PageInput | undefined): Promise<Result<CategoryPage, CaciError>> {
      const page = pageOf(input);
      if (!page.ok) return page;
      const listed = await read(graphId, { from: { all: true }, filter: { partition: 'category' }, return: { shape: 'nodes', includeData: true }, page: page.value });
      if (!listed.ok) return listed;
      const { nodes, nextCursor } = listed.value as NodesOutput;
      const items: CategoryView[] = [];
      for (const node of nodes) {
        const counted = await read(graphId, { from: { partition: 'category', ids: [node.id] }, traverse: { depth: 1 }, filter: { partition: 'item' }, return: { shape: 'count' } });
        if (!counted.ok) return counted;
        const { count, truncated } = counted.value as CountOutput;
        const name = nameOf(node.data);
        items.push(Object.freeze({ id: node.id, ...(name === undefined ? {} : { name }), itemCount: count, ...(truncated ? { itemCountCapped: true as const } : {}) }));
      }
      return ok(Object.freeze({ items, nextCursor }));
    },

    async categoryItems(graphId: string, categoryId: unknown, input: PageInput | undefined): Promise<Result<CategoryItemsPage, CaciError>> {
      const id = checkId(categoryId);
      if (!id.ok) return id;
      const page = pageOf(input);
      if (!page.ok) return page;
      if (id.value.length > MAX_ID_CHARS) return err(caciError('NOT_FOUND', 'no such category')); // too long to exist
      const found = await read(graphId, { from: { partition: 'category', ids: [id.value] }, traverse: { depth: 0 }, return: { shape: 'nodes', includeData: true } });
      if (!found.ok) return found;
      const category = (found.value as NodesOutput).nodes.find((n) => n.partition === 'category' && n.id === id.value);
      if (category === undefined) return err(caciError('NOT_FOUND', 'no such category'));
      const listed = await read(graphId, { from: { partition: 'category', ids: [id.value] }, traverse: { depth: 1 }, filter: { partition: 'item' }, return: { shape: 'nodes', includeData: true }, page: page.value });
      if (!listed.ok) return listed;
      const { nodes, nextCursor } = listed.value as NodesOutput;
      const name = nameOf(category.data);
      return ok(Object.freeze({ category: Object.freeze({ id: category.id, ...(name === undefined ? {} : { name }) }), items: nodes.map((n) => itemView(n.id, n.data)), nextCursor }));
    },

    async item(graphId: string, itemId: unknown): Promise<Result<ItemDetail, CaciError>> {
      const id = checkId(itemId);
      if (!id.ok) return id;
      const there = await exists(graphId, 'item', id.value);
      if (!there.ok) return there;
      if (!there.value) return err(caciError('NOT_FOUND', 'no such item'));
      const r = await read(graphId, { from: { partition: 'item', ids: [id.value] }, traverse: { depth: 1 }, return: { shape: 'subgraph', includeData: true }, page: { limit: ITEM_CATEGORIES + 1, cursor: null } });
      if (!r.ok) return r;
      const out = r.value as SubgraphOutput;
      const item = out.nodes.find((n) => n.partition === 'item' && n.id === id.value);
      if (item === undefined) return err(caciError('NOT_FOUND', 'no such item'));
      const names = new Map(out.nodes.filter((n) => n.partition === 'category').map((n) => [n.id, nameOf(n.data)] as const));
      const mine = out.edges.filter((e) => e.item === id.value);
      const categories = mine
        .slice(0, ITEM_CATEGORIES)
        .map((e) => {
          const name = names.get(e.category);
          return Object.freeze({ id: e.category, ...(name === undefined ? {} : { name }), weight: e.weight });
        });
      return ok(Object.freeze({ item: itemView(item.id, item.data), categories, ...(mine.length > ITEM_CATEGORIES || out.nextCursor !== null || out.truncated ? { moreCategories: true as const } : {}) }));
    },
  };
}
