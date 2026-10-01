import type { Page, Paged } from '../../adapter.js';

const encodeCursor = (key: string): string => Buffer.from(key, 'utf8').toString('base64url');
const decodeCursor = (cursor: string): string => Buffer.from(cursor, 'base64url').toString('utf8');

/** Deterministic ordering for keys: plain UTF-16 code-unit order, independent of locale. */
export const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Keyset pagination over items already sorted by key. The cursor is the last key returned
 * (opaque to callers), so inserts and deletes between pages cannot skip or repeat rows.
 */
export function paginate<T>(sorted: readonly T[], keyOf: (item: T) => string, page: Page): Paged<T> {
  if (!Number.isInteger(page.limit) || page.limit < 1) {
    throw new RangeError(`Page limit must be a positive integer, got ${page.limit}`);
  }
  let start = 0;
  if (page.cursor !== null) {
    const after = decodeCursor(page.cursor);
    start = sorted.findIndex((item) => keyOf(item) > after);
    if (start === -1) return { items: [], nextCursor: null };
  }
  const items = sorted.slice(start, start + page.limit);
  const last = items.at(-1);
  const hasMore = start + page.limit < sorted.length;
  return { items, nextCursor: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null };
}
