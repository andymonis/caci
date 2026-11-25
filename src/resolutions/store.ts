import type { ResolutionError } from './errors.js';
import type { Result } from './result.js';
import type { Resolution, ResolutionPage, ResolutionPageInput, ResolutionScope, ResolvedFact } from './types.js';

/**
 * Where resolutions live (R-025 D16). All methods are async and return copies. A person's records are only ever read by that
 * person: every read takes the user id, and nothing lists another person's records (VR-FR-07). The store never holds text.
 */
export interface ResolutionStore {
  /**
   * Records that the person has dealt with the fact, replacing their earlier record for it (a second verb replaces the first).
   * A record that fails the check is `INVALID_INPUT`; a new record for a person already holding 2,000 is `LIMIT_REACHED` (replacing
   * one is always fine).
   */
  set(resolution: Resolution): Promise<Result<void, ResolutionError>>;
  /** The person's record for a fact, or `undefined`. */
  get(userId: string, scope: ResolutionScope, factId: string): Promise<Resolution | undefined>;
  /** Removes the person's record for a fact and says whether there was one. Anyone else's records are untouched. */
  remove(userId: string, scope: ResolutionScope, factId: string): Promise<boolean>;
  /** The person's records among these fact ids of one scope (at most 500 ids, or a `RangeError`), in fact-id order. */
  listFor(userId: string, scope: ResolutionScope, factIds: readonly string[]): Promise<Resolution[]>;
  /** One page of the person's own records, in a fixed order (scope, then fact id). The limit is 1 to 100, or a `RangeError`. */
  list(userId: string, page: ResolutionPageInput): Promise<ResolutionPage>;
  /** How many records the person holds. */
  count(userId: string): Promise<number>;
  /** Removes every record of one person (their account is going) and says how many. */
  removeForUser(userId: string): Promise<number>;
  /** Removes every record in one circle's scope (the circle is going) and says how many. */
  removeForCircle(circleId: string): Promise<number>;
  /** Removes every person's record for one fact (the fact is gone) and says how many. */
  removeFact(scope: ResolutionScope, factId: string): Promise<number>;
  /** One page of the distinct facts that have any record, in a fixed order, for the clean job. The limit is 1 to 100, or a `RangeError`. */
  facts(page: { readonly limit: number; readonly after?: ResolvedFact }): Promise<{ readonly items: readonly ResolvedFact[]; readonly hasMore: boolean }>;
}
