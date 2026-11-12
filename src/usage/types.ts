/** What a model call was for (R-024 D9). An agent's own model costs the operator nothing and is not here. */
export const USAGE_CAPABILITIES = ['categorise', 'status', 'check', 'agent-check'] as const;
export type UsageCapability = (typeof USAGE_CAPABILITIES)[number];

/**
 * How one attempt ended. `rejected` is an answer the checks refused (the call then makes a repair attempt); the others are the
 * ways a call to the model fails. Only `ok` and `rejected` mean the provider gave an answer.
 */
export const USAGE_RESULTS = ['ok', 'rejected', 'timeout', 'rate_limited', 'refused', 'bad_output', 'model_error', 'config', 'cancelled'] as const;
export type UsageResult = (typeof USAGE_RESULTS)[number];

/** Where a call ran: the person's own brain, or a circle's (R-024 D2: the asker is charged either way). */
export type UsageScope = { readonly kind: 'personal' } | { readonly kind: 'circle'; readonly circleId: string };

/**
 * One model attempt (R-024 D4 and D8). There is no field that could hold text: no note, request, answer, name or fact id. A call is
 * one attempt, or two when the first was rejected and repaired. `inputTokens` is the total input, cached tokens included.
 */
export interface UsageRecord {
  /** When the attempt was made, in milliseconds since 1970. */
  readonly at: number;
  /** The person who asked and is charged (a user id). */
  readonly userId: string;
  readonly capability: UsageCapability;
  readonly scope: UsageScope;
  /** The model that actually answered (or was asked). */
  readonly model: string;
  readonly attempt: 1 | 2;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly result: UsageResult;
  readonly latencyMs: number;
}

/**
 * The records of one UTC day for one person (or `null` once the account is gone), call type, scope and model, added up. This is the
 * finest grain the report needs, so a store can answer it without handing over every row.
 */
export interface UsageAggregate {
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
  readonly userId: string | null;
  readonly capability: UsageCapability;
  readonly scope: UsageScope;
  readonly model: string;
  /** Calls: the first attempts. */
  readonly calls: number;
  readonly attempts: number;
  /** Attempts whose answer the checks refused (each led to a repair). */
  readonly rejected: number;
  /** Attempts that failed to get an answer from the model (any result but `ok` and `rejected`). */
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly latencyMs: number;
}

/** A half-open range of times: `from` included, `to` excluded. */
export interface UsageRange {
  readonly from: number;
  readonly to: number;
}

export const MODEL_MAX = 200;
export const TOKENS_MAX = 1_000_000_000;
export const LATENCY_MAX = 86_400_000;
