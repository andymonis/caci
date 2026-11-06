import { err, ok } from '../graph_store/index.js';
import { AGENT_TOKEN_RENEW_MS, checkAgentTokenInput, hashAgentToken, isAgentTokenId, isWellFormedAgentToken, MAX_AGENT_TOKENS_PER_USER, newAgentToken, newAgentTokenId, tooManyAgentTokens, type AgentTokenInfo, type AgentTokenOptions, type AgentTokenStore } from './agent-tokens.js';

interface Row {
  info: AgentTokenInfo;
  lastUsedAt: number | null;
}

/** The reference agent token store, in memory. Each method runs without awaiting, so none interleaves with another. */
export function createMemoryAgentTokenStore(options: AgentTokenOptions = {}): AgentTokenStore {
  const rows = new Map<string, Row>(); // by token hash
  const copy = (row: Row): AgentTokenInfo => Object.freeze({ ...row.info, scopes: Object.freeze([...row.info.scopes]), lastUsedAt: row.lastUsedAt });
  const live = (row: Row, now: number): boolean => row.info.expiresAt > now;

  return {
    create: async (input, now) => {
      const checked = checkAgentTokenInput(input, now);
      if (!checked.ok) return checked;
      let mine = 0;
      for (const [hash, row] of [...rows]) {
        if (!live(row, now)) rows.delete(hash);
        else if (row.info.userId === input.userId) mine++;
      }
      if (mine >= MAX_AGENT_TOKENS_PER_USER) return err(tooManyAgentTokens());
      const token = newAgentToken(options.randomBytes);
      let id = newAgentTokenId(options.randomBytes);
      while ([...rows.values()].some((r) => r.info.id === id)) id = newAgentTokenId(options.randomBytes);
      const v = checked.value;
      const info: AgentTokenInfo = { id, userId: v.userId, name: v.name, scopes: v.scopes, checks: v.checks, createdAt: now, expiresAt: v.expiresAt, lastUsedAt: null };
      const row: Row = { info, lastUsedAt: null };
      rows.set(hashAgentToken(token), row);
      return ok({ token, info: copy(row) });
    },

    resolve: async (token, now) => {
      if (!isWellFormedAgentToken(token)) return undefined;
      const hash = hashAgentToken(token);
      const row = rows.get(hash);
      if (row === undefined) return undefined;
      if (!live(row, now)) {
        rows.delete(hash);
        return undefined;
      }
      if (row.lastUsedAt === null || now - row.lastUsedAt >= AGENT_TOKEN_RENEW_MS) row.lastUsedAt = now;
      return Object.freeze({ tokenId: row.info.id, userId: row.info.userId, scopes: Object.freeze([...row.info.scopes]), checks: row.info.checks });
    },

    list: async (userId, now) =>
      Object.freeze(
        [...rows.values()]
          .filter((r) => r.info.userId === userId && live(r, now))
          .sort((a, b) => b.info.createdAt - a.info.createdAt || (a.info.id < b.info.id ? 1 : -1))
          .map(copy),
      ),

    revoke: async (userId, id) => {
      if (!isAgentTokenId(id)) return false;
      for (const [hash, row] of rows) {
        if (row.info.id === id && row.info.userId === userId) {
          rows.delete(hash);
          return true;
        }
      }
      return false;
    },

    revokeAllFor: async (userId) => {
      let count = 0;
      for (const [hash, row] of [...rows]) {
        if (row.info.userId === userId) {
          rows.delete(hash);
          count++;
        }
      }
      return count;
    },

    purgeExpired: async (now) => {
      let count = 0;
      for (const [hash, row] of [...rows]) {
        if (!live(row, now)) {
          rows.delete(hash);
          count++;
        }
      }
      return count;
    },
  };
}
