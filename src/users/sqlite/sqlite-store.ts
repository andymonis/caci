import { err, ok, type Result } from '../../graph_store/index.js';
import { DbError, openDb, type Db } from '../../sqlite/db.js';
import { checkLimit, decodeCursor, encodeCursor } from '../cursor.js';
import { usersError, type UsersError } from '../errors.js';
import type { Credential, CreateOptions, GuardOptions, UserList, UserPage, UserPatch, UserRecord, UserStore } from '../store.js';
import type { Role, User } from '../types.js';
import { prepareUsersDatabase } from './schema.js';

export interface SqliteUserStoreOptions {
  /** A file path (created owner-only if missing), or `:memory:` (the default). */
  readonly path?: string;
  /** How long to wait for another process's lock before failing. Default 5,000 ms. */
  readonly busyTimeoutMs?: number;
}

/** A user store backed by one SQLite database, which must be closed when you are done with it. */
export interface SqliteUserStore extends UserStore {
  close(): void;
}

interface Row {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: Role;
  password_hash: string;
  created_at: number;
  updated_at: number;
}

const COLUMNS = 'id, username, display_name, email, role, password_hash, created_at, updated_at';

const userOf = (row: Row): User => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  ...(row.email === null ? {} : { email: row.email }),
  role: row.role,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

/** A failure the caller can do nothing about, as a result: never the SQL, never a value. */
function failure(cause: unknown): UsersError {
  return usersError('STORAGE_ERROR', cause instanceof DbError ? cause.message : 'the user database could not complete the request');
}

/**
 * The SQLite user store. Every method does its work without awaiting, so calls never interleave in
 * this process, and anything that takes more than one statement runs in one `BEGIN IMMEDIATE`
 * transaction so other processes cannot interleave either. The rules that must hold under
 * concurrency (a unique username, the first admin, the last admin) are single statements or
 * checked inside that transaction.
 */
export function createSqliteUserStore(options: SqliteUserStoreOptions = {}): SqliteUserStore {
  const db = openDb(options);
  try {
    prepareUsersDatabase(db);
  } catch (cause) {
    db.close();
    throw cause;
  }

  function inTransaction<T>(body: (db: Db) => T): T {
    db.begin();
    try {
      const result = body(db);
      db.commit();
      return result;
    } catch (cause) {
      if (db.inTransaction) db.rollback();
      throw cause;
    }
  }
  const adminCount = (): number => Number(db.get<{ n: number }>("SELECT count(*) AS n FROM users WHERE role = 'admin'")?.n ?? 0);
  const rowById = (id: string): Row | undefined => db.get<Row>(`SELECT ${COLUMNS} FROM users WHERE id = ?`, id);
  const credential = (row: Row | undefined): Credential | undefined => (row === undefined ? undefined : { user: userOf(row), passwordHash: row.password_hash });

  return {
    create: async (record: UserRecord, createOptions: CreateOptions = {}): Promise<Result<User, UsersError>> => {
      try {
        // one statement: the role is decided by counting in the same statement that inserts
        db.run(
          `INSERT INTO users (${COLUMNS})
           SELECT ?, ?, ?, ?, CASE WHEN ? = 1 AND (SELECT count(*) FROM users) = 0 THEN 'admin' ELSE ? END, ?, ?, ?`,
          record.id,
          record.username.toLowerCase(),
          record.displayName,
          record.email ?? null,
          createOptions.adminIfFirst === true ? 1 : 0,
          record.role,
          record.passwordHash,
          record.createdAt,
          record.createdAt,
        );
        return ok(userOf(rowById(record.id) as Row));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '';
        if (/UNIQUE constraint failed: users\.username/.test(message)) return err(usersError('CONFLICT', 'that username is taken', { field: 'username' }));
        if (/UNIQUE constraint failed: users\.id/.test(message) || /PRIMARY KEY/.test(message)) return err(usersError('CONFLICT', 'that user id already exists', { field: 'id' }));
        return err(failure(cause));
      }
    },

    get: async (id) => {
      const row = rowById(id);
      return row === undefined ? undefined : userOf(row);
    },
    getByUsername: async (username) => {
      const row = db.get<Row>(`SELECT ${COLUMNS} FROM users WHERE username = ?`, username.toLowerCase());
      return row === undefined ? undefined : userOf(row);
    },
    credentialOf: async (id) => credential(rowById(id)),
    credentialByUsername: async (username) => credential(db.get<Row>(`SELECT ${COLUMNS} FROM users WHERE username = ?`, username.toLowerCase())),

    update: async (id: string, patch: UserPatch, guard: GuardOptions = {}): Promise<Result<User, UsersError>> => {
      try {
        return inTransaction(() => {
          const row = rowById(id);
          if (row === undefined) return err(usersError('NOT_FOUND', 'no such user'));
          if (guard.protectLastAdmin === true && row.role === 'admin' && patch.role === 'user' && adminCount() === 1) {
            return err(usersError('LAST_ADMIN', 'the last admin cannot be demoted'));
          }
          db.run(
            'UPDATE users SET display_name = ?, email = ?, role = ?, password_hash = ?, updated_at = ? WHERE id = ?',
            patch.displayName ?? row.display_name,
            patch.email === undefined ? row.email : patch.email,
            patch.role ?? row.role,
            patch.passwordHash ?? row.password_hash,
            patch.updatedAt,
            id,
          );
          return ok(userOf(rowById(id) as Row));
        });
      } catch (cause) {
        return err(failure(cause));
      }
    },

    delete: async (id: string, guard: GuardOptions = {}): Promise<Result<boolean, UsersError>> => {
      try {
        return inTransaction(() => {
          const row = rowById(id);
          if (row === undefined) return ok(false);
          if (guard.protectLastAdmin === true && row.role === 'admin' && adminCount() === 1) return err(usersError('LAST_ADMIN', 'the last admin cannot be deleted'));
          db.run('DELETE FROM users WHERE id = ?', id);
          return ok(true);
        });
      } catch (cause) {
        return err(failure(cause));
      }
    },

    list: async (page: UserPage): Promise<UserList> => {
      const limit = checkLimit(page.limit);
      const after = page.cursor === null ? undefined : decodeCursor(page.cursor);
      const rows =
        after === undefined
          ? db.all<Row>(`SELECT ${COLUMNS} FROM users ORDER BY username LIMIT ?`, limit + 1)
          : db.all<Row>(`SELECT ${COLUMNS} FROM users WHERE username > ? ORDER BY username LIMIT ?`, after, limit + 1);
      const shown = rows.slice(0, limit);
      const last = shown.at(-1);
      return { items: shown.map(userOf), nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.username) : null };
    },

    count: async () => Number(db.get<{ n: number }>('SELECT count(*) AS n FROM users')?.n ?? 0),

    close: () => db.close(),
  };
}
