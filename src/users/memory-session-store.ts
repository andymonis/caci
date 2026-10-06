import type { SessionOptions, SessionStore } from './session-store.js';
import { resolveSessionOptions } from './session-store.js';
import { hashToken, isWellFormedToken, newSessionToken } from './tokens.js';

interface Session {
  readonly userId: string;
  readonly createdAt: number;
  lastUsedAt: number;
}

/** The reference session store, in memory. Each method runs without awaiting, so none interleaves with another. */
export function createMemorySessionStore(options: SessionOptions = {}): SessionStore {
  const settings = resolveSessionOptions(options);
  const sessions = new Map<string, Session>();
  const expired = (s: Session, now: number): boolean => now - s.createdAt >= settings.absoluteMs || now - s.lastUsedAt >= settings.idleMs;

  return {
    create: async (userId, now) => {
      const token = newSessionToken(settings.randomBytes);
      const mine = [...sessions.entries()].filter(([, s]) => s.userId === userId).sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
      for (const [hash] of mine.slice(0, Math.max(0, mine.length - settings.maxPerUser + 1))) sessions.delete(hash);
      sessions.set(hashToken(token), { userId, createdAt: now, lastUsedAt: now });
      return token;
    },

    resolve: async (token, now) => {
      if (!isWellFormedToken(token)) return undefined;
      const hash = hashToken(token);
      const session = sessions.get(hash);
      if (session === undefined) return undefined;
      if (expired(session, now)) {
        sessions.delete(hash);
        return undefined;
      }
      if (now - session.lastUsedAt >= settings.renewEveryMs) session.lastUsedAt = now;
      return session.userId;
    },

    revoke: async (token) => (isWellFormedToken(token) ? sessions.delete(hashToken(token)) : false),

    revokeAllFor: async (userId, revokeOptions = {}) => {
      const keep = isWellFormedToken(revokeOptions.except) ? hashToken(revokeOptions.except) : undefined;
      let count = 0;
      for (const [hash, s] of [...sessions]) {
        if (s.userId === userId && hash !== keep) {
          sessions.delete(hash);
          count++;
        }
      }
      return count;
    },

    purgeExpired: async (now) => {
      let count = 0;
      for (const [hash, s] of [...sessions]) {
        if (expired(s, now)) {
          sessions.delete(hash);
          count++;
        }
      }
      return count;
    },
  };
}
