// `npm run eval -- --models fast,balanced,deep`: compare models on the golden set. See README.md.
// The API key (if any) is read here from ANTHROPIC_API_KEY and never printed.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { assertLocalDevelopment } from '../shared/server-kit.mjs';
import { main } from './cli.mjs';

assertLocalDevelopment('The evaluation harness');

const llm = await import('../../dist/llm/index.js');
const testing = await import('../../dist/llm/testing/index.js');
const anthropic = await import('../../dist/llm/anthropic/index.js');
const app = await import('../../dist/app/index.js');

const lib = {
  createLlm: llm.createLlm,
  DEFAULT_TIERS: llm.DEFAULT_TIERS,
  createScriptedModelClient: testing.createScriptedModelClient,
  createAnthropicClient: anthropic.createAnthropicClient,
  readAnthropicKey: anthropic.readAnthropicKey,
  summarise: app.summarise,
};

const controller = new AbortController();
process.once('SIGINT', () => {
  process.stderr.write('\nStopping after the current call…\n');
  controller.abort();
});

const code = await main({
  argv: process.argv.slice(2),
  env: process.env,
  lib,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  signal: controller.signal,
  loadGolden: async (path) => {
    const file = resolve(path);
    if (file.endsWith('.json')) return JSON.parse(await readFile(file, 'utf8'));
    const module = await import(pathToFileURL(file).href);
    return module.GOLDEN ?? module.default;
  },
  save: async (dir, name, json) => {
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
    return path;
  },
});
process.exitCode = code;
