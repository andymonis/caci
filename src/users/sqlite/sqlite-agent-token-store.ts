import { err, ok } from '../../graph_store/index.js';
import { openDb } from '../../sqlite/db.js';
import { AGENT_TOKEN_RENEW_MS, checkAgentTokenInput, hashAgentToken, isAgentTokenId, isWellFormedAgentToken, MAX_AGENT_TOKENS_PER_USER, newAgentToken, newAgentTokenId, tooManyAgentTokens, type AgentTokenInfo, type AgentTokenOptions, type AgentTokenStore } from '../agent-tokens.js';
import { prepareUsersDatabase } from './schema.js';

export interface SqliteAgentTokenStoreOptions extends AgentTokenOptions {
  /** The user database's file (tokens live beside the users), or `:memory:` (the default). */
  readonly path?: string;
  /** How long to wait for another process's lock before failing. Default 5,000 ms. */
  readonly busyTimeoutMs?: number;
}

/** An agent token store in the user database, which must be closed when you are done with it. */
export interface SqliteAgentTokenStore extends AgentTokenStore {
  close(): void;
}

interface Row {
  id: string;
  user_id: string;
  name: string;
  scopes: string;
  checks: number;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
}

const info = (row: Row): AgentTokenInfo =>
  Object.freeze({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    scopes: Object.freeze(JSON.parse(row.scopes) as string[]),
    checks: Number(row.checks) === 1,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
  });

/**
 * Agent tokens in SQLite: only the SHA-256 of a token is written, so a copy of the file cannot be replayed. Like the other stores
 * each method runs without awaiting; `create`, which counts then inserts, is one `BEGIN IMMEDIATE` transaction, so two processes
 * cannot both take the last place.
 */
export function createSqliteAgentTokenStore(options: SqliteAgentTokenStoreOptions = {}): SqliteAgentTokenStore {
  const { path, busyTimeoutMs, ...tokenOptions } = options;
  const db = openDb({ ...(path === undefined ? {} : { path }), ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }) });
  try {
    prepareUsersDatabase(db);
  } catch (cause) {
    db.close();
    throw cause;
  }
  const COLUMNS = 'id, user_id, name, scopes, checks, created_at, expires_at, last_used_at';

  return {
    create: async (input, now) => {
      const checked = checkAgentTokenInput(input, now);
      if (!checked.ok) return checked;
      const v = checked.value;
      const token = newAgentToken(tokenOptions.randomBytes);
      const id = newAgentTokenId(tokenOptions.randomBytes);
      db.begin();
      try {
        db.run('DELETE FROM agent_tokens WHERE expires_at <= ?', now);
        const mine = db.get<{ n: number }>('SELECT count(*) AS n FROM agent_tokens WHERE user_id = ?', v.userId);
        if (Number(mine?.n ?? 0) >= MAX_AGENT_TOKENS_PER_USER) {
          db.commit();
          return err(tooManyAgentTokens());
        }
        db.run('INSERT INTO agent_tokens (token_hash, id, user_id, name, scopes, checks, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)', hashAgentToken(token), id, v.userId, v.name, JSON.stringify(v.scopes), v.checks ? 1 : 0, now, v.expiresAt);
        db.commit();
      } catch (cause) {
        if (db.inTransaction) db.rollback();
        throw cause;
      }
      return ok({ token, info: info({ id, user_id: v.userId, name: v.name, scopes: JSON.stringify(v.scopes), checks: v.checks ? 1 : 0, created_at: now, expires_at: v.expiresAt, last_used_at: null }) });
    },

    resolve: async (token, now) => {
      if (!isWellFormedAgentToken(token)) return undefined;
      const hash = hashAgentToken(token);
      const row = db.get<Row>(`SELECT ${COLUMNS} FROM agent_tokens WHERE token_hash = ?`, hash);
      if (row === undefined) return undefined;
      if (Number(row.expires_at) <= now) {
        db.run('DELETE FROM agent_tokens WHERE token_hash = ?', hash);
        return undefined;
      }
      if (row.last_used_at === null || now - Number(row.last_used_at) >= AGENT_TOKEN_RENEW_MS) db.run('UPDATE agent_tokens SET last_used_at = ? WHERE token_hash = ?', now, hash);
      return Object.freeze({ tokenId: row.id, userId: row.user_id, scopes: Object.freeze(JSON.parse(row.scopes) as string[]), checks: Number(row.checks) === 1 });
    },

    list: async (userId, now) => Object.freeze(db.all<Row>(`SELECT ${COLUMNS} FROM agent_tokens WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC, id DESC`, userId, now).map(info)),

    revoke: async (userId, id) => (isAgentTokenId(id) ? db.run('DELETE FROM agent_tokens WHERE user_id = ? AND id = ?', userId, id) === 1 : false),

    revokeAllFor: async (userId) => db.run('DELETE FROM agent_tokens WHERE user_id = ?', userId),

    purgeExpired: async (now) => db.run('DELETE FROM agent_tokens WHERE expires_at <= ?', now),

    close: () => db.close(),
  };
}
