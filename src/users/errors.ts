/**
 * What can go wrong in the user controller, as a closed set (R-002). Errors from the graph store
 * keep their own type; these are the users component's own.
 */
export const USERS_ERROR_CODES = ['INVALID_INPUT', 'CONFLICT', 'NOT_FOUND', 'UNAUTHENTICATED', 'FORBIDDEN', 'THROTTLED', 'LAST_ADMIN', 'STORAGE_ERROR'] as const;

export type UsersErrorCode = (typeof USERS_ERROR_CODES)[number];

export interface UsersError {
  readonly code: UsersErrorCode;
  readonly message: string;
  /** For `INVALID_INPUT`: which field was wrong. */
  readonly field?: string;
  /** For `THROTTLED`: how long until another attempt is allowed. */
  readonly retryAfterMs?: number;
}

export function usersError(code: UsersErrorCode, message: string, extra: { readonly field?: string; readonly retryAfterMs?: number } = {}): UsersError {
  return Object.freeze({
    code,
    message,
    ...(extra.field === undefined ? {} : { field: extra.field }),
    ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
  });
}
