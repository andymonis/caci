import type { UsageError } from './errors.js';
import type { Result } from './result.js';
import type { UsageAggregate, UsageRange, UsageRecord } from './types.js';

/**
 * Where usage records live (R-024 D13). All methods are async and return copies. The store never holds text (a record has no
 * field for it).
 */
export interface UsageStore {
  /**
   * Records a batch **all or nothing**: a record that fails the record check is `INVALID_INPUT` and nothing from the batch is
   * kept. An empty batch is fine.
   */
  append(records: readonly UsageRecord[]): Promise<Result<void, UsageError>>;
  /**
   * The records with `from <= at < to`, added up per UTC day, person, call type, scope and model, in a fixed order (day, person,
   * call type, scope, model; accounts that are gone last). A person whose account was deleted has `userId: null`. Whole times with
   * `from` not after `to`, or it is a `RangeError`.
   */
  aggregate(range: UsageRange): Promise<UsageAggregate[]>;
  /** Clears the person on every record of this user id, keeping the rest (R-024 D11), and says how many records that was. */
  clearUser(userId: string): Promise<number>;
  /** Removes every record older than `time` (strictly) and says how many. */
  purgeBefore(time: number): Promise<number>;
}
