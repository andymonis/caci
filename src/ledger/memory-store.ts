import { pageOf } from './cursor.js';
import { ledgerError } from './errors.js';
import { err, ok } from './result.js';
import type { LedgerStore } from './store.js';
import type { LedgerEntry, LedgerSource } from './types.js';
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

    async sourceOf(scope, subject) {
      const key = scopeKey(scope);
      const mine = [...byId.values()].filter((e) => scopeKey(e.scope) === key);
      const byTime = (a: LedgerEntry, b: LedgerEntry): number => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const about = mine.filter((e) => e.kind === 'item' && e.subject === subject);
      const added = about.filter((e) => e.action === 'added').sort(byTime)[0];
      const removed = about.filter((e) => e.action === 'removed').sort(byTime).at(-1);
      const input = added === undefined ? undefined : mine.find((e) => e.kind === 'input' && e.proposalId === added.proposalId);
      const source: LedgerSource = { ...(added === undefined ? {} : { added: copyEntry(added) }), ...(input === undefined ? {} : { input: copyEntry(input) }), ...(removed === undefined ? {} : { removed: copyEntry(removed) }) };
      return source;
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
