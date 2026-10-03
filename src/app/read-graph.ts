import { query, type GraphError, type GraphOptions, type Query, type QueryOutput, type Result, type StorageAdapter, ok, err } from '../graph_store/index.js';
import type { CategoryEntry } from '../llm/index.js';
import type { ExistingNodes } from './summary.js';

/** Reads only: everything here goes through `query()`. */

const CATEGORY_PAGE = 200;
const ID_PAGE = 1000;

export interface CategoriesRead {
  readonly categories: readonly CategoryEntry[];
  /** True when there were more categories than `max`, so the model sees only some. (A whole-graph listing is paged, never cut by the store's own size cap.) */
  readonly capped: boolean;
}

/** The graph's categories with their data, by id, up to `max`. */
export async function readCategories(adapter: StorageAdapter, graphId: string, max: number, options?: GraphOptions): Promise<Result<CategoriesRead, GraphError>> {
  const categories: CategoryEntry[] = [];
  let cursor: string | null = null;
  let capped = false;
  do {
    const q: Query = {
      version: 1,
      graphId,
      from: { all: true },
      traverse: { depth: 0 },
      filter: { partition: 'category' },
      return: { shape: 'nodes', includeData: true },
      page: { limit: Math.min(CATEGORY_PAGE, max + 1), cursor },
    };
    const r = await query(adapter, q, options);
    if (!r.ok) return r;
    const out: QueryOutput = r.value;
    if (!('nodes' in out)) return err({ code: 'STORAGE_ERROR', message: 'a categories listing did not return nodes' });
    for (const node of out.nodes) {
      if (categories.length >= max) {
        capped = true;
        break;
      }
      categories.push(node.data === undefined ? { id: node.id } : { id: node.id, data: node.data });
    }
    cursor = capped ? null : out.nextCursor;
  } while (cursor !== null);
  return ok({ categories, capped });
}

/** Which of these item and category ids are already in the graph. */
export async function readExisting(adapter: StorageAdapter, graphId: string, wanted: { items: readonly string[]; categories: readonly string[] }, options?: GraphOptions): Promise<Result<ExistingNodes, GraphError>> {
  const found = { item: [] as string[], category: [] as string[] };
  for (const partition of ['item', 'category'] as const) {
    const ids = [...(partition === 'item' ? wanted.items : wanted.categories)]; // the query planner de-duplicates seeds
    if (ids.length === 0) continue;
    let cursor: string | null = null;
    do {
      const q: Query = {
        version: 1,
        graphId,
        from: { partition, ids },
        traverse: { depth: 0 },
        return: { shape: 'ids' },
        page: { limit: ID_PAGE, cursor },
      };
      const r = await query(adapter, q, options);
      if (!r.ok) return r;
      const out: QueryOutput = r.value;
      if (!('ids' in out)) return err({ code: 'STORAGE_ERROR', message: 'an ids listing did not return ids' });
      found[partition].push(...out.ids.map((ref) => ref.id));
      cursor = out.nextCursor;
    } while (cursor !== null);
  }
  return ok({ items: found.item, categories: found.category });
}
