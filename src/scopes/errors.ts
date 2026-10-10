import type { Result } from '../circles/index.js';

/** The failures of the scopes component. Messages are fixed per kind: nothing a store or a request said is repeated. */
export const SCOPES_ERROR_CODES = ['INVALID_INPUT', 'NOT_FOUND', 'STORAGE_ERROR'] as const;
export type ScopesErrorCode = (typeof SCOPES_ERROR_CODES)[number];

export interface ScopesError {
  readonly code: ScopesErrorCode;
  readonly message: string;
  /** The field a problem is about, when there is one. */
  readonly field?: string;
}

export function scopesError(code: ScopesErrorCode, message: string, field?: string): ScopesError {
  return Object.freeze({ code, message, ...(field === undefined ? {} : { field }) });
}

export type ScopesResult<T> = Result<T, ScopesError>;
export const ok = <T>(value: T): ScopesResult<T> => ({ ok: true, value });
export const err = (error: ScopesError): ScopesResult<never> => ({ ok: false, error });
