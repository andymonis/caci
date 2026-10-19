export const LEDGER_ERROR_CODES = ['INVALID_INPUT', 'STORAGE_ERROR'] as const;
export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

export interface LedgerError {
  readonly code: LedgerErrorCode;
  readonly message: string;
}

export const ledgerError = (code: LedgerErrorCode, message: string): LedgerError => Object.freeze({ code, message });
