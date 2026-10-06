import { openDb } from '../../sqlite/db.js';
import type { SessionOptions, SessionStore } from '../session-store.js';
import { resolveSessionOptions } from '../session-store.js';
import { hashToken, isWellFormedToken, newSessionToken } from '../tokens.js';
import { prepareUsersDatabase } from './schema.js';

export interface SqliteSessionStoreOptions extends SessionOptions {
  /** The user database's file (sessions live beside the users), or `:memory:` (the default). */
  readonly path?: string;
  /** How long to wait for another process's lock before failing. Default 5,000 ms. */
  readonly busyTimeoutMs?: number;
}

/** A session store in the user database, which must be closed when you are done with it. */
export interface SqliteSessionStore extends SessionStore {
  close(): void;
}

interface Row {
  user_id: string;
  created_at: number;
  last_used_at: number;
}

/**
 * Sessions in SQLite: only the SHA-256 of a token is written, so a copy of the file cannot be
 * replayed. Like the user store, each method runs without awaiting; the one that takes more than one
 * statement (`create`, which may end the oldest session) is one `BEGIN IMMEDIATE` transaction.
 */
export function createSqliteSessionStore(options: SqliteSessionStoreOptions = {}): SqliteSessionStore {
  const { path, busyTimeoutMs, ...sessionOptions } = options;
  const settings = resolveSessionOptions(sessionOptions);
  const db = openDb({ ...(path === undefined ? {} : { path }), ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }) });
  try {
    prepareUsersDatabase(db);
  } catch (cause) {
    db.close();
    throw cause;
  }

  return {
    create: async (userId, now) => {
      const token = newSessionToken(settings.randomBytes);
      db.begin();
      try {
        // keep at most maxPerUser: end the least recently used ones to make room for this one
        db.run(
          `DELETE FROM sessions WHERE token_hash IN (
             SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY last_used_at ASC, created_at ASC LIMIT max(0, (SELECT count(*) FROM sessions WHERE user_id = ?) - ? + 1))`,
          userId,
          userId,
          settings.maxPerUser,
        );
        db.run('INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)', hashToken(token), userId, now, now);
        db.commit();
      } catch (cause) {
        if (db.inTransaction) db.rollback();
        throw cause;
      }
      return token;
    },

    resolve: async (token, now) => {
      if (!isWellFormedToken(token)) return undefined;
      const hash = hashToken(token);
      const row = db.get<Row>('SELECT user_id, created_at, last_used_at FROM sessions WHERE token_hash = ?', hash);
      if (row === undefined) return undefined;
      if (now - Number(row.created_at) >= settings.absoluteMs || now - Number(row.last_used_at) >= settings.idleMs) {
        db.run('DELETE FROM sessions WHERE token_hash = ?', hash);
        return undefined;
      }
      if (now - Number(row.last_used_at) >= settings.renewEveryMs) db.run('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?', now, hash);
      return row.user_id;
    },

    revoke: async (token) => (isWellFormedToken(token) ? db.run('DELETE FROM sessions WHERE token_hash = ?', hashToken(token)) === 1 : false),

    revokeAllFor: async (userId, revokeOptions = {}) =>
      isWellFormedToken(revokeOptions.except)
        ? db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', userId, hashToken(revokeOptions.except))
        : db.run('DELETE FROM sessions WHERE user_id = ?', userId),

    purgeExpired: async (now) => db.run('DELETE FROM sessions WHERE ? - created_at >= ? OR ? - last_used_at >= ?', now, settings.absoluteMs, now, settings.idleMs),

    close: () => db.close(),
  };
}
