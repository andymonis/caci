/** How much a model call used, in tokens. Cost is left to the caller, because prices change. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export const NO_USAGE: TokenUsage = Object.freeze({ inputTokens: 0, outputTokens: 0 });

/** The sum of two usages (for example a first attempt and its repair). Neither argument is changed. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return Object.freeze({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens });
}

export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/** True when both counts are whole, non-negative numbers, as a provider should report them. */
export function isValidUsage(usage: TokenUsage): boolean {
  return [usage.inputTokens, usage.outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0);
}
