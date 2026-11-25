export const RESOLUTION_ERROR_CODES = ['INVALID_INPUT', 'LIMIT_REACHED', 'STORAGE_ERROR'] as const;
export type ResolutionErrorCode = (typeof RESOLUTION_ERROR_CODES)[number];

export interface ResolutionError {
  readonly code: ResolutionErrorCode;
  readonly message: string;
}

export const resolutionError = (code: ResolutionErrorCode, message: string): ResolutionError => Object.freeze({ code, message });
