import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as app from '../../src/app/index.ts';
import * as anthropic from '../../src/llm/anthropic/index.ts';
import * as llm from '../../src/llm/index.ts';
import * as testing from '../../src/llm/testing/index.ts';
import { createApp } from './app.mjs';
import { askedLabel, attemptsOf, buildRequest, choiceFrom, compareChoices, compareRows, formatMs, formatTokens, historyLabel, networkSwitch, outputText, parseCategories, promptOf, statusOf } from './public/view.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

/** Real records, from the real server code with the scripted model, so the helpers are tested on what they will actually get. */
async function records(...bodies) {
  const lib = {
    createLlm: llm.createLlm, CAPABILITIES: llm.CAPABILITIES, MODEL_TIERS: llm.MODEL_TIERS, DEFAULT_TIERS: llm.DEFAULT_TIERS, DEFAULT_ROUTES: llm.DEFAULT_ROUTES,
    createScriptedModelClient: testing.createScriptedModelClient, createAnthropicClient: anthropic.createAnthropicClient, summarise: app.summarise, describeSummary: app.describeSummary,
  };
  const lab = createApp(lib);
  const base = `http://127.0.0.1:${await lab.listen(0)}`;
  try {
    const out = [];
    for (const body of bodies) {
      const r = await fetch(`${base}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Saw Dr Patel on Tuesday', categories: [{ id: 'health' }], ...body }) });
      out.push((await r.json()).value);
    }
    return out;
  } finally {
    await lab.close();
  }
}

describe('formatMs', () => {
  it.each([[0, '0 ms'], [12.4, '12 ms'], [999, '999 ms'], [1000, '1.00 s'], [1234, '1.23 s'], [9999, '10.00 s'], [10_000, '10.0 s'], [65_432, '65.4 s']])('%s -> %s', (ms, text) => {
    expect(formatMs(ms)).toBe(text);
  });
  it.each([[undefined], [null], [Number.NaN], [-1], [Infinity], ['5']])('%s is a dash', (ms) => expect(formatMs(ms)).toBe('–'));
});

describe('formatTokens', () => {
  it('says in and out', () => expect(formatTokens({ inputTokens: 600, outputTokens: 80 })).toBe('600 in / 80 out'));
  it.each([[null], [undefined], ['x']])('%s is a dash', (u) => expect(formatTokens(u)).toBe('–'));
});

describe('statusOf', () => {
  it('names accepted, repaired and failed runs', async () => {
    const [good, repaired, refused, rejected] = await records({ scenario: 'good' }, { scenario: 'repaired' }, { scenario: 'refusal' }, { scenario: 'rejected-twice' });
    expect(statusOf(good)).toEqual({ ok: true, label: 'Accepted', detail: '1 attempt' });
    expect(statusOf(repaired)).toEqual({ ok: true, label: 'Accepted after repair', detail: '2 attempts' });
    expect(statusOf(refused)).toMatchObject({ ok: false, label: 'Failed: REFUSED' });
    expect(statusOf(rejected)).toMatchObject({ ok: false, label: 'Failed: BAD_OUTPUT' });
  });
  it('says retryable for errors that are', async () => {
    const [limited] = await records({ scenario: 'rate-limited' });
    expect(statusOf(limited).detail).toMatch(/^retryable\. /);
  });
  it('copes with a record that is not one', () => {
    expect(statusOf(null)).toMatchObject({ ok: false, label: 'Unknown' });
    expect(statusOf({})).toMatchObject({ ok: false });
  });
});

describe('askedLabel', () => {
  it('says what was asked', () => {
    expect(askedLabel({ tier: 'deep' })).toBe('tier deep');
    expect(askedLabel({ model: 'm-1' })).toBe('model m-1');
    expect(askedLabel({ model: 'm-1', tier: 'deep' })).toBe('model m-1');
    expect(askedLabel({})).toBe('default tier');
    expect(askedLabel(undefined)).toBe('default tier');
  });
});

describe('outputText', () => {
  it('shows text as it is and JSON indented', () => {
    expect(outputText({ kind: 'text', text: 'hello' })).toBe('hello');
    expect(outputText({ kind: 'json', value: { a: [1] } })).toBe('{\n  "a": [\n    1\n  ]\n}');
    expect(outputText(null)).toBe('');
    expect(outputText({ kind: 'json', value: undefined })).toBe('');
  });
});

describe('promptOf and attemptsOf on real runs', () => {
  it('finds the prompt in a run', async () => {
    const [record] = await records({ scenario: 'good' });
    const prompt = promptOf(record.trace);
    expect(prompt.system).toContain('"note-lab-1"');
    expect(prompt.user).toContain('<note>');
    expect(prompt.schema.type).toBe('object');
    expect(promptOf([])).toBeNull();
    expect(promptOf(undefined)).toBeNull();
  });

  it('a good run has one accepted attempt', async () => {
    const [record] = await records({ scenario: 'good' });
    const attempts = attemptsOf(record.trace);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt: 1, repairFeedback: null, verdict: { accepted: true, problems: [] }, failure: null });
    expect(attempts[0].output.kind).toBe('json');
    expect(attempts[0].usage).toEqual({ inputTokens: 600, outputTokens: 80 });
    expect(attempts[0].elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('a repaired run has a rejected attempt with problems, then an accepted one carrying the feedback', async () => {
    const [record] = await records({ scenario: 'repaired' });
    const [first, second] = attemptsOf(record.trace);
    expect(first.verdict.accepted).toBe(false);
    expect(first.verdict.problems.join(' ')).toContain('deleteNode');
    expect(first.repairFeedback).toBeNull();
    expect(second.attempt).toBe(2);
    expect(second.repairFeedback).toContain('Reply again with the corrected JSON object only.');
    expect(second.verdict.accepted).toBe(true);
  });

  it('a failed call has a failure and no output or verdict', async () => {
    const [record] = await records({ scenario: 'refusal' });
    const [only] = attemptsOf(record.trace);
    expect(only).toMatchObject({ output: null, verdict: null, failure: { code: 'REFUSED' } });
  });

  it('a call refused before sending has no attempts', async () => {
    const [record] = await records({ text: '   ' });
    expect(attemptsOf(record.trace)).toEqual([]);
  });

  it('joins several prompt messages, in order', () => {
    const trace = [{ type: 'prompt', system: 's', messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }], schema: {} }];
    expect(promptOf(trace).user).toBe('first\n\nsecond');
  });

  it('gives repair feedback to the next attempt only', () => {
    const req = (attempt) => ({ type: 'request', attempt, model: 'm', timeoutMs: 1, messages: [] });
    const trace = [req(1), { type: 'repair', feedback: 'fix it' }, req(2), req(2)];
    expect(attemptsOf(trace).map((a) => a.repairFeedback)).toEqual([null, 'fix it', null]);
  });

  it('copes with an empty or missing trace', () => {
    expect(attemptsOf([])).toEqual([]);
    expect(attemptsOf(undefined)).toEqual([]);
    expect(attemptsOf([{ type: 'verdict', attempt: 1, accepted: true, problems: [] }])).toEqual([]);
  });
});

describe('compareRows', () => {
  it('has one row per run with the figures that matter', async () => {
    const [good, refused] = await records({ scenario: 'good', tier: 'fast' }, { scenario: 'refusal', model: 'm-2' });
    const rows = compareRows([good, refused]);
    expect(rows[0]).toMatchObject({ id: 'run-1', asked: 'tier fast', model: 'claude-haiku-4-5-20251001', ok: true, status: 'Accepted', attempts: 1, tokens: '600 in / 80 out', newCategories: 0, reusedCategories: 1, links: 1, problems: 0 });
    expect(rows[0].rationale).toContain('health');
    expect(rows[1]).toMatchObject({ id: 'run-2', asked: 'model m-2', ok: false, status: 'Failed: REFUSED', attempts: 1, newCategories: null, links: null, problems: null, rationale: null });
  });

  it('counts the problems a preview found', async () => {
    const [record] = await records({ scenario: 'link-missing-category' });
    expect(compareRows([record])[0]).toMatchObject({ ok: true, problems: 1 });
  });
});

describe('historyLabel', () => {
  it('names the run, how it was answered and by which model', async () => {
    const [scripted] = await records({ scenario: 'repaired' });
    expect(historyLabel(scripted)).toBe('run-1 · scripted: repaired · claude-haiku-4-5-20251001');
    expect(historyLabel({ id: 'run-9', mode: 'network', model: 'm' })).toBe('run-9 · real · m');
    expect(historyLabel({ id: 'run-9', mode: 'network', model: null })).toBe('run-9 · real · no model');
  });
});

describe('parseCategories', () => {
  it('reads a list, and nothing as none', () => {
    expect(parseCategories('[{"id":"a"},{"id":"b","data":{"name":"B"}}]')).toEqual({ ok: true, value: [{ id: 'a' }, { id: 'b', data: { name: 'B' } }] });
    expect(parseCategories('')).toEqual({ ok: true, value: [] });
    expect(parseCategories('   \n')).toEqual({ ok: true, value: [] });
    expect(parseCategories(undefined)).toEqual({ ok: true, value: [] });
  });
  it.each([
    ['{', 'Not valid JSON'],
    ['{"id":"a"}', 'Must be a list'],
    ['"a"', 'Must be a list'],
    ['[1]', 'Item 1 needs a text "id"'],
    ['[{"id":"a"},{"id":5}]', 'Item 2 needs a text "id"'],
    ['[{"id":""}]', 'Item 1 needs a text "id"'],
    ['[null]', 'Item 1 needs a text "id"'],
    ['[[]]', 'Item 1 needs a text "id"'],
  ])('refuses %s', (text, message) => {
    const r = parseCategories(text);
    expect(r.ok).toBe(false);
    expect(r.message).toContain(message);
  });
});

describe('choiceFrom', () => {
  it('turns the form into a model choice', () => {
    expect(choiceFrom({ mode: 'default', tier: 'deep', model: 'x' })).toEqual({});
    expect(choiceFrom({ mode: 'tier', tier: 'deep', model: 'x' })).toEqual({ tier: 'deep' });
    expect(choiceFrom({ mode: 'model', tier: 'deep', model: '  my-model ' })).toEqual({ model: 'my-model' });
    expect(choiceFrom({ mode: 'tier', tier: '' })).toEqual({});
    expect(choiceFrom({ mode: 'model' })).toEqual({ model: '' });
  });
});

describe('compareChoices', () => {
  it('lists the ticked tiers, then extra model ids, once each', () => {
    expect(compareChoices({ tiers: ['fast', 'deep'], extraModels: 'a-1, b-2\nc-3  a-1' })).toEqual([{ tier: 'fast' }, { tier: 'deep' }, { model: 'a-1' }, { model: 'b-2' }, { model: 'c-3' }]);
    expect(compareChoices({ tiers: ['fast', 'fast'], extraModels: '' })).toEqual([{ tier: 'fast' }]);
    expect(compareChoices({})).toEqual([]);
    expect(compareChoices({ tiers: [], extraModels: ' , ,, ' })).toEqual([]);
  });
  it('can cut the list to a limit', () => {
    expect(compareChoices({ tiers: ['a', 'b', 'c'], extraModels: 'd', limit: 2 })).toEqual([{ tier: 'a' }, { tier: 'b' }]);
  });
});

describe('buildRequest', () => {
  const form = { capability: 'categorise', text: 'A note', categoriesText: '[{"id":"a"}]', network: false, scenario: 'repaired' };
  it('builds a scripted request', () => {
    expect(buildRequest(form)).toEqual({ ok: true, body: { capability: 'categorise', text: 'A note', categories: [{ id: 'a' }], scenario: 'repaired' } });
  });
  it('builds a real request with no scenario, only when the switch is on', () => {
    expect(buildRequest({ ...form, network: true })).toEqual({ ok: true, body: { capability: 'categorise', text: 'A note', categories: [{ id: 'a' }], network: true } });
    expect(buildRequest({ ...form, network: false }).body).not.toHaveProperty('network');
  });
  it('leaves the scenario out when none is chosen', () => {
    expect(buildRequest({ ...form, scenario: '' }).body).not.toHaveProperty('scenario');
  });
  it('says what is wrong with the form', () => {
    expect(buildRequest({ ...form, text: '   ' })).toEqual({ ok: false, message: 'Write a note first.' });
    expect(buildRequest({ ...form, text: undefined })).toMatchObject({ ok: false });
    expect(buildRequest({ ...form, categoriesText: '[1]' })).toMatchObject({ ok: false, message: expect.stringContaining('Categories: Item 1') });
  });
  it('defaults the capability', () => {
    expect(buildRequest({ ...form, capability: undefined }).body.capability).toBe('categorise');
  });
});

describe('networkSwitch', () => {
  it('is off and disabled, with the reason, when there is no key', () => {
    const sw = networkSwitch({ available: false, on: true });
    expect(sw).toMatchObject({ disabled: true, checked: false, warning: null });
    expect(sw.reason).toContain('ANTHROPIC_API_KEY');
  });
  it('is usable with a key, and warns about cost and what is sent only when on', () => {
    expect(networkSwitch({ available: true, on: false })).toEqual({ disabled: false, checked: false, reason: null, warning: null });
    const on = networkSwitch({ available: true, on: true });
    expect(on).toMatchObject({ disabled: false, checked: true, reason: null });
    expect(on.warning).toContain('costs money');
    expect(on.warning).toContain('Anthropic');
  });
});

describe('the page cannot be turned against its user', () => {
  const sources = readdirSync(publicDir).filter((f) => f.endsWith('.js'));

  it('finds the page scripts (so the checks below cannot pass by looking at nothing)', () => {
    expect(sources.sort()).toEqual(['app.js', 'view.js']);
  });

  it.each(sources)('%s never writes HTML or runs text as code', (file) => {
    const code = readFileSync(join(publicDir, file), 'utf8').replace(/\/\/.*$/gm, '');
    for (const bad of [/\.innerHTML/, /\.outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /setTimeout\s*\(\s*['"`]/, /\.srcdoc/, /DOMParser/]) {
      expect(code, `${file} uses ${bad}`).not.toMatch(bad);
    }
  });

  it('loads nothing from the network: only its own files', () => {
    const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url, url).toMatch(/^\//);
    for (const file of [...sources, 'style.css']) {
      const text = readFileSync(join(publicDir, file), 'utf8');
      expect(text, file).not.toMatch(/https?:\/\/|@import|url\(\s*['"]?(?!data:)/);
    }
  });

  it('every id the script looks up exists in the page', () => {
    const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
    const script = readFileSync(join(publicDir, 'app.js'), 'utf8');
    const wanted = new Set([...script.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
    const present = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
    for (const id of wanted) expect(present.has(id), `#${id} is used by app.js but missing from index.html`).toBe(true);
    expect(wanted.size).toBeGreaterThan(15);
  });

  it('the network switch is in the page and is not checked by default', () => {
    const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
    expect(html).toMatch(/<input type="checkbox" id="network">/);
    expect(html).toContain('uses the network');
  });
});
