import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as anthropic from '../../src/llm/anthropic/index.ts';
import { DEFAULT_TIERS } from '../../src/llm/index.ts';
import { hashOf, main } from './cli.mjs';
import { parseControls } from '../../src/llm/controls/controls.ts';
import { shippedFiles } from '../../src/llm/testing/shipped-controls.test-util.ts';
import { controls, lib as base } from './lib.test-util.mjs';

const KEY = 'sk-ant-api03-BRAIN-EVAL-SECRET-1234567890';
const sc = (id) => ({
  id, title: 't', description: 'd',
  notes: [{ id: 'n1', at: '2026-01-05', text: 'GP prescribed Mum 2 x Tablet A a day.' }, { id: 'n2', at: '2026-01-06', text: 'Bought bread.' }],
  questions: [{ id: 'q1', kind: 'recall', after: 'n2', ask: 'What did the GP prescribe?', must: [['Tablet A']] }],
});

function harness(over = {}) {
  const out = [];
  const err = [];
  const saved = [];
  let clients = 0;
  const io = {
    argv: [],
    env: {},
    lib: { ...base, DEFAULT_TIERS, readAnthropicKey: anthropic.readAnthropicKey, createAnthropicClient: (init) => (clients++, anthropic.createAnthropicClient({ ...init, fetch: async () => { throw new Error('no network in tests'); } })) },
    defaultControls: controls,
    defaultScenarios: 'default-folder',
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    loadScenarios: async (dir) => (dir === 'bad' ? { ok: false, problems: ['x is wrong', 'y is wrong'] } : { ok: true, scenarios: [sc('a'), sc('b')], dir }),
    loadControls: async (dir) => (dir === 'bad-controls' ? { ok: false, problems: ['no frame'] } : { ok: true, value: controls }),
    save: async (dir, name, json) => (saved.push({ dir, name, json }), `${dir}/${name}`),
    now: () => Date.UTC(2026, 9, 14, 12, 0, 0),
    ...over,
  };
  return { io, out, err, saved, clients: () => clients, text: () => out.join(''), errText: () => err.join('') };
}

describe('arguments', () => {
  it('help prints the usage and exits 0', async () => {
    const h = harness({ argv: ['--help'] });
    expect(await main(h.io)).toBe(0);
    expect(h.text()).toContain('Usage: npm run brain-eval');
  });
  it('a bad option exits 2 and says why', async () => {
    const h = harness({ argv: ['--repeat', '0'] });
    expect(await main(h.io)).toBe(2);
    expect(h.errText()).toContain('--repeat');
  });
  it('bad scenarios exit 2 and list every problem', async () => {
    const h = harness({ argv: ['--demo', '--scenarios', 'bad'] });
    expect(await main(h.io)).toBe(2);
    expect(h.errText()).toContain('- x is wrong');
    expect(h.errText()).toContain('- y is wrong');
  });
  it('an unknown scenario in --only exits 2 naming the ones that exist', async () => {
    const h = harness({ argv: ['--demo', '--only', 'zzz'] });
    expect(await main(h.io)).toBe(2);
    expect(h.errText()).toContain('No such scenario: zzz. Scenarios: a, b');
  });
  it('bad controls exit 2 before anything runs', async () => {
    const h = harness({ argv: ['--demo', '--controls', 'bad-controls'] });
    expect(await main(h.io)).toBe(2);
    expect(h.errText()).toContain('- no frame');
    expect(h.saved).toEqual([]);
  });
  it('the default scenario folder is used unless one is given', async () => {
    const seen = [];
    await main(harness({ argv: ['--demo', '--repeat', '1'], }).io);
    const h = harness({ argv: ['--demo', '--repeat', '1', '--scenarios', 'mine'], loadScenarios: async (dir) => (seen.push(dir), { ok: true, scenarios: [sc('a')] }) });
    await main(h.io);
    await main({ ...harness({ argv: ['--demo', '--repeat', '1'] }).io, loadScenarios: async (dir) => (seen.push(dir), { ok: true, scenarios: [sc('a')] }) });
    expect(seen).toEqual(['mine', 'default-folder']);
  });
});

describe('a real run', () => {
  it('without a key exits 1 and creates no client', async () => {
    const h = harness({ argv: [] });
    expect(await main(h.io)).toBe(1);
    expect(h.errText()).toContain('A real run needs a key');
    expect(h.clients()).toBe(0);
  });
  it('without --yes prints the plan and sends nothing, with no client made', async () => {
    const h = harness({ argv: ['--repeat', '2'], env: { ANTHROPIC_API_KEY: KEY } });
    expect(await main(h.io)).toBe(0);
    const t = h.text();
    expect(t).toContain('Controls: the shipped controls/ folder');
    expect(t).toContain('Scenarios: 2 (4 notes, 2 questions)');
    expect(t).toContain('each question asked 2 times of each answering model');
    expect(t).toContain('Planned: about 28 real calls (4 filing, 12 brain answers, 12 replay answers).');
    expect(t).toContain(`files with fast = ${DEFAULT_TIERS.fast}`);
    expect(t).toContain(`answers with deep = ${DEFAULT_TIERS.deep}`);
    expect(t).toContain('Nothing was sent. Add --yes to run it.');
    expect(h.clients()).toBe(0);
    expect(h.saved).toEqual([]);
    expect(t + h.errText()).not.toContain(KEY);
  });
  it('the plan names a candidate controls folder and leaves out the filing line for replay only', async () => {
    const h = harness({ argv: ['--arms', 'replay', '--controls', 'cand'], env: { ANTHROPIC_API_KEY: KEY } });
    await main(h.io);
    expect(h.text()).toContain('Controls: cand');
    expect(h.text()).not.toContain('files with');
  });
  it('with --yes makes exactly one client, runs, never prints or saves the key', async () => {
    const h = harness({ argv: ['--yes', '--only', 'a', '--arms', 'replay', '--answer-with', 'fast'], env: { ANTHROPIC_API_KEY: KEY } });
    expect(await main(h.io)).toBe(0);
    expect(h.clients()).toBe(1);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].json.results[0].error).toMatchObject({ source: 'llm' }); // the stand-in network refuses
    expect(h.text() + h.errText() + JSON.stringify(h.saved)).not.toContain(KEY);
  });
});

const h0 = () => harness().io;

describe('a demo run', () => {
  const run = async (argv = [], over = {}) => {
    const h = harness({ argv: ['--demo', ...argv], ...over });
    const code = await main(h.io);
    return { h, code };
  };
  it('is free, needs no key, makes no real client and refuses --yes', async () => {
    const { h, code } = await run(['--repeat', '1']);
    expect(code).toBe(0);
    expect(h.clients()).toBe(0);
    expect(h.text()).toContain('mode demo');
    expect(await main(harness({ argv: ['--demo', '--yes'] }).io)).toBe(2);
  });
  it('reports, prints progress, and saves the whole record', async () => {
    const { h } = await run(['--repeat', '1', '--answer-with', 'fast,deep']);
    expect(h.text()).toContain('Brain against replay');
    expect(h.text()).toContain('Brain minus replay');
    expect(h.errText()).toContain('Running about');
    expect(h.errText()).toMatch(/\[1\] brain fast · a\/q1: (pass|FAIL)/);
    expect(h.text()).toContain('Saved: brain-eval-results/2026-10-14T12-00-00-000Z-demo.json');
    const { json } = h.saved[0];
    expect(h.saved[0].dir).toBe('brain-eval-results');
    expect(json).toMatchObject({ kind: 'brain-eval', mode: 'demo', controls: null, repeat: 1, arms: ['brain', 'replay'], order: 'oldest-first', windowTokens: 150000, fileWith: 'fast', answerWith: ['fast', 'deep'], aborted: false, startedAt: '2026-10-14T12:00:00.000Z' });
    expect(json.models).toEqual({ fast: DEFAULT_TIERS.fast, deep: DEFAULT_TIERS.deep });
    expect(json.scenarios).toEqual([{ id: 'a', hash: hashOf(sc('a')), notes: 2, questions: [{ id: 'q1', kind: 'recall' }] }, { id: 'b', hash: hashOf(sc('b')), notes: 2, questions: [{ id: 'q1', kind: 'recall' }] }]);
    expect(json.results).toHaveLength(8);
    expect(json.filing).toHaveLength(4);
    expect(json.summary.arms).toEqual(['brain', 'replay']);
  });
  it('the hash changes when the scenario does', () => {
    const other = sc('a');
    other.notes[0].text += '!';
    expect(hashOf(other)).not.toBe(hashOf(sc('a')));
    expect(hashOf(sc('a'))).toMatch(/^[0-9a-f]{16}$/);
  });
  it('options reach the run: out folder, order, window, controls label, arms', async () => {
    const { h } = await run(['--out', 'elsewhere', '--order', 'newest-first', '--window', '1000', '--controls', 'cand', '--arms', 'replay', '--repeat', '1', '--only', 'a']);
    expect(h.saved[0].dir).toBe('elsewhere');
    expect(h.saved[0].json).toMatchObject({ order: 'newest-first', windowTokens: 1000, controls: 'cand', arms: ['replay'] });
    expect(h.text()).toContain('controls cand');
    expect(h.saved[0].json.results.every((r) => r.arm === 'replay')).toBe(true);
  });
  it('--pad runs each scenario once per size, saves the sizes and the seed, and reports the effect', async () => {
    const { h } = await run(['--pad', '0,4', '--seed', '5', '--repeat', '1', '--arms', 'brain', '--answer-with', 'fast', '--only', 'a']);
    const { json } = h.saved[0];
    expect(json).toMatchObject({ pads: [0, 4], seed: 5 });
    expect(json.results.map((r) => r.pad)).toEqual([0, 4]);
    expect(h.text()).toContain('=== 4 filler notes per scenario ===');
    expect(h.text()).toContain('Effect of filler');
  });
  it('--pad on a scenario with one note is refused before anything runs', async () => {
    const one = { ...sc('one'), notes: [sc('one').notes[0]], questions: [{ id: 'q', kind: 'recall', after: 'n1', ask: 'x?', must: [['Tablet A']] }] };
    const h = harness({ argv: ['--demo', '--pad', '3'], loadScenarios: async () => ({ ok: true, scenarios: [one] }) });
    expect(await main(h.io)).toBe(2);
    expect(h.errText()).toContain('Cannot pad one with 3 notes');
    expect(h.saved).toEqual([]);
  });
  it('the plan counts the filler', async () => {
    const h = harness({ argv: ['--pad', '0,10', '--repeat', '1', '--only', 'a'], env: { ANTHROPIC_API_KEY: KEY } });
    await main(h.io);
    expect(h.text()).toContain('Filler: 0, 10 notes per scenario (seed 1)');
    expect(h.text()).toContain('Planned: about 26 real calls (14 filing, 6 brain answers, 6 replay answers).');
  });
  it('--only keeps just that scenario', async () => {
    const { h } = await run(['--only', 'a', '--repeat', '1']);
    expect(new Set(h.saved[0].json.results.map((r) => r.scenario))).toEqual(new Set(['a']));
    expect(h.saved[0].json.scenarios.map((s) => s.id)).toEqual(['a']);
  });
  it('a failing answer is shown as FAIL in the progress', async () => {
    const hard = { ...sc('c'), questions: [{ id: 'q', kind: 'distractor', after: 'n2', ask: 'When is the dentist?', expectNothing: true }] };
    const { h } = await run(['--repeat', '1'], { loadScenarios: async () => ({ ok: true, scenarios: [hard] }) });
    expect(h.errText()).toMatch(/\[1\] brain fast · c\/q: FAIL/);
  });
  it('the chosen controls, order and window reach the model calls', async () => {
    const files = shippedFiles();
    files['status/system.txt'] += '\nSENTINEL-WORDS';
    const parsed = parseControls(files);
    expect(parsed.ok).toBe(true);
    const seen = [];
    const spy = { ...base, createDemoModelClient: () => ({ complete: (req) => (seen.push(req), base.createDemoModelClient().complete(req)) }) };
    const long = { ...sc('a'), notes: [{ id: 'n1', at: '2026-01-05', text: 'first note' }, { id: 'n2', at: '2026-01-06', text: 'second note' }, { id: 'n3', at: '2026-01-07', text: 'z'.repeat(4500) }], questions: [{ id: 'q1', kind: 'recall', after: 'n2', ask: 'which note', must: [['note']] }, { id: 'q2', kind: 'recall', after: 'n3', ask: 'which note', must: [['note']] }] };
    const { h } = await run(['--arms', 'replay', '--answer-with', 'fast', '--repeat', '1', '--controls', 'cand', '--order', 'newest-first', '--window', '1000'], {
      lib: { ...h0().lib, ...spy }, loadControls: async () => ({ ok: true, value: parsed.value }), loadScenarios: async () => ({ ok: true, scenarios: [long] }),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.system.includes('SENTINEL-WORDS'))).toBe(true);
    expect(seen[0].messages[0].content.indexOf('second note')).toBeLessThan(seen[0].messages[0].content.indexOf('first note'));
    const over = h.saved[0].json.results.map((r) => r.overWindow);
    expect(over).toEqual([false, true]);
  });
  it('a stopped run still reports and saves, marked as stopped', async () => {
    const c = new AbortController();
    const h = harness({ argv: ['--demo', '--repeat', '1'], signal: c.signal });
    h.io.stderr = (t) => { h.err.push(t); if (t.startsWith('[1]')) c.abort(); };
    expect(await main(h.io)).toBe(0);
    expect(h.text()).toContain('STOPPED EARLY');
    expect(h.saved[0].json.aborted).toBe(true);
  });
  it('a save that fails is reported and does not fail the run', async () => {
    const { h, code } = await run(['--repeat', '1'], { save: async () => { throw new Error('disk full'); } });
    expect(code).toBe(0);
    expect(h.errText()).toContain('Could not save the results: disk full');
  });
  it('the shipped scenario folder is loaded by run.mjs from a place that exists in the repository', () => {
    expect(readFileSync(new URL('./run.mjs', import.meta.url), 'utf8')).toContain("new URL('./scenarios', import.meta.url)");
  });
});

describe('--compare', () => {
  const saved = { kind: 'brain-eval', startedAt: '2026-10-14T10:00:00.000Z', mode: 'real', repeat: 1, arms: ['brain'], scenarios: [{ id: 'a', hash: 'h', notes: 2, questions: [{ id: 'q1', kind: 'recall' }] }], results: [] };
  const files = { 'one.json': saved, 'two.json': { ...saved, startedAt: '2026-10-15T10:00:00.000Z' }, 'other.json': { ...saved, scenarios: [{ id: 'z', hash: 'h', notes: 2, questions: [] }] } };
  const compare = (argv, over = {}) => {
    const h = harness({ argv, readJson: async (f) => { if (!(f in files)) throw new Error('no such file'); return files[f]; }, loadScenarios: async () => { throw new Error('should not load scenarios'); }, ...over });
    return main(h.io).then((code) => ({ code, h }));
  };
  it('prints the comparison and exits 0 without a key, a model or the scenarios', async () => {
    const { code, h } = await compare(['--compare', 'one.json', 'two.json']);
    expect(code).toBe(0);
    expect(h.text()).toContain('Comparing two brain-eval runs');
    expect(h.saved).toEqual([]);
    expect(h.clients()).toBe(0);
  });
  it('refuses different scenarios with exit 2 unless --force', async () => {
    const refused = await compare(['--compare', 'one.json', 'other.json']);
    expect(refused.code).toBe(2);
    expect(refused.h.errText()).toContain('did not use the same scenarios');
    expect(refused.h.text()).toBe('');
    const forced = await compare(['--compare', 'one.json', 'other.json', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.h.text()).toContain('WARNING (--force)');
  });
  it('a file that cannot be read exits 2 naming it', async () => {
    const { code, h } = await compare(['--compare', 'one.json', 'missing.json']);
    expect(code).toBe(2);
    expect(h.errText()).toContain('Could not read missing.json: no such file');
  });
});
