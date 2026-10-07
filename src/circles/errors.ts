/**
 * What can go wrong in the circle controller, as a closed set (R-004). Failures of the user
 * controller keep their own type; these are the circles component's own.
 */
export const CIRCLES_ERROR_CODES = ['INVALID_INPUT', 'NOT_FOUND', 'FORBIDDEN', 'CONFLICT', 'UNAUTHENTICATED', 'LAST_OWNER', 'LIMIT_REACHED', 'THROTTLED', 'STORAGE_ERROR'] as const;

export type CirclesErrorCode = (typeof CIRCLES_ERROR_CODES)[number];

export interface CirclesError {
  readonly code: CirclesErrorCode;
  readonly message: string;
  /** For `INVALID_INPUT`: which field was wrong. */
  readonly field?: string;
  /** For `THROTTLED`: how long until another attempt is allowed. */
  readonly retryAfterMs?: number;
}

export function circlesError(code: CirclesErrorCode, message: string, extra: { readonly field?: string; readonly retryAfterMs?: number } = {}): CirclesError {
  return Object.freeze({
    code,
    message,
    ...(extra.field === undefined ? {} : { field: extra.field }),
    ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
  });
}
