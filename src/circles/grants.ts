import { circlesError, type CirclesError } from './errors.js';
import { err, ok, type Result } from './result.js';

/** The longest category id a grant may name, in characters. */
export const MAX_CATEGORY_ID = 256;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The set a grant will hold, from what was asked for: each category an id of 1 to 256 characters (counted as
 * characters), duplicates collapsed, plain code-unit order, and no more than `max` (R-008). The one place the
 * rule is written, shared by every store so they cannot disagree.
 */
export function normaliseCategories(categories: unknown, max: number): Result<string[], CirclesError> {
  if (!Array.isArray(categories) || categories.some((c) => typeof c !== 'string' || c === '' || [...c].length > MAX_CATEGORY_ID)) {
    return err(circlesError('INVALID_INPUT', `each category is an id of 1 to ${MAX_CATEGORY_ID} characters`, { field: 'categories' }));
  }
  const set = [...new Set(categories as string[])].sort(compare);
  if (set.length > max) return err(circlesError('LIMIT_REACHED', `a grant may name at most ${max} categories`));
  return ok(set);
}

export const SELF_GRANT = (): CirclesError => circlesError('INVALID_INPUT', 'a person cannot share with themselves', { field: 'granteeId' });
