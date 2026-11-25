import { resolutionError } from '../errors.js';
import { err, ok } from '../result.js';
import type { ResolutionStore } from '../store.js';
import { MAX_RESOLUTIONS_PER_USER, type Resolution } from '../types.js';
import { checkFactIds, checkKey, checkPage, compareFacts, copyFact, copyResolution, resolutionProblem, scopeKey } from '../validate.js';

/**
 * A small, plain resolution store with one defect that can be switched on, so the conformance suite can be shown to catch each one.
 * With no defect it is correct (and must pass the suite).
 */
export const DEFECTS = [
  'no-validation',
  'cap-ignored',
  'cap-blocks-replace',
  'no-copies',
  'shared-state',
  'get-leaks-other-person',
  'list-leaks-other-person',
  'list-for-ignores-person',
  'list-for-ignores-scope',
  'count-counts-everyone',
  'replace-adds-another',
  'scope-ignored-in-key',
  'remove-everyones',
  'remove-always-true',
  'remove-for-user-everyone',
  'remove-for-circle-everything',
  'remove-for-circle-keeps-personal-clash',
  'remove-fact-ignores-scope',
  'remove-fact-first-person-only',
  'remove-fact-wrong-count',
  'facts-repeats',
  'facts-unsorted',
  'locale-order',
  'after-ignored',
  'after-inclusive',
  'limit-ignored',
  'has-more-wrong',
  'bad-page-accepted',
  'bad-key-accepted',
  'too-many-ids-accepted',
  'racy-set',
] as const;
export type Defect = (typeof DEFECTS)[number];

const shared = new Map<string, Resolution>();

export function createNaiveResolutionStore(defect?: Defect): ResolutionStore {
  const is = (d: Defect): boolean => defect === d;
  const rows = is('shared-state') ? shared : new Map<string, Resolution>();
  let seq = 0;
  let busy = 0;
  const key = (r: { userId: string; scope: Resolution['scope']; factId: string }): string => JSON.stringify([r.userId, is('scope-ignored-in-key') ? 'x' : scopeKey(r.scope), r.factId]);
  const sorter = (a: Resolution, b: Resolution): number => (is('locale-order') ? a.factId.localeCompare(b.factId) : compareFacts(a, b));
  const own = (userId: string): Resolution[] => [...rows.values()].filter((r) => is('list-leaks-other-person') || r.userId === userId).sort(sorter);
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
  const check = (userId: string, scope: Resolution['scope'], factId: string): void => {
    if (!is('bad-key-accepted')) checkKey(userId, scope, factId);
  };
  const page = (p: Parameters<typeof checkPage>[0]): void => {
    if (!is('bad-page-accepted')) checkPage(p);
  };
  const cut = <T extends { scope: Resolution['scope']; factId: string }>(all: T[], p: { limit: number; after?: { scope: Resolution['scope']; factId: string } }): { items: T[]; hasMore: boolean } => {
    const after = p.after;
    const rest = after === undefined || is('after-ignored') ? all : all.filter((f) => (is('after-inclusive') ? compareFacts(f, after) >= 0 : compareFacts(f, after) > 0));
    const items = is('limit-ignored') ? rest : rest.slice(0, p.limit);
    return { items, hasMore: is('has-more-wrong') ? rest.length >= p.limit : rest.length > p.limit };
  };

  return {
    async set(resolution) {
      const problem = is('no-validation') ? undefined : resolutionProblem(resolution);
      if (problem !== undefined) return err(resolutionError('INVALID_INPUT', problem));
      const k = is('replace-adds-another') ? `${key(resolution)}#${seq++}` : key(resolution);
      const mine = [...rows.values()].filter((r) => r.userId === resolution.userId).length;
      const exists = [...rows.keys()].some((x) => x === k);
      if (!is('cap-ignored') && (is('cap-blocks-replace') ? mine >= MAX_RESOLUTIONS_PER_USER : !exists && mine >= MAX_RESOLUTIONS_PER_USER)) return err(resolutionError('LIMIT_REACHED', 'too many'));
      const value = is('no-copies') ? resolution : copyResolution(resolution);
      if (is('racy-set')) {
        busy++;
        await Promise.resolve();
        if (busy > 1) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          rows.clear(); // loses whatever arrived meanwhile
        }
        busy--;
      }
      rows.set(k, value);
      return ok(undefined);
    },
    async get(userId, scope, factId) {
      check(userId, scope, factId);
      const found = is('get-leaks-other-person') ? [...rows.values()].find((r) => scopeKey(r.scope) === scopeKey(scope) && r.factId === factId) : [...rows.entries()].find(([k, r]) => (is('replace-adds-another') ? r.userId === userId && scopeKey(r.scope) === scopeKey(scope) && r.factId === factId : k === key({ userId, scope, factId })))?.[1];
      return found === undefined ? undefined : is('no-copies') ? found : copyResolution(found);
    },
    async remove(userId, scope, factId) {
      check(userId, scope, factId);
      if (is('remove-everyones')) return sweep((r) => scopeKey(r.scope) === scopeKey(scope) && r.factId === factId) > 0;
      const had = rows.delete(key({ userId, scope, factId }));
      return is('remove-always-true') ? true : had;
    },
    async listFor(userId, scope, factIds) {
      check(userId, scope, 'x');
      if (!is('too-many-ids-accepted')) checkFactIds(factIds);
      const wanted = new Set(factIds);
      return [...rows.values()]
        .filter((r) => (is('list-for-ignores-person') || r.userId === userId) && (is('list-for-ignores-scope') || scopeKey(r.scope) === scopeKey(scope)) && wanted.has(r.factId))
        .sort(sorter)
        .map(copyResolution);
    },
    async list(userId, p) {
      page(p);
      const { items, hasMore } = cut(own(userId), p);
      return { items: items.map(copyResolution), hasMore };
    },
    async count(userId) {
      return is('count-counts-everyone') ? rows.size : [...rows.values()].filter((r) => r.userId === userId).length;
    },
    async removeForUser(userId) {
      return sweep((r) => is('remove-for-user-everyone') || r.userId === userId);
    },
    async removeForCircle(circleId) {
      return sweep((r) => is('remove-for-circle-everything') || (r.scope.kind === 'circle' && r.scope.circleId === circleId) || (is('remove-for-circle-keeps-personal-clash') && r.scope.kind === 'personal'));
    },
    async removeFact(scope, factId) {
      if (is('remove-fact-first-person-only')) {
        const first = [...rows.values()].find((r) => scopeKey(r.scope) === scopeKey(scope) && r.factId === factId);
        return first === undefined ? 0 : sweep((r) => r === first);
      }
      const n = sweep((r) => (is('remove-fact-ignores-scope') || scopeKey(r.scope) === scopeKey(scope)) && r.factId === factId);
      return is('remove-fact-wrong-count') ? Math.max(0, n - 1) : n;
    },
    async facts(p) {
      page(p);
      const all: Array<{ scope: Resolution['scope']; factId: string }> = [];
      const seen = new Set<string>();
      for (const r of rows.values()) {
        const k = JSON.stringify([scopeKey(r.scope), r.factId]);
        if (seen.has(k) && !is('facts-repeats')) continue;
        seen.add(k);
        all.push({ scope: r.scope, factId: r.factId });
      }
      if (!is('facts-unsorted')) all.sort(compareFacts);
      const { items, hasMore } = cut(all, p);
      return { items: items.map(copyFact), hasMore };
    },
  };
}
