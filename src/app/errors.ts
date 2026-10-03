/**
 * What can go wrong in the application layer, as a closed set. Errors from the graph store and the
 * LLM component keep their own types; these are the application's own.
 */
export const APP_ERROR_CODES = ['INVALID_INPUT', 'UNSUPPORTED_INPUT', 'NORMALISER_FAILED', 'TOO_MANY_PENDING', 'PROPOSAL_NOT_FOUND', 'PROPOSAL_EXPIRED', 'UNEXPECTED'] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export interface AppError {
  readonly code: AppErrorCode;
  readonly message: string;
}

export function appError(code: AppErrorCode, message: string): AppError {
  return Object.freeze({ code, message });
}
