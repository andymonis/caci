import { resolutionError } from './errors.js';
import { err, ok } from './result.js';
import type { ResolutionStore } from './store.js';
import { MAX_RESOLUTIONS_PER_USER, type Resolution } from './types.js';
import { checkFactIds, checkKey, checkPage, compareFacts, copyFact, copyResolution, resolutionProblem, scopeKey } from './validate.js';

/** The reference store: everything in memory, nothing shared between two stores. */
export function createMemoryResolutionStore(): ResolutionStore {
  const rows = new Map<string, Resolution>();
  const key = (r: { userId: string; scope: Resolution['scope']; factId: string }): string => JSON.stringify([r.userId, scopeKey(r.scope), r.factId]);
  const own = (userId: string): Resolution[] => [...rows.values()].filter((r) => r.userId === userId).sort(compareFacts);
  const sweep = (drop: (r: Resolution) => boolean): number => {
    let n = 0;
    for (const [k, r] of [...rows]) {
      if (drop(r)) {
        rows.delete(k);
        n++;
      }
    }
    return n;
  };
  return {
    async set(resolution) {
      const problem = resolutionProblem(resolution);
      if (problem !== undefined) return err(resolutionError('INVALID_INPUT', problem));
      const k = key(resolution);
      if (!rows.has(k) && own(resolution.userId).length >= MAX_RESOLUTIONS_PER_USER) return err(resolutionError('LIMIT_REACHED', `a person may hold at most ${MAX_RESOLUTIONS_PER_USER} resolutions`));
      rows.set(k, copyResolution(resolution));
      return ok(undefined);
    },
    async get(userId, scope, factId) {
      checkKey(userId, scope, factId);
      const r = rows.get(key({ userId, scope, factId }));
      return r === undefined ? undefined : copyResolution(r);
    },
    async remove(userId, scope, factId) {
      checkKey(userId, scope, factId);
      return rows.delete(key({ userId, scope, factId }));
    },
    async listFor(userId, scope, factIds) {
      checkKey(userId, scope, 'x');
      checkFactIds(factIds);
      const wanted = new Set(factIds);
      return own(userId)
        .filter((r) => scopeKey(r.scope) === scopeKey(scope) && wanted.has(r.factId))
        .map(copyResolution);
    },
    async list(userId, page) {
      checkPage(page);
      const all = own(userId).filter((r) => page.after === undefined || compareFacts(r, { scope: page.after.scope, factId: page.after.factId }) > 0);
      return { items: all.slice(0, page.limit).map(copyResolution), hasMore: all.length > page.limit };
    },
    async count(userId) {
      return own(userId).length;
    },
    async removeForUser(userId) {
      return sweep((r) => r.userId === userId);
    },
    async removeForCircle(circleId) {
      return sweep((r) => r.scope.kind === 'circle' && r.scope.circleId === circleId);
    },
    async removeFact(scope, factId) {
      return sweep((r) => scopeKey(r.scope) === scopeKey(scope) && r.factId === factId);
    },
    async facts(page) {
      checkPage(page);
      const distinct = new Map<string, { scope: Resolution['scope']; factId: string }>();
      for (const r of rows.values()) distinct.set(JSON.stringify([scopeKey(r.scope), r.factId]), { scope: r.scope, factId: r.factId });
      const all = [...distinct.values()].sort(compareFacts).filter((f) => page.after === undefined || compareFacts(f, page.after) > 0);
      return { items: all.slice(0, page.limit).map(copyFact), hasMore: all.length > page.limit };
    },
  };
}
