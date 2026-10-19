import { scopeKey } from './validate.js';
import type { LedgerScope } from './types.js';

const PREFIX = 'g';

/** A page cursor: "everything older than this entry, in this scope". Opaque text the caller hands back. */
export const encodeCursor = (scope: LedgerScope, at: number, id: string): string => PREFIX + Buffer.from(JSON.stringify([scopeKey(scope), at, id]), 'utf8').toString('base64url');

/** The position a cursor stands for; a `RangeError` for any text the store did not give out, for another scope, or a second spelling of a real one. */
export function decodeCursor(scope: LedgerScope, cursor: string): { at: number; id: string } {
  const bad = (): never => {
    throw new RangeError('Invalid page cursor');
  };
  if (!cursor.startsWith(PREFIX) || !/^[A-Za-z0-9_-]*$/.test(cursor.slice(1))) return bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor.slice(1), 'base64url').toString('utf8'));
  } catch {
    return bad();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== scopeKey(scope) || typeof parsed[1] !== 'number' || typeof parsed[2] !== 'string') return bad();
  if (encodeCursor(scope, parsed[1], parsed[2]) !== cursor) return bad();
  return { at: parsed[1], id: parsed[2] };
}

/** A page limit must be a positive whole number. */
export function checkLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`Page limit must be a positive integer, got ${limit}`);
  return limit;
}

/** Newest first; entries with the same time by id, highest first. */
export const newestFirst = (a: { at: number; id: string }, b: { at: number; id: string }): number => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** One page of `rows` (any order), newest first, starting after `page.cursor`. */
export function pageOf<T extends { at: number; id: string }>(scope: LedgerScope, rows: readonly T[], page: { readonly limit: number; readonly cursor: string | null }): { items: T[]; nextCursor: string | null } {
  const limit = checkLimit(page.limit);
  const after = page.cursor === null ? undefined : decodeCursor(scope, page.cursor);
  const sorted = [...rows].sort(newestFirst);
  const rest = after === undefined ? sorted : sorted.filter((r) => newestFirst(r, after) > 0);
  const items = rest.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rest.length > limit && last !== undefined ? encodeCursor(scope, last.at, last.id) : null };
}
