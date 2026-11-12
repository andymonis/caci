export const USAGE_ERROR_CODES = ['INVALID_INPUT', 'STORAGE_ERROR'] as const;
export type UsageErrorCode = (typeof USAGE_ERROR_CODES)[number];

export interface UsageError {
  readonly code: UsageErrorCode;
  readonly message: string;
}

export const usageError = (code: UsageErrorCode, message: string): UsageError => Object.freeze({ code, message });
