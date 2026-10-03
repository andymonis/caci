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
});
