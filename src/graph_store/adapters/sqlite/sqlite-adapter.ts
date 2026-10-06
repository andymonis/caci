import type { GraphId, Page, Paged, StorageAdapter } from '../../adapter.js';
import { DbError, openDb } from '../../../sqlite/db.js';
import { decodeCursor, encodeCursor, fromKey, toKey } from './keys.js';
import { prepareDatabase } from './schema.js';
import { makeSqliteTx } from './tx.js';

export interface SqliteAdapterOptions {
  /** A file path (created if missing), or `:memory:` (the default) for a database that lives only as long as the adapter. */
  readonly path?: string;
  /** How long to wait for another process's lock before failing. Default 5,000 ms. */
  readonly busyTimeoutMs?: number;
}

/** A storage adapter backed by one SQLite database, which must be closed when you are done with it. */
export interface SqliteAdapter extends StorageAdapter {
  /** Waits for work already started, then closes the database. Idempotent; later calls on the adapter fail with `DbError` `CLOSED`. */
  close(): Promise<void>;
}

/**
 * SQLite adapter (driver: the built-in `node:sqlite`). One connection serves everything, and every
 * operation (a transaction, but also `graphs.*`) goes through one queue, because the driver is
 * synchronous while a transaction callback is not: two interleaved transactions on one connection
 * would share a single SQL transaction. A transaction callback must therefore not call `graphs.*`
 * on the same adapter (it would wait for itself). Graph ids are the core's restricted ASCII, so
 * the database's plain text order is the contract's order for them.
 */
export function createSqliteAdapter(options: SqliteAdapterOptions = {}): SqliteAdapter {
  const db = openDb(options);
  try {
    prepareDatabase(db);
  } catch (cause) {
    db.close();
    throw cause;
  }

  let tail: Promise<unknown> = Promise.resolve();
  /** Runs `body` after everything queued before it has finished, whether that succeeded or not. */
  const serialise = <T>(body: () => Promise<T> | T): Promise<T> => {
    const run = tail.then(body, body);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  let closing: Promise<void> | undefined;
  /** Refuses new work once `close()` has been called, at the time of the call; work already queued still runs. */
  const accepting = <T>(body: () => Promise<T> | T): Promise<T> =>
    closing === undefined ? serialise(body) : Promise.reject(new DbError('CLOSED', 'the database is closed'));

  return {
    name: 'sqlite',
    capabilities: { transactions: true, idempotency: false, nativeSetQueries: false },

    transaction: (graphId, fn) =>
      accepting(async () => {
        db.begin(); // takes the write lock now
        let open = true;
        try {
          if (db.get('SELECT 1 AS x FROM graphs WHERE graph_id = ?', graphId) === undefined) throw new Error(`Graph not found: ${graphId}`);
          let result;
          try {
            result = await fn(makeSqliteTx(db, graphId, () => open));
          } finally {
            open = false;
          }
          db.commit();
          return result;
        } catch (cause) {
          if (db.inTransaction) db.rollback();
          throw cause;
        }
      }),

    graphs: {
      /** Atomic: the insert itself says whether this call created the row. */
      create: (id) => accepting(() => db.run('INSERT OR IGNORE INTO graphs (graph_id) VALUES (?)', id) === 1),
      exists: (id) => accepting(() => db.get('SELECT 1 AS x FROM graphs WHERE graph_id = ?', id) !== undefined),
      list: (page) => accepting(() => listGraphs(page)),
      /** Idempotent. The foreign keys remove the graph's nodes and edges with it. */
      drop: (id) =>
        accepting(() => {
          db.run('DELETE FROM graphs WHERE graph_id = ?', id);
        }),
    },

    close: () => {
      closing ??= serialise(() => db.close());
      return closing;
    },
  };

  function listGraphs(page: Page): Paged<GraphId> {
    if (!Number.isInteger(page.limit) || page.limit < 1) throw new RangeError(`Page limit must be a positive integer, got ${page.limit}`);
    let from: string | undefined;
    if (page.cursor !== null) {
      const key = decodeCursor(page.cursor);
      from = key === undefined ? undefined : fromKey(key);
      if (from === undefined) throw new RangeError('Invalid page cursor');
    }
    const rows =
      from === undefined
        ? db.all<{ graph_id: string }>('SELECT graph_id FROM graphs ORDER BY graph_id LIMIT ?', page.limit + 1)
        : db.all<{ graph_id: string }>('SELECT graph_id FROM graphs WHERE graph_id > ? ORDER BY graph_id LIMIT ?', from, page.limit + 1);
    const shown = rows.slice(0, page.limit).map((r) => r.graph_id);
    const last = shown.at(-1);
    return { items: shown, nextCursor: rows.length > page.limit && last !== undefined ? encodeCursor(toKey(last)) : null };
  }
}
