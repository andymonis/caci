import { pageOf } from './cursor.js';
import { ledgerError } from './errors.js';
import { err, ok } from './result.js';
import type { LedgerStore } from './store.js';
import type { LedgerEntry } from './types.js';
import { copyEntry, entryProblem, scopeKey } from './validate.js';

/** The reference ledger store, in memory. Each method runs without awaiting, so none interleaves with another. */
export function createMemoryLedgerStore(): LedgerStore {
  const byId = new Map<string, LedgerEntry>();

  return {
    async append(entries) {
      const seen = new Set<string>();
      for (const entry of entries) {
        const problem = entryProblem(entry);
        if (problem !== undefined) return err(ledgerError('INVALID_INPUT', problem));
        if (byId.has(entry.id) || seen.has(entry.id)) return err(ledgerError('INVALID_INPUT', 'an entry id is already used'));
        seen.add(entry.id);
      }
      for (const entry of entries) byId.set(entry.id, copyEntry(entry));
      return ok(undefined);
    },

    async list(scope, page) {
      const key = scopeKey(scope);
      const rows = [...byId.values()].filter((e) => scopeKey(e.scope) === key);
      const out = pageOf(scope, rows, page);
      return { items: out.items.map(copyEntry), nextCursor: out.nextCursor };
    },

    async purgeBefore(time) {
      let count = 0;
      for (const [id, e] of byId) {
        if (e.at < time) {
          byId.delete(id);
          count++;
        }
      }
      return count;
    },

    async removeScope(scope) {
      const key = scopeKey(scope);
      let count = 0;
      for (const [id, e] of byId) {
        if (scopeKey(e.scope) === key) {
          byId.delete(id);
          count++;
        }
      }
      return count;
    },
  };
}
