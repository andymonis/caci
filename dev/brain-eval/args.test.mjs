import { describe, expect, it } from 'vitest';
import { ARMS, DEFAULT_ANSWER_WITH, parseArgs, resolveModels, USAGE } from './args.mjs';

const ok = (argv) => {
  const r = parseArgs(argv);
  if (!r.ok) throw new Error(r.message);
  return r.value;
};
const bad = (argv) => {
  const r = parseArgs(argv);
  expect(r.ok).toBe(false);
  return r.message;
};

describe('defaults', () => {
  it('are the ones the specification names', () => {
    expect(ok([])).toEqual({
      scenarios: undefined, only: undefined, fileWith: 'fast', answerWith: ['fast', 'balanced', 'deep'], arms: ['brain', 'replay'], repeat: 3,
      order: 'oldest-first', window: 150000, controls: undefined, demo: false, yes: false, out: 'brain-eval-results', help: false,
    });
    expect(ARMS).toEqual(['brain', 'replay']);
    expect(DEFAULT_ANSWER_WITH).toEqual(['fast', 'balanced', 'deep']);
  });
  it('every option is in the usage text', () => {
    for (const flag of ['--scenarios', '--only', '--file-with', '--answer-with', '--arms', '--repeat', '--order', '--window', '--controls', '--demo', '--yes', '--out', '--help']) expect(USAGE).toContain(flag);
  });
});

describe('options', () => {
  it('takes every value', () => {
    expect(ok(['--scenarios', 'mine', '--only', 'a, b,a', '--file-with', 'deep', '--answer-with', 'fast,claude-x,fast', '--arms', 'replay', '--repeat', '5', '--order', 'newest-first', '--window', '2000', '--controls', 'c', '--out', 'o']))
      .toMatchObject({ scenarios: 'mine', only: ['a', 'b'], fileWith: 'deep', answerWith: ['fast', 'claude-x'], arms: ['replay'], repeat: 5, order: 'newest-first', window: 2000, controls: 'c', out: 'o' });
    expect(ok(['--demo']).demo).toBe(true);
    expect(ok(['--yes']).yes).toBe(true);
    expect(ok(['--help']).help).toBe(true);
  });
  it('arms keep their fixed order whatever order they are given', () => {
    expect(ok(['--arms', 'replay,brain']).arms).toEqual(['brain', 'replay']);
  });
  it.each([
    [['--nope'], 'unknown option --nope'],
    [['--only'], '--only needs a value'],
    [['--only', '--yes'], '--only needs a value'],
    [['--only', ','], '--only needs at least one scenario id'],
    [['--file-with', 'fast,deep'], '--file-with takes exactly one model'],
    [['--answer-with', ','], '--answer-with needs at least one model'],
    [['--arms', 'brain,magic'], '--arms must be a list of: brain, replay'],
    [['--repeat', '0'], '--repeat must be a whole number from 1 to 10'],
    [['--repeat', '11'], '--repeat must be a whole number from 1 to 10'],
    [['--repeat', '1.5'], '--repeat must be a whole number from 1 to 10'],
    [['--order', 'sideways'], '--order must be one of: oldest-first, newest-first'],
    [['--window', '999'], '--window must be a whole number of tokens, at least 1000'],
    [['--window', 'x'], '--window must be a whole number of tokens, at least 1000'],
    [['--demo', '--yes'], '--demo and --yes together make no sense: --yes is for real calls'],
  ])('refuses %j', (argv, message) => expect(bad(argv)).toContain(message));
  it('repeat accepts the edges', () => {
    expect(ok(['--repeat', '1']).repeat).toBe(1);
    expect(ok(['--repeat', '10']).repeat).toBe(10);
    expect(ok(['--window', '1000']).window).toBe(1000);
  });
  it('resolves tiers and exact ids', () => {
    expect(resolveModels(['fast', 'claude-x'], { fast: 'a' })).toEqual([{ label: 'fast', choice: { tier: 'fast' } }, { label: 'claude-x', choice: { model: 'claude-x' } }]);
  });
});
