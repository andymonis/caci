import { describe, expect, it } from 'vitest';
import { addUsage, isValidUsage, NO_USAGE, totalTokens } from './usage.js';

describe('token usage', () => {
  it('starts at zero', () => {
    expect(NO_USAGE).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(Object.isFrozen(NO_USAGE)).toBe(true);
  });

  it('adds two usages, for example an attempt and its repair', () => {
    expect(addUsage({ inputTokens: 100, outputTokens: 20 }, { inputTokens: 150, outputTokens: 30 })).toEqual({ inputTokens: 250, outputTokens: 50 });
  });

  it('adding zero changes nothing, and adding does not change its inputs', () => {
    const a = Object.freeze({ inputTokens: 7, outputTokens: 3 });
    expect(addUsage(a, NO_USAGE)).toEqual(a);
    expect(a).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('totals input and output', () => {
    expect(totalTokens({ inputTokens: 120, outputTokens: 30 })).toBe(150);
  });

  it.each([
    ['normal counts', { inputTokens: 10, outputTokens: 5 }, true],
    ['zeros', { inputTokens: 0, outputTokens: 0 }, true],
    ['a negative count', { inputTokens: -1, outputTokens: 5 }, false],
    ['a fractional count', { inputTokens: 1.5, outputTokens: 5 }, false],
    ['NaN', { inputTokens: Number.NaN, outputTokens: 5 }, false],
    ['Infinity', { inputTokens: 1, outputTokens: Infinity }, false],
  ])('%s is %s', (_name, usage, valid) => {
    expect(isValidUsage(usage)).toBe(valid);
  });

  it('adds cache counts when either side has them, and leaves them out when neither does', () => {
    const plain = { inputTokens: 100, outputTokens: 20 };
    const cached = { inputTokens: 50, outputTokens: 5, cacheReadTokens: 30, cacheCreationTokens: 4 };
    expect(addUsage(plain, plain)).toEqual({ inputTokens: 200, outputTokens: 40 });
    expect(Object.keys(addUsage(plain, plain))).toEqual(['inputTokens', 'outputTokens']);
    expect(addUsage(plain, cached)).toEqual({ inputTokens: 150, outputTokens: 25, cacheReadTokens: 30, cacheCreationTokens: 4 });
    expect(addUsage(cached, cached)).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 60, cacheCreationTokens: 8 });
    expect(addUsage({ inputTokens: 5, outputTokens: 1, cacheReadTokens: 2 }, plain)).toEqual({ inputTokens: 105, outputTokens: 21, cacheReadTokens: 2 });
    expect(Object.isFrozen(addUsage(cached, cached))).toBe(true);
  });

  it.each([
    ['cache counts within the input', { inputTokens: 10, outputTokens: 1, cacheReadTokens: 6, cacheCreationTokens: 4 }, true],
    ['only a read count', { inputTokens: 10, outputTokens: 1, cacheReadTokens: 10 }, true],
    ['cache counts above the input', { inputTokens: 10, outputTokens: 1, cacheReadTokens: 6, cacheCreationTokens: 5 }, false],
    ['a negative cache count', { inputTokens: 10, outputTokens: 1, cacheReadTokens: -1 }, false],
    ['a fractional cache count', { inputTokens: 10, outputTokens: 1, cacheCreationTokens: 0.5 }, false],
    ['a text cache count', { inputTokens: 10, outputTokens: 1, cacheReadTokens: '3' as unknown as number }, false],
  ])('%s is %s', (_name, usage, valid) => {
    expect(isValidUsage(usage)).toBe(valid);
  });
});
