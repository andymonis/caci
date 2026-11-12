import { DbError, openDb } from '../../sqlite/db.js';
import { prepareUsersDatabase } from '../../users/sqlite/index.js';
import { usageError, type UsageError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type { UsageStore } from '../store.js';
import type { UsageAggregate, UsageCapability } from '../types.js';
import { checkRange, compareAggregates, recordProblem } from '../validate.js';

export interface SqliteUsageStoreOptions {
  /** The user database's file (the usage records live beside the accounts), or `:memory:` (the default). */
  readonly path?: string;
  /** How long to wait for another process's lock before failing. Default 5,000 ms. */
  readonly busyTimeoutMs?: number;
}

/** A usage store in the user database, which must be closed when you are done with it. */
export interface SqliteUsageStore extends UsageStore {
  close(): void;
}

interface AggregateRow {
  day: string;
  user_id: string | null;
  capability: UsageCapability;
  scope_kind: 'personal' | 'circle';
  scope_id: string;
  model: string;
  calls: number;
  attempts: number;
  rejected: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  latency_ms: number;
}

/** A failure the caller can do nothing about, as a result: never the SQL, never a value. */
function failure(cause: unknown): UsageError {
  return usageError('STORAGE_ERROR', cause instanceof DbError ? cause.message : 'the usage store could not complete the request');
}

/**
 * The SQLite usage store. Every method does its work without awaiting, so calls never interleave in this process, and a batch
 * runs in one `BEGIN IMMEDIATE` transaction so other processes cannot interleave either: it is all or nothing.
 */
export function createSqliteUsageStore(options: SqliteUsageStoreOptions = {}): SqliteUsageStore {
  const db = openDb(options);
  try {
    prepareUsersDatabase(db);
  } catch (cause) {
    db.close();
    throw cause;
  }

  return {
    append: async (records): Promise<Result<void, UsageError>> => {
      for (const [i, record] of records.entries()) {
        const problem = recordProblem(record);
        if (problem !== undefined) return err(usageError('INVALID_INPUT', `record ${i}: ${problem}`));
      }
      try {
        db.begin();
        try {
          for (const r of records) {
            db.run(
              'INSERT INTO usage (at, user_id, capability, scope_kind, scope_id, model, attempt, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, result, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              r.at, r.userId, r.capability, r.scope.kind, r.scope.kind === 'personal' ? '' : r.scope.circleId, r.model, r.attempt, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, r.result, r.latencyMs,
            );
          }
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

    aggregate: async (range) => {
      checkRange(range);
      const rows = db.all<AggregateRow>(
        `SELECT date(at / 1000, 'unixepoch') AS day, user_id, capability, scope_kind, scope_id, model,
                SUM(attempt = 1) AS calls, COUNT(*) AS attempts, SUM(result = 'rejected') AS rejected,
                SUM(result NOT IN ('ok', 'rejected')) AS failed, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_creation_tokens) AS cache_creation_tokens, SUM(latency_ms) AS latency_ms
           FROM usage WHERE at >= ? AND at < ?
          GROUP BY day, user_id, capability, scope_kind, scope_id, model`,
        range.from,
        range.to,
      );
      // Sorted here, not in SQL: SQLite orders text by UTF-8 bytes and the contract is plain code-unit order.
      return rows
        .map((r): UsageAggregate => Object.freeze({
          day: r.day,
          userId: r.user_id,
          capability: r.capability,
          scope: Object.freeze(r.scope_kind === 'personal' ? { kind: 'personal' as const } : { kind: 'circle' as const, circleId: r.scope_id }),
          model: r.model,
          calls: Number(r.calls),
          attempts: Number(r.attempts),
          rejected: Number(r.rejected),
          failed: Number(r.failed),
          inputTokens: Number(r.input_tokens),
          outputTokens: Number(r.output_tokens),
          cacheReadTokens: Number(r.cache_read_tokens),
          cacheCreationTokens: Number(r.cache_creation_tokens),
          latencyMs: Number(r.latency_ms),
        }))
        .sort(compareAggregates);
    },

    clearUser: async (userId) => db.run('UPDATE usage SET user_id = NULL WHERE user_id = ?', userId),

    purgeBefore: async (time) => db.run('DELETE FROM usage WHERE at < ?', time),

    close: () => db.close(),
  };
}
