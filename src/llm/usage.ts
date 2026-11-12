/**
 * How much a model call used, in tokens. Cost is left to the caller, because prices change.
 * `inputTokens` is the total input (cached tokens included); the two optional counts say how much of it the provider
 * served from, or wrote to, its cache, because those are priced differently. They are absent when the provider did not say.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
}

export const NO_USAGE: TokenUsage = Object.freeze({ inputTokens: 0, outputTokens: 0 });

/** The sum of two usages (for example a first attempt and its repair). Neither argument is changed. A cache count appears in the sum only if either side had it. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number } = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined) sum.cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  if (a.cacheCreationTokens !== undefined || b.cacheCreationTokens !== undefined) sum.cacheCreationTokens = (a.cacheCreationTokens ?? 0) + (b.cacheCreationTokens ?? 0);
  return Object.freeze(sum);
}

export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * True when the counts are whole, non-negative numbers, as a provider should report them, and the cache counts (when given)
 * are whole, non-negative and together no more than the input they are part of.
 */
export function isValidUsage(usage: TokenUsage): boolean {
  const whole = (n: unknown): boolean => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!whole(usage.inputTokens) || !whole(usage.outputTokens)) return false;
  for (const cache of [usage.cacheReadTokens, usage.cacheCreationTokens]) if (cache !== undefined && !whole(cache)) return false;
  return (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0) <= usage.inputTokens;
}
