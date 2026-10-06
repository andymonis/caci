import type { JsonValue } from '../graph_store/index.js';

export const MAX_JSON_DEPTH = 16;

export type BodyResult = { readonly ok: true; readonly body: Readonly<Record<string, JsonValue>> | undefined } | { readonly ok: false; readonly status: 400 | 415; readonly message: string };

/** Is this `Content-Type` JSON? Exactly `application/json`, optionally with a charset of UTF-8. */
export function isJsonContentType(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const [type, ...params] = value.split(';').map((p) => p.trim().toLowerCase());
  if (type !== 'application/json') return false;
  return params.every((p) => p === 'charset=utf-8' || p === 'charset="utf-8"');
}

/** True when the value, however deep, has an object key that could poison a prototype, or nests deeper than allowed. */
function unsafe(value: unknown, depth: number): boolean {
  if (depth > MAX_JSON_DEPTH) return true;
  if (Array.isArray(value)) return value.some((v) => unsafe(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true;
      if (unsafe((value as Record<string, unknown>)[key], depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Turns the raw bytes of a request body into the object a handler gets. An empty body is `undefined`
 * (not an error: `logout` has none); anything else must be a JSON object, valid UTF-8, with no
 * prototype-poisoning keys and no deep nesting.
 */
export function parseBody(raw: Uint8Array, contentType: string | undefined): BodyResult {
  if (raw.length === 0) return { ok: true, body: undefined };
  if (!isJsonContentType(contentType)) return { ok: false, status: 415, message: 'send application/json' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return { ok: false, status: 400, message: 'the request body is not valid UTF-8' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, message: 'the request body is not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, status: 400, message: 'the request body must be a JSON object' };
  if (unsafe(parsed, 0)) return { ok: false, status: 400, message: 'the request body has a key or nesting that is not allowed' };
  return { ok: true, body: Object.freeze(parsed as Record<string, JsonValue>) };
}
