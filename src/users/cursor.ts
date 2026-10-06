const PREFIX = 'c';

/** The page cursor for "everything after this username": opaque text the caller hands back. */
export const encodeCursor = (username: string): string => PREFIX + Buffer.from(username, 'utf8').toString('base64url');

/** The username a cursor stands for; a `RangeError` for any text a store did not give out (including a second spelling of one that it did). */
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
