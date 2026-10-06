import type { AdapterTx, EdgeKey, EdgeRecord, JsonObject, NodeRecord, Page, Paged, Partition } from '../../adapter.js';
import type { Db } from '../../../sqlite/db.js';
import { decodeCursor, encodeCursor, fromKey, toKey } from './keys.js';

/** Ids per `IN (...)` list: far under SQLite's limit of 32,766 variables per statement. */
const IN_BATCH = 500;

function checkLimit(page: Page): number {
  if (!Number.isInteger(page.limit) || page.limit < 1) throw new RangeError(`Page limit must be a positive integer, got ${page.limit}`);
  return page.limit;
}

/** The key a cursor stands for, `undefined` for the first page. A cursor this adapter never gave out is refused. */
function after(page: Page): Uint8Array | undefined {
  if (page.cursor === null) return undefined;
  const key = decodeCursor(page.cursor);
  if (key === undefined) throw new RangeError('Invalid page cursor');
  return key;
}

const idOf = (key: Uint8Array): string => {
  const id = fromKey(key);
  if (id === undefined) throw new Error('The database holds a malformed key');
  return id;
};

const parseData = (text: string | null): JsonObject | undefined => (text === null ? undefined : (JSON.parse(text) as JsonObject));
const stringifyData = (data: JsonObject | undefined): string | null => (data === undefined ? null : JSON.stringify(data));

const chunks = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_BATCH) out.push(items.slice(i, i + IN_BATCH));
  return out;
};

/** A page of at most `limit` rows from a query that was asked for `limit + 1`, and the cursor if a row was left over. */
function paged<R, T>(rows: readonly R[], limit: number, keyOf: (row: R) => Uint8Array, convert: (row: R) => T): Paged<T> {
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return { items: shown.map(convert), nextCursor: rows.length > limit && last !== undefined ? encodeCursor(keyOf(last)) : null };
}

interface NodeRow {
  id_key: Uint8Array;
  data: string | null;
}
interface EdgeRow {
  item_key: Uint8Array;
  category_key: Uint8Array;
  weight: number | null;
  data: string | null;
}

const nodeOf = (partition: Partition, row: NodeRow): NodeRecord => {
  const data = parseData(row.data);
  return data === undefined ? { partition, id: idOf(row.id_key) } : { partition, id: idOf(row.id_key), data };
};
const edgeOf = (row: EdgeRow): EdgeRecord => {
  const data = parseData(row.data);
  return {
    item: idOf(row.item_key),
    category: idOf(row.category_key),
    ...(row.weight === null ? {} : { weight: row.weight }),
    ...(data === undefined ? {} : { data }),
  };
};

/**
 * The primitives for one graph, over the connection that holds the open transaction. Everything
 * is synchronous underneath; the `async` is only the contract. Like the memory adapter these are
 * raw: no endpoint checks and no cascade (the core does both). Data goes in and out as JSON text,
 * so callers never share objects with the database.
 */
export function makeSqliteTx(db: Db, graphId: string, isOpen: () => boolean): AdapterTx {
  const live = <T>(body: () => T): T => {
    if (!isOpen()) throw new Error('Transaction is closed');
    return body();
  };

  return {
    getNodes: async (p, ids) =>
      live(() => {
        const found = new Map<string, NodeRecord>();
        for (const batch of chunks([...new Set(ids)])) {
          const marks = batch.map(() => '?').join(', ');
          const rows = db.all<NodeRow>(`SELECT id_key, data FROM nodes WHERE graph_id = ? AND partition = ? AND id_key IN (${marks})`, graphId, p, ...batch.map(toKey));
          for (const row of rows) {
            const node = nodeOf(p, row);
            found.set(node.id, node);
          }
        }
        // in the order asked, one record per id asked (a repeated id repeats its record), each a fresh copy
        return ids.flatMap((id) => {
          const node = found.get(id);
          return node === undefined ? [] : [structuredClone(node)];
        });
      }),

    putNodes: async (nodes) =>
      live(() => {
        for (const node of nodes) {
          db.run(
            'INSERT INTO nodes (graph_id, partition, id_key, data) VALUES (?, ?, ?, ?) ON CONFLICT (graph_id, partition, id_key) DO UPDATE SET data = excluded.data',
            graphId,
            node.partition,
            toKey(node.id),
            stringifyData(node.data),
          );
        }
      }),

    deleteNodes: async (p, ids) =>
      live(() => {
        for (const id of ids) db.run('DELETE FROM nodes WHERE graph_id = ? AND partition = ? AND id_key = ?', graphId, p, toKey(id));
      }),

    listNodes: async (p, page) =>
      live(() => {
        const limit = checkLimit(page);
        const from = after(page);
        const rows =
          from === undefined
            ? db.all<NodeRow>('SELECT id_key, data FROM nodes WHERE graph_id = ? AND partition = ? ORDER BY id_key LIMIT ?', graphId, p, limit + 1)
            : db.all<NodeRow>('SELECT id_key, data FROM nodes WHERE graph_id = ? AND partition = ? AND id_key > ? ORDER BY id_key LIMIT ?', graphId, p, from, limit + 1);
        return paged(rows, limit, (r) => r.id_key, (r) => nodeOf(p, r));
      }),

    putEdges: async (edges: EdgeRecord[]) =>
      live(() => {
        for (const edge of edges) {
          db.run(
            'INSERT OR REPLACE INTO edges (graph_id, item_key, category_key, weight, data) VALUES (?, ?, ?, ?, ?)',
            graphId,
            toKey(edge.item),
            toKey(edge.category),
            edge.weight ?? null,
            stringifyData(edge.data),
          );
        }
      }),

    deleteEdges: async (keys: EdgeKey[]) =>
      live(() => {
        for (const { item, category } of keys) db.run('DELETE FROM edges WHERE graph_id = ? AND item_key = ? AND category_key = ?', graphId, toKey(item), toKey(category));
      }),

    edgesOf: async (p, id, page) =>
      live(() => {
        const limit = checkLimit(page);
        const from = after(page);
        // an item's edges are in the table's own order; a category's come from the reverse index; both by the other end's key
        const [own, other] = p === 'item' ? (['item_key', 'category_key'] as const) : (['category_key', 'item_key'] as const);
        const select = `SELECT item_key, category_key, weight, data FROM edges WHERE graph_id = ? AND ${own} = ?`;
        const rows =
          from === undefined
            ? db.all<EdgeRow>(`${select} ORDER BY ${other} LIMIT ?`, graphId, toKey(id), limit + 1)
            : db.all<EdgeRow>(`${select} AND ${other} > ? ORDER BY ${other} LIMIT ?`, graphId, toKey(id), from, limit + 1);
        return paged(rows, limit, (r) => (p === 'item' ? r.category_key : r.item_key), edgeOf);
      }),
  };
}
