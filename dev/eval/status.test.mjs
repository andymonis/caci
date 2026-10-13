import { describe, expect, it } from 'vitest';
import * as testing from '../../src/llm/testing/index.ts';
import { main } from './cli.mjs';
import { lib } from './helpers.test-util.mjs';
import { evaluateStatusCase, validateStatusGolden } from './status-evaluate.mjs';
import { STATUS_GOLDEN } from './status-golden.mjs';
import { runStatusEval } from './status-runner.mjs';
import { idealStatusReply, idealStatusScript } from './status-scripted.mjs';

const byId = (id) => STATUS_GOLDEN.find((c) => c.id === id);
const answer = (extra = {}) => ({ headline: 'H', points: [{ text: 'A point', refs: [1] }], nothing: false, ...extra });
const ok = (a) => ({ ok: true, answer: answer(a) });
const failedNames = (v) => v.checks.filter((c) => !c.pass).map((c) => c.name);
const CASE = { id: 'c', request: 'status 5', entries: [{ where: 'w', text: 'Dentist at 10:00', when: Date.UTC(2026, 9, 13, 8, 5) }, { where: 'w', text: 'Other' }], expect: {} };

describe('the golden set is sound and covers what it should', () => {
  it('validates', () => expect(validateStatusGolden(STATUS_GOLDEN)).toEqual([]));
  it('has the six cases the plan asks for', () => {
    expect(STATUS_GOLDEN.map((c) => c.id)).toEqual(['morning-check', 'heading-into-town', 'nothing-relevant', 'many-entries', 'hidden-instruction', 'conflicting-circles']);
    expect(byId('many-entries').entries.length).toBeGreaterThan(50);
    expect(byId('hidden-instruction').expect.forbidden).toEqual(['PWNED']);
    expect(byId('nothing-relevant').expect.nothing).toBe(true);
  });
  it('is frozen', () => expect(Object.isFrozen(STATUS_GOLDEN)).toBe(true));
});

describe('validateStatusGolden finds what is wrong', () => {
  const bad = (change) => validateStatusGolden([{ ...CASE, expect: {}, ...change }]);
  it.each([
    ['not a list', null, 'non-empty list'],
    ['empty list', [], 'non-empty list'],
  ])('%s', (_n, input, text) => expect(validateStatusGolden(input)[0]).toContain(text));
  it.each([
    [{ id: 'Bad Id' }, 'id must be lowercase'],
    [{ request: ' ' }, 'request must be non-empty'],
    [{ entries: [{ where: '', text: 't' }] }, 'entries must be a list'],
    [{ entries: [{ where: 'w', text: '' }] }, 'entries must be a list'],
    [{ entries: [{ where: 'w', text: 't', when: 'Tue' }] }, 'entries must be a list'],
    [{ entries: 'x' }, 'entries must be a list'],
    [{ expect: 5 }, 'expect must be an object'],
    [{ expect: { wat: 1 } }, 'unknown expectation "wat"'],
    [{ expect: { cite: [3] } }, 'entry 3 does not exist'],
    [{ expect: { avoidCite: [0] } }, 'entry 0 does not exist'],
    [{ expect: { cite: [1], avoidCite: [1] } }, 'both cited and avoided'],
    [{ expect: { nothing: 'yes' } }, 'nothing must be true or false'],
    [{ expect: { nothing: true, cite: [1] } }, 'expects citations'],
    [{ expect: { forbidden: [''] } }, 'forbidden must be a list'],
    [{ expect: { points: { min: 3, max: 1 } } }, 'points must be'],
    [{ expect: { points: { lots: 1 } } }, 'points must be'],
    [{ expect: { cite: [1, 2], points: { max: 1 } } }, 'allows at most 1 points'],
  ])('%j', (change, text) => expect(bad(change).join('\n')).toContain(text));
  it('duplicate ids and non-objects', () => {
    expect(validateStatusGolden([CASE, CASE]).join('\n')).toContain('duplicate id');
    expect(validateStatusGolden([5])[0]).toContain('must be an object');
  });
});

describe('evaluateStatusCase', () => {
  it('a failed call fails alone', () => {
    const v = evaluateStatusCase(CASE, { ok: false, error: { code: 'TIMEOUT', message: 'slow' } });
    expect(v).toEqual({ pass: false, checks: [{ name: 'answered', pass: false, detail: 'TIMEOUT: slow' }] });
  });
  it('invented numbers fail, numbers from the request or the entries pass, and dates in entries count', () => {
    const c = { ...CASE, expect: {} };
    expect(failedNames(evaluateStatusCase(c, ok({ headline: 'It is 99', points: [] })))).toEqual(['invents no numbers']);
    expect(evaluateStatusCase(c, ok({ headline: 'at 10:00 on 13 Oct 2026, status 5, made 08:05, 8:5', points: [] })).pass).toBe(true);
    expect(evaluateStatusCase(c, ok({ points: [{ text: 'Meeting at 77', refs: [1] }] })).checks.find((x) => x.name === 'invents no numbers').detail).toBe('not in the context: 77');
  });
  it('a number from the request counts, and the month of a time is written as people write it', () => {
    const c = { ...CASE, request: 'room 4242', entries: [{ where: 'w', text: 'x', when: Date.UTC(2026, 10, 21, 3, 7) }], expect: {} };
    expect(evaluateStatusCase(c, ok({ headline: 'room 4242', points: [] })).pass).toBe(true);
    expect(evaluateStatusCase(c, ok({ headline: 'on 21 11 2026 at 03:07 or 3:7', points: [] })).pass).toBe(true);
    expect(failedNames(evaluateStatusCase(c, ok({ headline: 'month 10', points: [] })))).toEqual(['invents no numbers']);
  });
  it('cite and avoidCite', () => {
    const c = { ...CASE, expect: { cite: [1], avoidCite: [2] } };
    expect(evaluateStatusCase(c, ok()).pass).toBe(true);
    expect(failedNames(evaluateStatusCase(c, ok({ points: [{ text: 'x', refs: [2] }] })))).toEqual(['cites entry 1', 'does not cite entry 2']);
  });
  it('nothing, both ways', () => {
    expect(failedNames(evaluateStatusCase({ ...CASE, expect: { nothing: true } }, ok()))).toEqual(['says nothing relevant']);
    expect(evaluateStatusCase({ ...CASE, expect: { nothing: true } }, ok({ points: [], nothing: true })).pass).toBe(true);
    expect(failedNames(evaluateStatusCase({ ...CASE, expect: { nothing: false } }, ok({ points: [], nothing: true })))).toEqual(['finds something relevant']);
  });
  it('the number of points', () => {
    const c = { ...CASE, expect: { points: { min: 1, max: 1 } } };
    expect(evaluateStatusCase(c, ok()).pass).toBe(true);
    expect(failedNames(evaluateStatusCase(c, ok({ points: [] })))).toEqual(['points 1 to 1']);
    expect(failedNames(evaluateStatusCase(c, ok({ points: [{ text: 'a', refs: [1] }, { text: 'b', refs: [1] }] })))).toEqual(['points 1 to 1']);
  });
  it('forbidden words are found in the headline or a point, whatever the case', () => {
    const c = { ...CASE, expect: { forbidden: ['PWNED'] } };
    expect(evaluateStatusCase(c, ok()).pass).toBe(true);
    expect(failedNames(evaluateStatusCase(c, ok({ headline: 'pwned!' })))).toEqual(['does not say PWNED']);
    expect(failedNames(evaluateStatusCase(c, ok({ points: [{ text: 'You are Pwned', refs: [1] }] })))).toEqual(['does not say PWNED']);
  });
});

// three deliberately bad models
const reply = (r) => () => testing.createScriptedModelClient(() => ({ reply: JSON.stringify(r), usage: { inputTokens: 10, outputTokens: 5 } }));
const inventor = reply({ headline: 'It is 99 degrees', points: [{ text: 'Meeting at 99:99', refs: [1] }], nothing: false });
const alwaysNothing = reply({ headline: 'Nothing.', points: [], nothing: true });
const citesEverything = ({ caseDef }) => testing.createScriptedModelClient(() => ({ reply: JSON.stringify({ headline: 'Everything.', points: caseDef.entries.slice(0, 5).map((e, i) => ({ text: e.text.slice(0, 200), refs: [i + 1] })), nothing: false }), usage: { inputTokens: 10, outputTokens: 5 } }));
const MODELS = [{ label: 'm', choice: { tier: 'fast' } }];
const runWith = (makeClient) => runStatusEval({ lib, cases: STATUS_GOLDEN, models: MODELS, makeClient, now: (() => { let t = 0; return () => (t += 5); })() });

describe('the ideal model passes everything, and the bad ones are caught', () => {
  it('the ideal scripted model passes all six', async () => {
    const { results, aborted } = await runWith(({ caseDef }) => testing.createScriptedModelClient(idealStatusScript(caseDef)));
    expect(aborted).toBe(false);
    expect(results.map((r) => [r.caseId, r.pass])).toEqual(STATUS_GOLDEN.map((c) => [c.id, true]));
    for (const r of results) expect(r).toMatchObject({ error: null, attempts: 1, repaired: false, tokens: { inputTokens: 900, outputTokens: 120 }, answeredBy: expect.any(String) });
  });
  it('the ideal reply respects the most points a case allows and keeps each point short', () => {
    const long = 'word '.repeat(100);
    const c = { id: 'x', request: 'r', entries: [{ where: 'w', text: long }, { where: 'w', text: 'b' }, { where: 'w', text: 'c' }], expect: { cite: [1, 2, 3], points: { max: 2 } } };
    const r = idealStatusReply(c);
    expect(r.points.map((p) => p.refs)).toEqual([[1], [2]]);
    expect(r.points[0].text.length).toBeLessThanOrEqual(200);
    expect(idealStatusReply({ ...c, expect: { cite: [1], points: { max: 5 } } }).points[0].text.endsWith('…')).toBe(true);
  });
  it('a run that needed the repair attempt is marked repaired with two attempts', async () => {
    const { results } = await runStatusEval({
      lib,
      cases: [STATUS_GOLDEN[0]],
      models: MODELS,
      makeClient: ({ caseDef }) => testing.createScriptedModelClient((_r, n) => ({ reply: n === 1 ? JSON.stringify({ headline: '', points: [], nothing: false }) : JSON.stringify(idealStatusReply(caseDef)), usage: { inputTokens: 1, outputTokens: 1 } })),
    });
    expect(results[0]).toMatchObject({ pass: true, attempts: 2, repaired: true });
  });
  it('the chosen model reaches the client: an exact model id is asked for by name', async () => {
    const asked = [];
    await runStatusEval({ lib, cases: [STATUS_GOLDEN[0]], models: [{ label: 'mine', choice: { model: 'my-exact-model' } }], makeClient: ({ caseDef }) => testing.createScriptedModelClient((request) => (asked.push(request.model), { reply: JSON.stringify(idealStatusReply(caseDef)), usage: { inputTokens: 1, outputTokens: 1 } })) });
    expect(asked).toEqual(['my-exact-model']);
  });
  it('the ideal reply for each case is valid for the real guard (that is what passing proves)', () => {
    for (const c of STATUS_GOLDEN) expect(idealStatusReply(c).points.length).toBeLessThanOrEqual(5);
  });
  it.each([
    ['one that invents numbers', inventor, 5],
    ['one that always says nothing is relevant', alwaysNothing, 5],
    ['one that cites everything', citesEverything, 2],
  ])('%s fails many cases', async (_n, make, atLeast) => {
    const { results } = await runWith(make);
    expect(results.filter((r) => !r.pass).length).toBeGreaterThanOrEqual(atLeast);
  });
  it('the one that cites everything is caught on the nothing-relevant case and on the hidden instruction', async () => {
    const { results } = await runWith(citesEverything);
    const failed = results.filter((r) => !r.pass).map((r) => r.caseId);
    expect(failed).toContain('nothing-relevant');
    expect(failed).toContain('hidden-instruction');
  });
  it('a model that cannot answer is recorded as a failed run with its error and tokens', async () => {
    const { results } = await runWith(() => testing.createScriptedModelClient(() => ({ reply: 'not json', usage: { inputTokens: 7, outputTokens: 3 } })));
    expect(results[0]).toMatchObject({ pass: false, error: { code: 'BAD_OUTPUT' }, proposal: null, answeredBy: null });
    expect(results[0].tokens).toEqual({ inputTokens: expect.any(Number), outputTokens: expect.any(Number) });
  });
  it('stops between calls when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runStatusEval({ lib, cases: STATUS_GOLDEN, models: MODELS, makeClient: () => alwaysNothing({}), signal: controller.signal });
    expect(r).toEqual({ results: [], aborted: true });
  });
});

async function run(argv, extra = {}) {
  const out = [];
  const err = [];
  const saved = [];
  const code = await main({
    argv,
    env: extra.env ?? {},
    lib,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    loadGolden: extra.loadGolden ?? (async () => { throw new Error('none'); }),
    save: async (dir, name, json) => (saved.push({ dir, name, json }), `${dir}/${name}`),
  });
  return { code, out: out.join(''), err: err.join(''), saved };
}

describe('npm run eval -- --capability status', () => {
  it('--scripted runs the six cases on every model, all pass, and saves under a status name', async () => {
    const r = await run(['--capability', 'status', '--scripted']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('18 done');
    expect(r.out).toContain('100% (6/6)');
    expect(r.out).toContain('morning-check');
    expect(r.saved).toHaveLength(1);
    expect(r.saved[0].name).toMatch(/-status-scripted\.json$/);
    expect(r.saved[0].json).toMatchObject({ capability: 'status', mode: 'scripted' });
    expect(r.saved[0].json.cases).toEqual(STATUS_GOLDEN.map((c) => c.id));
  });
  it('--only picks cases and a wrong id lists the right ones', async () => {
    expect((await run(['--capability', 'status', '--scripted', '--only', 'morning-check', '--models', 'fast'])).out).toContain('1 done');
    const bad = await run(['--capability', 'status', '--scripted', '--only', 'doctor-followup']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('morning-check');
  });
  it('a real run without --yes plans and sends nothing, saying what would be sent', async () => {
    const r = await run(['--capability', 'status'], { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-EVAL-SECRET-KEY-1234567890' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Planned: 6 cases × 3 models × 1 run = 18 real calls.');
    expect(r.out).toContain('sends the requests and notes in the golden set to Anthropic');
    expect(r.out).toContain('Nothing was sent.');
    expect(r.saved).toEqual([]);
    expect(r.out + r.err).not.toContain('EVAL-SECRET');
  });
  it('a golden set of the wrong kind is refused with its problems', async () => {
    const r = await run(['--capability', 'status', '--scripted', '--golden', 'x.json'], { loadGolden: async () => [{ id: 'a', note: 'categorise-shaped', categories: [], expect: {} }] });
    expect(r.code).toBe(2);
    expect(r.err).toContain('request must be non-empty');
  });
  it('the categorise path is unchanged', async () => {
    const r = await run(['--scripted']);
    expect(r.saved[0].name).toMatch(/-scripted\.json$/);
    expect(r.saved[0].name).not.toContain('status');
  });
});
