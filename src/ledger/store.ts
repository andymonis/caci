import type { LedgerError } from './errors.js';
import type { Result } from './result.js';
import type { LedgerEntry, LedgerPage, LedgerScope, LedgerSource } from './types.js';

export interface LedgerPageRequest {
  /** A positive whole number. */
  readonly limit: number;
  /** The `nextCursor` of the previous page, or `null` for the first. */
  readonly cursor: string | null;
}

/**
 * Where the change log lives (R-014). All methods are async and return copies. A bad page limit, or a cursor the store did not
 * give out for that scope, is a `RangeError`.
 */
export interface LedgerStore {
  /**
   * Records a batch of entries **all or nothing**. An entry that fails the entry check, or whose id is already used (or is
   * repeated in the batch), is `INVALID_INPUT` and nothing from the batch is kept. An empty batch is fine.
   */
  append(entries: readonly LedgerEntry[]): Promise<Result<void, LedgerError>>;
  /** The scope's entries, newest first (entries at the same time by id, highest first), paged. */
  list(scope: LedgerScope, page: LedgerPageRequest): Promise<LedgerPage>;
  /**
   * Where one fact came from, in that scope only (R-017 D17): the entry that added the item `subject`, the `input` entry of the same
   * approval (the same `proposalId`), and the newest entry that removed it. An id that was never recorded in that scope gives `{}`.
   */
  sourceOf(scope: LedgerScope, subject: string): Promise<LedgerSource>;
  /** Removes every entry older than `time` (strictly) and says how many. */
  purgeBefore(time: number): Promise<number>;
  /** Removes every entry of one scope and says how many; 0 when there are none. */
  removeScope(scope: LedgerScope): Promise<number>;
}
