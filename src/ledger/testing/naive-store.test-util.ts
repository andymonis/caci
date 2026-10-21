import { checkLimit, decodeCursor, encodeCursor, newestFirst, pageOf } from '../cursor.js';
import { ledgerError } from '../errors.js';
import { err, ok } from '../result.js';
import type { LedgerStore } from '../store.js';
import type { LedgerEntry } from '../types.js';
import { copyEntry, entryProblem, scopeKey } from '../validate.js';

/**
 * A small, plain ledger store with one defect that can be switched on, so the conformance suite can be shown to catch each one.
 * With no defect it is correct (and must pass the suite).
 */
export const DEFECTS = [
  'oldest-first',
  'ties-lowest-id-first',
  'no-copies',
  'partial-batch',
  'duplicate-ids-allowed',
  'duplicate-in-batch-allowed',
  'scopes-mix-by-kind',
  'purge-inclusive',
  'purge-nothing',
  'remove-scope-everything',
  'remove-scope-wrong-count',
  'cursor-at-exact-fill',
  'cursor-ignores-scope',
  'no-length-check',
  'limit-ignored',
  'racy-duplicate-check',
  'shared-state',
  'no-validation',
  'skips-after-append',
  'cursor-accepts-garbage',
  'bad-limit-accepted',
  'drops-text',
  'accepts-stray-text',
  'text-limit-in-units',
  'source-ignores-scope',
  'source-wrong-input',
  'source-ignores-removal',
  'source-empty',
  'source-shared-copy',
] as const;
export type Defect = (typeof DEFECTS)[number];

const shared: LedgerEntry[] = [];
const withoutText = (e: LedgerEntry): LedgerEntry => {
  const copy: Record<string, unknown> = { ...e };
  delete copy.text;
  return copy as unknown as LedgerEntry;
};

export function createNaiveLedgerStore(defect?: Defect): LedgerStore {
  const is = (d: Defect): boolean => defect === d;
  const entries: LedgerEntry[] = is('shared-state') ? shared : [];
  const sameScope = (a: LedgerEntry, b: LedgerEntry['scope']): boolean => (is('scopes-mix-by-kind') ? a.scope.kind === b.kind : scopeKey(a.scope) === scopeKey(b));

  return {
    async append(batch) {
      const kept: LedgerEntry[] = [];
      for (const e of batch) {
        let problem = is('no-validation') ? undefined : entryProblem(e);
        if (is('accepts-stray-text') && problem === 'only an input has text') problem = undefined;
        if (is('text-limit-in-units') && problem !== undefined && problem.startsWith('an input needs text') && typeof e.text === 'string' && e.text.length > 0 && e.text.length <= 16000) problem = undefined;
        if (problem !== undefined && !is('no-length-check')) {
          if (is('partial-batch')) {
            entries.push(...kept);
          }
          return err(ledgerError('INVALID_INPUT', problem));
        }
        if (!is('duplicate-ids-allowed') && entries.some((x) => x.id === e.id)) return err(ledgerError('INVALID_INPUT', 'duplicate'));
        if (!is('duplicate-in-batch-allowed') && kept.some((x) => x.id === e.id)) return err(ledgerError('INVALID_INPUT', 'duplicate'));
        kept.push(is('no-copies') ? e : is('drops-text') ? withoutText(copyEntry(e)) : copyEntry(e));
      }
      if (is('racy-duplicate-check')) await Promise.resolve();
      entries.push(...kept);
      return ok(undefined);
    },

    async list(scope, page) {
      const rows = entries.filter((e) => sameScope(e, scope));
      if (is('oldest-first')) {
        const sorted = [...rows].sort((a, b) => -newestFirst(a, b));
        return { items: sorted.slice(0, checkLimit(page.limit)).map(copyEntry), nextCursor: null };
      }
      if (is('limit-ignored')) return { items: [...rows].sort(newestFirst).map(copyEntry), nextCursor: null };
      if (is('bad-limit-accepted') && !(Number.isInteger(page.limit) && page.limit >= 1)) return { items: [...rows].sort(newestFirst).map(copyEntry), nextCursor: null };
      if (is('cursor-accepts-garbage') && page.cursor !== null) {
        try {
          decodeCursor(scope, page.cursor);
        } catch {
          return { items: [...rows].sort(newestFirst).slice(0, page.limit).map(copyEntry), nextCursor: null };
        }
      }
      if (is('cursor-ignores-scope') && page.cursor !== null) {
        try {
          decodeCursor(scope, page.cursor);
        } catch (error) {
          // a cursor from another scope is accepted by reading its position out of it
          try {
            const parsed = JSON.parse(Buffer.from(page.cursor.slice(1), 'base64url').toString('utf8')) as [string, number, string];
            const sorted = [...rows].sort(newestFirst).filter((r) => newestFirst(r, { at: parsed[1], id: parsed[2] }) > 0);
            return { items: sorted.slice(0, page.limit).map(copyEntry), nextCursor: null };
          } catch {
            throw error;
          }
        }
      }
      const out = pageOf(scope, rows, page);
      let nextCursor = out.nextCursor;
      if (is('cursor-at-exact-fill') && out.items.length === page.limit && nextCursor === null) {
        const last = out.items[out.items.length - 1] as LedgerEntry;
        nextCursor = encodeCursor(scope, last.at, last.id);
      }
      let items = out.items;
      if (is('ties-lowest-id-first')) items = [...items].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
      if (is('skips-after-append') && page.cursor !== null && items.length > 0) items = items.slice(1);
      return { items: is('no-copies') ? items : items.map(copyEntry), nextCursor };
    },

    async sourceOf(scope, subject) {
      if (is('source-empty')) return {};
      const mine = entries.filter((e) => is('source-ignores-scope') || sameScope(e, scope));
      const about = mine.filter((e) => e.kind === 'item' && e.subject === subject);
      const added = about.filter((e) => e.action === 'added').sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))[0];
      const removed = is('source-ignores-removal') ? undefined : about.filter((e) => e.action === 'removed').sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)).at(-1);
      const input = added === undefined ? undefined : is('source-wrong-input') ? mine.find((e) => e.kind === 'input') : mine.find((e) => e.kind === 'input' && e.proposalId === added.proposalId);
      const copy = (e: LedgerEntry): LedgerEntry => (is('source-shared-copy') ? e : copyEntry(e));
      return { ...(added === undefined ? {} : { added: copy(added) }), ...(input === undefined ? {} : { input: copy(input) }), ...(removed === undefined ? {} : { removed: copy(removed) }) };
    },

    async purgeBefore(time) {
      if (is('purge-nothing')) return 0;
      const before = entries.length;
      const keep = entries.filter((e) => (is('purge-inclusive') ? e.at > time : e.at >= time));
      entries.length = 0;
      entries.push(...keep);
      return before - keep.length;
    },

    async removeScope(scope) {
      const before = entries.length;
      const keep = is('remove-scope-everything') ? [] : entries.filter((e) => !sameScope(e, scope));
      entries.length = 0;
      entries.push(...keep);
      return is('remove-scope-wrong-count') ? 1 : before - keep.length;
    },
  };
}
