const PREFIX = 'k';

/** The page cursor for "everything after this key": opaque text the caller hands back. */
export const encodeCursor = (key: string): string => PREFIX + Buffer.from(key, 'utf8').toString('base64url');

/** The key a cursor stands for; a `RangeError` for any text a store did not give out (including a second spelling of one that it did). */
export function decodeCursor(cursor: string): string {
  if (!cursor.startsWith(PREFIX) || !/^[A-Za-z0-9_-]*$/.test(cursor.slice(1))) throw new RangeError('Invalid page cursor');
  const text = Buffer.from(cursor.slice(1), 'base64url').toString('utf8');
  if (encodeCursor(text) !== cursor) throw new RangeError('Invalid page cursor');
  return text;
}

/** Shared by every store: a page limit must be a positive whole number. */
export function checkLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`Page limit must be a positive integer, got ${limit}`);
  return limit;
}

/** One page of `rows` (already in key order), starting after `page.cursor`. */
export function pageOf<T>(rows: readonly T[], keyOf: (row: T) => string, page: { readonly limit: number; readonly cursor: string | null }): { items: T[]; nextCursor: string | null } {
  const limit = checkLimit(page.limit);
  const after = page.cursor === null ? undefined : decodeCursor(page.cursor);
  const rest = after === undefined ? rows : rows.filter((r) => keyOf(r) > after);
  const items = rest.slice(0, limit);
  return { items, nextCursor: rest.length > limit ? encodeCursor(keyOf(items[items.length - 1] as T)) : null };
}
