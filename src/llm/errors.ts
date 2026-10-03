/**
 * Everything that can go wrong when talking to a model, as a closed set so callers can handle each
 * case. This is the LLM component's own list: it is separate from the graph store's error codes.
 */
export const LLM_ERROR_CODES = ['TIMEOUT', 'RATE_LIMITED', 'REFUSED', 'BAD_OUTPUT', 'MODEL_ERROR', 'CONFIG', 'CANCELLED'] as const;

export type LlmErrorCode = (typeof LLM_ERROR_CODES)[number];

export interface LlmError {
  readonly code: LlmErrorCode;
  readonly message: string;
  /** True when trying the same request again later may succeed (a timeout, a rate limit, a server error). */
  readonly retryable: boolean;
  /** For `RATE_LIMITED`: how long the provider asked callers to wait, when it said. */
  readonly retryAfterMs?: number;
}

export interface LlmErrorOptions {
  /** Overrides the default for the code (a `MODEL_ERROR` from a server fault is retryable). */
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
}

/** Only these codes are worth retrying by default. */
const RETRYABLE_BY_DEFAULT: Readonly<Record<LlmErrorCode, boolean>> = Object.freeze({
  TIMEOUT: true,
  RATE_LIMITED: true,
  REFUSED: false,
  BAD_OUTPUT: false,
  MODEL_ERROR: false,
  CONFIG: false,
  CANCELLED: false,
});

export function llmError(code: LlmErrorCode, message: string, options: LlmErrorOptions = {}): LlmError {
  return Object.freeze({
    code,
    message,
    retryable: options.retryable ?? RETRYABLE_BY_DEFAULT[code],
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
  });
}
