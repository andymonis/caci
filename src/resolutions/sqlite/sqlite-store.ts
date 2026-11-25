import { DbError, openDb } from '../../sqlite/db.js';
import { prepareUsersDatabase } from '../../users/sqlite/index.js';
import { resolutionError, type ResolutionError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type { ResolutionStore } from '../store.js';
import { MAX_RESOLUTIONS_PER_USER, type Resolution, type ResolutionScope, type ResolvedFact } from '../types.js';
import { checkFactIds, checkKey, checkPage, compareFacts, resolutionProblem } from '../validate.js';

export interface SqliteResolutionStoreOptions {
  /** The user database's file (the resolutions live beside the accounts), or `:memory:` (the default). */
  readonly path?: string;
  /** How long to wait for another process's lock before failing. Default 5,000 ms. */
  readonly busyTimeoutMs?: number;
}

/** A resolution store in the user database, which must be closed when you are done with it. */
export interface SqliteResolutionStore extends ResolutionStore {
  close(): void;
}

interface Row {
  user_id: string;
  scope_kind: 'personal' | 'circle';
  scope_id: string;
  fact_id: string;
  verb: string;
  at: number;
}

const toScope = (kind: Row['scope_kind'], id: string): ResolutionScope => Object.freeze(kind === 'personal' ? { kind: 'personal' as const } : { kind: 'circle' as const, circleId: id });
const toResolution = (r: Row): Resolution => Object.freeze({ userId: r.user_id, scope: toScope(r.scope_kind, r.scope_id), factId: r.fact_id, verb: r.verb, at: Number(r.at) });
const scopeId = (scope: ResolutionScope): string => (scope.kind === 'personal' ? '' : scope.circleId);

/** A failure the caller can do nothing about, as a result: never the SQL, never a value. */
function failure(cause: unknown): ResolutionError {
  return resolutionError('STORAGE_ERROR', cause instanceof DbError ? cause.message : 'the resolution store could not complete the request');
}

/**
 * The SQLite resolution store. Every method does its work without awaiting, so calls never interleave in this process, and a write
 * runs in one `BEGIN IMMEDIATE` transaction so other processes cannot interleave either. Ordering is done here, not in SQL: SQLite
 * orders text by UTF-8 bytes and the contract is plain UTF-16 code-unit order.
 */
export function createSqliteResolutionStore(options: SqliteResolutionStoreOptions = {}): SqliteResolutionStore {
  const db = openDb(options);
  try {
    prepareUsersDatabase(db);
  } catch (cause) {
    db.close();
    throw cause;
  }
  const mine = (userId: string): Resolution[] => db.all<Row>('SELECT * FROM fact_resolutions WHERE user_id = ?', userId).map(toResolution).sort(compareFacts);

  return {
    set: async (resolution): Promise<Result<void, ResolutionError>> => {
      const problem = resolutionProblem(resolution);
      if (problem !== undefined) return err(resolutionError('INVALID_INPUT', problem));
      try {
        db.begin();
        try {
          const exists = db.get<{ n: number }>('SELECT count(*) AS n FROM fact_resolutions WHERE user_id = ? AND scope_kind = ? AND scope_id = ? AND fact_id = ?', resolution.userId, resolution.scope.kind, scopeId(resolution.scope), resolution.factId)?.n;
          if (!exists) {
            const held = db.get<{ n: number }>('SELECT count(*) AS n FROM fact_resolutions WHERE user_id = ?', resolution.userId)?.n ?? 0;
            if (held >= MAX_RESOLUTIONS_PER_USER) {
              db.rollback();
              return err(resolutionError('LIMIT_REACHED', `a person may hold at most ${MAX_RESOLUTIONS_PER_USER} resolutions`));
            }
          }
          db.run(
            'INSERT INTO fact_resolutions (user_id, scope_kind, scope_id, fact_id, verb, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, scope_kind, scope_id, fact_id) DO UPDATE SET verb = excluded.verb, at = excluded.at',
            resolution.userId, resolution.scope.kind, scopeId(resolution.scope), resolution.factId, resolution.verb, resolution.at,
          );
          db.commit();
        } catch (cause) {
          if (db.inTransaction) db.rollback();
          throw cause;
        }
        return ok(undefined);
      } catch (cause) {
        return err(failure(cause));
      }
    },

    get: async (userId, scope, factId) => {
      checkKey(userId, scope, factId);
      const row = db.get<Row>('SELECT * FROM fact_resolutions WHERE user_id = ? AND scope_kind = ? AND scope_id = ? AND fact_id = ?', userId, scope.kind, scopeId(scope), factId);
      return row === undefined ? undefined : toResolution(row);
    },

    remove: async (userId, scope, factId) => {
      checkKey(userId, scope, factId);
      return db.run('DELETE FROM fact_resolutions WHERE user_id = ? AND scope_kind = ? AND scope_id = ? AND fact_id = ?', userId, scope.kind, scopeId(scope), factId) > 0;
    },

    listFor: async (userId, scope, factIds) => {
      checkKey(userId, scope, 'x');
      checkFactIds(factIds);
      const wanted = new Set(factIds);
      return mine(userId).filter((r) => r.scope.kind === scope.kind && scopeId(r.scope) === scopeId(scope) && wanted.has(r.factId));
    },

    list: async (userId, page) => {
      checkPage(page);
      const all = mine(userId).filter((r) => page.after === undefined || compareFacts(r, page.after) > 0);
      return { items: all.slice(0, page.limit), hasMore: all.length > page.limit };
    },

    count: async (userId) => db.get<{ n: number }>('SELECT count(*) AS n FROM fact_resolutions WHERE user_id = ?', userId)?.n ?? 0,

    removeForUser: async (userId) => db.run('DELETE FROM fact_resolutions WHERE user_id = ?', userId),

    removeForCircle: async (circleId) => db.run("DELETE FROM fact_resolutions WHERE scope_kind = 'circle' AND scope_id = ?", circleId),

    removeFact: async (scope, factId) => db.run('DELETE FROM fact_resolutions WHERE scope_kind = ? AND scope_id = ? AND fact_id = ?', scope.kind, scopeId(scope), factId),

    facts: async (page) => {
      checkPage(page);
      const rows = db.all<Pick<Row, 'scope_kind' | 'scope_id' | 'fact_id'>>('SELECT DISTINCT scope_kind, scope_id, fact_id FROM fact_resolutions');
      const all: ResolvedFact[] = rows.map((r) => Object.freeze({ scope: toScope(r.scope_kind, r.scope_id), factId: r.fact_id })).sort(compareFacts).filter((f) => page.after === undefined || compareFacts(f, page.after) > 0);
      return { items: all.slice(0, page.limit), hasMore: all.length > page.limit };
    },

    close: () => db.close(),
  };
}
