import { mkdtempSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import * as app from '../../src/app/index.ts';
import * as anthropic from '../../src/llm/anthropic/index.ts';
import * as llm from '../../src/llm/index.ts';
import * as testing from '../../src/llm/testing/index.ts';
import { parseControls } from '../../src/llm/controls/controls.ts';
import { shippedFiles } from '../../src/llm/testing/shipped-controls.test-util.ts';
import * as controlsFiles from '../../src/service/controls-files.ts';
import { loadControlsOrThrow, withControls } from '../shared/controls.mjs';
import { createApp } from './app.mjs';

void mkdtempSync;
const lib = {
  createLlm: withControls(llm.createLlm, loadControlsOrThrow(controlsFiles)),
  CAPABILITIES: llm.CAPABILITIES,
  MODEL_TIERS: llm.MODEL_TIERS,
  DEFAULT_TIERS: llm.DEFAULT_TIERS,
  DEFAULT_ROUTES: llm.DEFAULT_ROUTES,
  createScriptedModelClient: testing.createScriptedModelClient,
  createAnthropicClient: anthropic.createAnthropicClient,
  summarise: app.summarise,
  describeSummary: app.describeSummary,
};
let lab;
afterEach(async () => {
  await lab?.close();
  lab = undefined;
});
const open = async (options) => {
  lab = createApp(lib, options);
  return `http://127.0.0.1:${await lab.listen(0)}`;
};
const post = async (base, body) => (await fetch(`${base}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const candidate = () => {
  const files = shippedFiles();
  files['categorise/system.txt'] = files['categorise/system.txt'].replace('You are the filing assistant', 'LAB-SENTINEL-ROLE');
  const r = parseControls(files);
  if (!r.ok) throw new Error(r.error.join('; '));
  return r.value;
};

describe('the lab with a candidate controls folder', () => {
  it('uses the candidate for its runs, shows the folder in the status and in every record, and the prompt shows the new wording', async () => {
    const base = await open({ controls: candidate(), controlsLabel: './candidate' });
    const status = await (await fetch(`${base}/api/status`)).json();
    expect(status.value.controls).toBe('./candidate');
    const run = await post(base, { text: 'Saw Dr Patel about a blood test', categories: [{ id: 'health', data: { name: 'Health' } }] });
    expect(run.ok).toBe(true);
    expect(run.value.controls).toBe('./candidate');
    const prompt = run.value.trace.find((e) => e.type === 'prompt');
    expect(prompt.system).toContain('LAB-SENTINEL-ROLE');
  });

  it('without a candidate it uses the shipped controls and says so', async () => {
    const base = await open({});
    const status = await (await fetch(`${base}/api/status`)).json();
    expect(status.value.controls).toBe('the shipped controls/ folder');
    const run = await post(base, { text: 'Saw Dr Patel about a blood test', categories: [] });
    expect(run.value.trace.find((e) => e.type === 'prompt').system).not.toContain('LAB-SENTINEL');
    expect(run.value.controls).toBe('the shipped controls/ folder');
  });
});
