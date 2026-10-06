import type { AppError, ControllerError } from '../app/index.js';

/** What can go wrong in the CaCi controller's own rules, as a closed set. */
export const CACI_ERROR_CODES = ['UNAUTHENTICATED', 'NOT_FOUND', 'EXPIRED', 'THROTTLED', 'TOO_MANY_PENDING', 'INVALID_INPUT'] as const;
export type CaciErrorCode = (typeof CACI_ERROR_CODES)[number];

export interface CaciOwnError {
  readonly code: CaciErrorCode;
  readonly message: string;
  /** For `INVALID_INPUT`: which field. */
  readonly field?: string;
  /** For `THROTTLED` and `TOO_MANY_PENDING`: how long until a place frees up, when that is known. */
  readonly retryAfterMs?: number;
}

/**
 * Errors keep the type of the component that produced them, and `source` says which: this controller's own
 * rules (`caci`), the capture controller (`app`), the graph store (`graph`) or the model (`llm`).
 */
export type CaciError = { readonly source: 'caci'; readonly error: CaciOwnError } | ControllerError;
export type { AppError };

export function caciError(code: CaciErrorCode, message: string, extra: { readonly field?: string; readonly retryAfterMs?: number } = {}): CaciError {
  return Object.freeze({
    source: 'caci' as const,
    error: Object.freeze({
      code,
      message,
      ...(extra.field === undefined ? {} : { field: extra.field }),
      ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
    }),
  });
}
