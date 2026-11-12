import { usageError } from './errors.js';
import { err, ok } from './result.js';
import type { UsageStore } from './store.js';
import type { UsageRecord } from './types.js';
import { aggregateRecords, copyRecord, recordProblem } from './validate.js';

/** The reference store: everything in memory, nothing shared between two stores. */
export function createMemoryUsageStore(): UsageStore {
  const rows: Array<{ record: UsageRecord; userId: string | null }> = [];
  return {
    async append(records) {
      for (const [i, r] of records.entries()) {
        const problem = recordProblem(r);
        if (problem !== undefined) return err(usageError('INVALID_INPUT', `record ${i}: ${problem}`));
      }
      for (const r of records) rows.push({ record: copyRecord(r), userId: r.userId });
      return ok(undefined);
    },
    async aggregate(range) {
      return aggregateRecords(rows, range);
    },
    async clearUser(userId) {
      let n = 0;
      for (const row of rows) {
        if (row.userId === userId) {
          row.userId = null;
          n++;
        }
      }
      return n;
    },
    async purgeBefore(time) {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if ((rows[i] as { record: UsageRecord }).record.at < time) {
          rows.splice(i, 1);
          n++;
        }
      }
      return n;
    },
  };
}
