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
      order: 'oldest-first', pad: [0], seed: 1, window: 150000, controls: undefined, compare: undefined, rescore: undefined, force: false, noReplace: false, demo: false, yes: false, out: 'brain-eval-results', help: false,
    });
    expect(ARMS).toEqual(['brain', 'replay']);
    expect(DEFAULT_ANSWER_WITH).toEqual(['fast', 'balanced', 'deep']);
  });
  it('--no-replace switches replacing off and is on by default', () => {
    expect(ok([]).noReplace).toBe(false);
    expect(ok(['--no-replace']).noReplace).toBe(true);
    expect(ok(['--demo', '--no-replace']).demo).toBe(true);
  });
  it('every option is in the usage text', () => {
    for (const flag of ['--scenarios', '--only', '--file-with', '--answer-with', '--arms', '--repeat', '--order', '--pad', '--seed', '--window', '--controls', '--compare', '--rescore', '--force', '--no-replace', '--demo', '--yes', '--out', '--help']) expect(USAGE).toContain(flag);
  });
});

describe('--compare', () => {
  it('takes two files and --force', () => {
    expect(ok(['--compare', 'a.json', 'b.json'])).toMatchObject({ compare: ['a.json', 'b.json'], force: false });
    expect(ok(['--compare', 'a.json', 'b.json', '--force']).force).toBe(true);
    expect(ok(['--force', '--compare', 'a.json', 'b.json']).force).toBe(true);
    expect(ok(['--compare', 'a.json', 'b.json', '--repeat', '2']).repeat).toBe(2);
  });
  it.each([[['--compare']], [['--compare', 'a.json']], [['--compare', 'a.json', '--yes']], [['--compare', '--yes', 'a.json']]])('refuses %j', (argv) => {
    expect(bad(argv)).toContain('--compare needs two files');
  });
  it('--force alone is refused', () => expect(bad(['--force'])).toContain('--force is only for --compare or --rescore'));
  it('--rescore takes a file and allows --force', () => {
    expect(ok(['--rescore', 'run.json'])).toMatchObject({ rescore: 'run.json', force: false });
    expect(ok(['--rescore', 'run.json', '--force']).force).toBe(true);
    expect(bad(['--rescore'])).toContain('--rescore needs a value');
  });
});

describe('options', () => {
  it('takes every value', () => {
    expect(ok(['--scenarios', 'mine', '--only', 'a, b,a', '--file-with', 'deep', '--answer-with', 'fast,claude-x,fast', '--arms', 'replay', '--repeat', '5', '--order', 'newest-first', '--pad', '300,0,100,100', '--seed', '9', '--window', '2000', '--controls', 'c', '--out', 'o']))
      .toMatchObject({ scenarios: 'mine', only: ['a', 'b'], fileWith: 'deep', answerWith: ['fast', 'claude-x'], arms: ['replay'], repeat: 5, order: 'newest-first', pad: [0, 100, 300], seed: 9, window: 2000, controls: 'c', out: 'o' });
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
    [['--pad', '-1'], '--pad must be whole numbers from 0 to 1000'],
    [['--pad', '1001'], '--pad must be whole numbers from 0 to 1000'],
    [['--pad', '1.5'], '--pad must be whole numbers from 0 to 1000'],
    [['--pad', 'x'], '--pad must be whole numbers from 0 to 1000'],
    [['--pad', ','], '--pad must be whole numbers from 0 to 1000'],
    [['--seed', '-1'], '--seed must be a whole number, 0 or more'],
    [['--seed', '1.5'], '--seed must be a whole number, 0 or more'],
    [['--window', '999'], '--window must be a whole number of tokens, at least 1000'],
    [['--window', 'x'], '--window must be a whole number of tokens, at least 1000'],
    [['--demo', '--yes'], '--demo and --yes together make no sense: --yes is for real calls'],
  ])('refuses %j', (argv, message) => expect(bad(argv)).toContain(message));
  it('repeat accepts the edges', () => {
    expect(ok(['--repeat', '1']).repeat).toBe(1);
    expect(ok(['--repeat', '10']).repeat).toBe(10);
    expect(ok(['--window', '1000']).window).toBe(1000);
    expect(ok(['--pad', '1000']).pad).toEqual([1000]);
    expect(ok(['--seed', '0']).seed).toBe(0);
  });
  it('resolves tiers and exact ids', () => {
    expect(resolveModels(['fast', 'claude-x'], { fast: 'a' })).toEqual([{ label: 'fast', choice: { tier: 'fast' } }, { label: 'claude-x', choice: { model: 'claude-x' } }]);
  });
});
