import { createHash } from 'node:crypto';
import { err, graphError, ok, type Result } from './result.js';
import type { NodeRef, Query } from './types.js';

const MAX_CURSOR_LENGTH = 2048;
const CURSOR_VERSION = 1;

/** Stable text for any JSON value: object keys sorted, `undefined` dropped. Equal values give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Identifies what a query asks for, ignoring which page it asks for. A cursor only works with the
 * query that produced it: change the graph, seeds, traversal, filter or shape and it is refused.
 */
export function queryFingerprint(query: Query): string {
  const withoutPage: Record<string, unknown> = { ...query };
  delete withoutPage.page;
  return sha256(canonicalJson(withoutPage)).slice(0, 16);
}

const bad = (message: string) => err(graphError('VALIDATION_ERROR', message, ['page', 'cursor']));

/** An opaque cursor meaning "continue after this node" for the query with this fingerprint. */
export function encodeQueryCursor(fingerprint: string, after: NodeRef): string {
  const body = JSON.stringify({ v: CURSOR_VERSION, q: fingerprint, p: after.partition, id: after.id });
  return Buffer.from(`${sha256(body).slice(0, 8)}.${body}`, 'utf8').toString('base64url');
}

/**
 * Reads a cursor back. Anything that is not exactly what `encodeQueryCursor` produced for this
 * query (corrupted, edited, from another query or version, or not a cursor at all) is a
 * `VALIDATION_ERROR` pointing at `page.cursor`. Pure; never throws.
 */
export function decodeQueryCursor(cursor: string, fingerprint: string): Result<NodeRef> {
  const refused = 'cursor is not valid for this query (it may be corrupted, or from a different query)';
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) return bad(refused);
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(text, 'utf8').toString('base64url') !== cursor) return bad(refused); // not canonical
    const dot = text.indexOf('.');
    if (dot !== 8) return bad(refused);
    const [checksum, body] = [text.slice(0, dot), text.slice(dot + 1)];
    if (sha256(body).slice(0, 8) !== checksum) return bad(refused);
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return bad(refused);
    const { v, q, p, id, ...extra } = parsed as Record<string, unknown>;
    if (Object.keys(extra).length > 0 || v !== CURSOR_VERSION || q !== fingerprint) return bad(refused);
    if ((p !== 'item' && p !== 'category') || typeof id !== 'string' || id.length === 0) return bad(refused);
    return ok({ partition: p, id });
  } catch {
    return bad(refused);
  }
}
