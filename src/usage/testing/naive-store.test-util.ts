import { usageError } from '../errors.js';
import { err, ok } from '../result.js';
import type { UsageStore } from '../store.js';
import type { UsageAggregate, UsageRecord } from '../types.js';
import { recordProblem, scopeKey } from '../validate.js';

/**
 * A small, plain usage store with one defect that can be switched on, so the conformance suite can be shown to catch each one.
 * With no defect it is correct (and must pass the suite).
 */
export const DEFECTS = [
  'partial-batch',
  'no-validation',
  'extra-fields-kept',
  'range-end-inclusive',
  'range-start-exclusive',
  'day-shifted',
  'calls-count-every-attempt',
  'failed-counts-rejected',
  'rejected-not-counted',
  'no-copies',
  'clear-user-everyone',
  'clear-user-deletes',
  'clear-user-wrong-count',
  'purge-inclusive',
  'purge-nothing',
  'sums-drop-cache',
  'sums-drop-latency',
  'groups-ignore-model',
  'groups-ignore-scope',
  'groups-ignore-capability',
  'groups-ignore-day',
  'groups-ignore-user',
  'shared-state',
  'racy-append',
  'unsorted',
  'gone-first',
  'bad-range-accepted',
  'cache-over-input-allowed',
  'purge-keeps-gone',
] as const;
export type Defect = (typeof DEFECTS)[number];

type Row = { record: UsageRecord; userId: string | null };
const shared: Row[] = [];
const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function createNaiveUsageStore(defect?: Defect): UsageStore {
  const is = (d: Defect): boolean => defect === d;
  const rows: Row[] = is('shared-state') ? shared : [];

  return {
    async append(batch) {
      const kept: Row[] = [];
      for (const [i, r] of batch.entries()) {
        let problem = is('no-validation') ? undefined : recordProblem(is('extra-fields-kept') ? stripExtras(r) : r);
        if (problem !== undefined && is('cache-over-input-allowed') && problem.startsWith('the cache counts')) problem = undefined;
        if (problem !== undefined) {
          if (is('partial-batch')) {
            rows.push(...kept);
          }
          return err(usageError('INVALID_INPUT', `record ${i}: ${problem}`));
        }
        kept.push({ record: is('no-copies') ? r : { ...r, scope: { ...r.scope } }, userId: r.userId });
      }
      if (is('racy-append')) {
        const snapshot = rows.length;
        await new Promise((resolve) => setTimeout(resolve, 1));
        rows.splice(snapshot, rows.length - snapshot, ...kept); // overwrites whatever arrived meanwhile
      } else rows.push(...kept);
      return ok(undefined);
    },
    async aggregate(range) {
      if (!is('bad-range-accepted') && !(Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to) && range.from >= 0 && range.from <= range.to)) throw new RangeError('a usage range needs whole times with from not after to');
      const groups = new Map<string, { -readonly [K in keyof UsageAggregate]: UsageAggregate[K] }>();
      for (const { record: r, userId } of rows) {
        const after = is('range-start-exclusive') ? r.at > range.from : r.at >= range.from;
        const before = is('range-end-inclusive') ? r.at <= range.to : r.at < range.to;
        if (!after || !before) continue;
        const day = new Date(is('day-shifted') ? r.at + 3_600_000 * 5 : r.at).toISOString().slice(0, 10);
        const key = JSON.stringify([is('groups-ignore-day') ? '' : day, is('groups-ignore-user') ? '' : userId, is('groups-ignore-capability') ? '' : r.capability, is('groups-ignore-scope') ? '' : scopeKey(r.scope), is('groups-ignore-model') ? '' : r.model]);
        let g = groups.get(key);
        if (g === undefined) {
          g = { day, userId, capability: r.capability, scope: { ...r.scope }, model: r.model, calls: 0, attempts: 0, rejected: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, latencyMs: 0 };
          groups.set(key, g);
        }
        if (is('calls-count-every-attempt') || r.attempt === 1) g.calls++;
        g.attempts++;
        if (r.result === 'rejected') {
          if (!is('rejected-not-counted')) g.rejected++;
          if (is('failed-counts-rejected')) g.failed++;
        } else if (r.result !== 'ok') g.failed++;
        g.inputTokens += r.inputTokens;
        g.outputTokens += r.outputTokens;
        if (!is('sums-drop-cache')) {
          g.cacheReadTokens += r.cacheReadTokens;
          g.cacheCreationTokens += r.cacheCreationTokens;
        }
        if (!is('sums-drop-latency')) g.latencyMs += r.latencyMs;
      }
      const out = [...groups.values()];
      if (is('unsorted')) return out.reverse();
      return out.sort((a, b) => {
        if (is('gone-first') && a.userId !== b.userId) return a.userId === null ? -1 : b.userId === null ? 1 : 0;
        return text(a.day, b.day) || (a.userId === b.userId ? 0 : a.userId === null ? 1 : b.userId === null ? -1 : text(a.userId, b.userId)) || text(a.capability, b.capability) || text(scopeKey(a.scope), scopeKey(b.scope)) || text(a.model, b.model);
      });
    },
    async clearUser(userId) {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i] as Row;
        if (is('clear-user-everyone') || row.userId === userId) {
          if (is('clear-user-deletes')) rows.splice(i, 1);
          else row.userId = null;
          n++;
        }
      }
      return is('clear-user-wrong-count') ? n + 1 : n;
    },
    async purgeBefore(time) {
      if (is('purge-nothing')) return 0;
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i] as Row;
        if (is('purge-keeps-gone') && row.userId === null) continue;
        if (is('purge-inclusive') ? row.record.at <= time : row.record.at < time) {
          rows.splice(i, 1);
          n++;
        }
      }
      return n;
    },
  };
}

const stripExtras = (r: UsageRecord): UsageRecord => {
  const { at, userId, capability, scope, model, attempt, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, result, latencyMs } = r;
  return { at, userId, capability, scope, model, attempt, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, result, latencyMs };
};
