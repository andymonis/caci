import { DbError, openDb } from '../../sqlite/db.js';
import { prepareUsersDatabase } from '../../users/sqlite/index.js';
import { checkLimit, decodeCursor, encodeCursor } from '../cursor.js';
import { ledgerError, type LedgerError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type { LedgerStore } from '../store.js';
import type { LedgerAction, LedgerEntry, LedgerKind, LedgerScope } from '../types.js';
import { entryProblem } from '../validate.js';

export interface SqliteLedgerStoreOptions {
  /** The user database's file (the log lives beside the accounts), or `:memory:` (the default). */
  readonly path?: string;
  /** How long to wait for another process's lock before failing. Default 5,000 ms. */
  readonly busyTimeoutMs?: number;
}

/** A ledger store in the user database, which must be closed when you are done with it. */
export interface SqliteLedgerStore extends LedgerStore {
  close(): void;
}

interface Row {
  id: string;
  at: number;
  scope_kind: 'personal' | 'circle';
  scope_id: string;
  actor: string;
  action: LedgerAction;
  kind: LedgerKind;
  subject: string;
  title: string | null;
  summary: string | null;
  proposal_id: string;
}

const COLUMNS = 'id, at, scope_kind, scope_id, actor, action, kind, subject, title, summary, proposal_id';
const scopeOf = (row: Row): LedgerScope => (row.scope_kind === 'personal' ? { kind: 'personal', userId: row.scope_id } : { kind: 'circle', circleId: row.scope_id });
const entryOf = (row: Row): LedgerEntry => ({
  id: row.id,
  at: Number(row.at),
  scope: scopeOf(row),
  actor: row.actor,
  action: row.action,
  kind: row.kind,
  subject: JSON.parse(row.subject) as string,
  ...(row.title === null ? {} : { title: JSON.parse(row.title) as string }),
  ...(row.summary === null ? {} : { summary: JSON.parse(row.summary) as string }),
  proposalId: row.proposal_id,
});
const scopeColumns = (scope: LedgerScope): [string, string] => (scope.kind === 'personal' ? ['personal', scope.userId] : ['circle', scope.circleId]);

/** A failure the caller can do nothing about, as a result: never the SQL, never a value. */
function failure(cause: unknown): LedgerError {
  return ledgerError('STORAGE_ERROR', cause instanceof DbError ? cause.message : 'the change log could not complete the request');
}

/**
 * The SQLite ledger store. Every method does its work without awaiting, so calls never interleave in this process, and a batch
 * runs in one `BEGIN IMMEDIATE` transaction so other processes cannot interleave either: it is all or nothing.
 */
export function createSqliteLedgerStore(options: SqliteLedgerStoreOptions = {}): SqliteLedgerStore {
  const db = openDb(options);
  try {
    prepareUsersDatabase(db);
  } catch (cause) {
    db.close();
    throw cause;
  }

  return {
    append: async (entries): Promise<Result<void, LedgerError>> => {
      const seen = new Set<string>();
      for (const entry of entries) {
        const problem = entryProblem(entry);
        if (problem !== undefined) return err(ledgerError('INVALID_INPUT', problem));
        if (seen.has(entry.id)) return err(ledgerError('INVALID_INPUT', 'an entry id is already used'));
        seen.add(entry.id);
      }
      if (entries.length === 0) return ok(undefined);
      try {
        db.begin();
        try {
          for (const entry of entries) {
            if (db.get('SELECT 1 AS x FROM ledger WHERE id = ?', entry.id) !== undefined) {
              db.rollback();
              return err(ledgerError('INVALID_INPUT', 'an entry id is already used'));
            }
            const [kind, id] = scopeColumns(entry.scope);
            db.run(
              `INSERT INTO ledger (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              entry.id, entry.at, kind, id, entry.actor, entry.action, entry.kind, JSON.stringify(entry.subject),
              entry.title === undefined ? null : JSON.stringify(entry.title), entry.summary === undefined ? null : JSON.stringify(entry.summary), entry.proposalId,
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

    list: async (scope, page) => {
      const limit = checkLimit(page.limit);
      const after = page.cursor === null ? undefined : decodeCursor(scope, page.cursor);
      const [kind, id] = scopeColumns(scope);
      const rows = after === undefined
        ? db.all<Row>(`SELECT ${COLUMNS} FROM ledger WHERE scope_kind = ? AND scope_id = ? ORDER BY at DESC, id DESC LIMIT ?`, kind, id, limit + 1)
        : db.all<Row>(`SELECT ${COLUMNS} FROM ledger WHERE scope_kind = ? AND scope_id = ? AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?`, kind, id, after.at, after.at, after.id, limit + 1);
      const shown = rows.slice(0, limit);
      const last = shown.at(-1);
      return { items: shown.map(entryOf), nextCursor: rows.length > limit && last !== undefined ? encodeCursor(scope, Number(last.at), last.id) : null };
    },

    purgeBefore: async (time) => db.run('DELETE FROM ledger WHERE at < ?', time),

    removeScope: async (scope) => {
      const [kind, id] = scopeColumns(scope);
      return db.run('DELETE FROM ledger WHERE scope_kind = ? AND scope_id = ?', kind, id);
    },

    close: () => db.close(),
  };
}
