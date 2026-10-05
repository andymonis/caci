import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, parseArgs, resolveModels, USAGE } from './args.mjs';

const parse = (...argv) => parseArgs(argv);

describe('parseArgs', () => {
  it('has sensible defaults: all three tiers, one run, real calls need --yes', () => {
    expect(parse()).toEqual({ ok: true, value: { models: ['fast', 'balanced', 'deep'], repeat: 1, golden: undefined, only: undefined, scripted: false, yes: false, out: 'eval-results', help: false } });
    expect(DEFAULT_MODELS).toEqual(['fast', 'balanced', 'deep']);
  });
  it('reads every option', () => {
    const r = parse('--models', 'fast, my-model-1', '--repeat', '3', '--golden', 'mine.json', '--only', 'a,b', '--out', 'results', '--yes');
    expect(r.value).toMatchObject({ models: ['fast', 'my-model-1'], repeat: 3, golden: 'mine.json', only: ['a', 'b'], out: 'results', yes: true, scripted: false });
  });
  it('reads the flags', () => {
    expect(parse('--scripted').value.scripted).toBe(true);
    expect(parse('--help').value.help).toBe(true);
  });
  it('removes repeats from lists', () => {
    expect(parse('--models', 'fast,fast,deep').value.models).toEqual(['fast', 'deep']);
    expect(parse('--only', 'a,a').value.only).toEqual(['a']);
  });
  it.each([
    [['--models'], '--models needs a value'],
    [['--models', '--yes'], '--models needs a value'],
    [['--models', ' , '], '--models needs at least one model'],
    [['--only', ','], '--only needs at least one case id'],
    [['--repeat', '0'], '--repeat must be a whole number from 1 to 10'],
    [['--repeat', '11'], '--repeat must be a whole number from 1 to 10'],
    [['--repeat', '1.5'], '--repeat must be a whole number from 1 to 10'],
    [['--repeat', 'many'], '--repeat must be a whole number from 1 to 10'],
    [['--golden'], '--golden needs a value'],
    [['--nope'], 'unknown option --nope (try --help)'],
    [['fast'], 'unknown option fast (try --help)'],
    [['--scripted', '--yes'], '--scripted and --yes together'],
  ])('refuses %j', (argv, message) => {
    const r = parseArgs(argv);
    expect(r.ok).toBe(false);
    expect(r.message).toContain(message);
  });
  it('accepts the bounds of --repeat', () => {
    expect(parse('--repeat', '1').ok).toBe(true);
    expect(parse('--repeat', '10').ok).toBe(true);
  });
  it('the usage text mentions every option and warns about cost', () => {
    for (const flag of ['--models', '--repeat', '--golden', '--only', '--scripted', '--yes', '--out', '--help']) expect(USAGE).toContain(flag);
    expect(USAGE).toContain('costs money');
  });
});

describe('resolveModels', () => {
  const tiers = { fast: 'f-id', balanced: 'b-id', deep: 'd-id' };
  it('treats tier names as tiers and anything else as an exact model id', () => {
    expect(resolveModels(['fast', 'claude-x-1', 'deep'], tiers)).toEqual([
      { label: 'fast', choice: { tier: 'fast' } },
      { label: 'claude-x-1', choice: { model: 'claude-x-1' } },
      { label: 'deep', choice: { tier: 'deep' } },
    ]);
  });
  it('does not mistake an inherited property name for a tier', () => {
    expect(resolveModels(['constructor', 'toString'], tiers)).toEqual([{ label: 'constructor', choice: { model: 'constructor' } }, { label: 'toString', choice: { model: 'toString' } }]);
  });
});
