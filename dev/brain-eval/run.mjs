// `npm run brain-eval`: see README.md. The API key (if any) is read here from ANTHROPIC_API_KEY and never printed or saved.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalDevelopment } from '../shared/server-kit.mjs';
import { loadControlsOrThrow } from '../shared/controls.mjs';
import { main } from './cli.mjs';
import { loadScenarios } from './scenario.mjs';

assertLocalDevelopment('The brain evaluation');

const dist = async (path) => import(`../../dist/${path}`);
const [app, caci, memory, graph, llm, testing, anthropic, users, controlsFiles] = await Promise.all([
  dist('app/index.js'), dist('caci/index.js'), dist('graph_store/adapters/memory/index.js'), dist('graph_store/index.js'), dist('llm/index.js'),
  dist('llm/testing/index.js'), dist('llm/anthropic/index.js'), dist('users/index.js'), dist('service/controls-files.js'),
]);

const lib = {
  createMemoryAdapter: memory.createMemoryAdapter, query: graph.query,
  createUserController: users.createUserController, createMemoryUserStore: users.createMemoryUserStore, createMemorySessionStore: users.createMemorySessionStore,
  createPasswordHasher: users.createPasswordHasher, createLoginThrottle: users.createLoginThrottle, createRegistrationThrottle: users.createRegistrationThrottle,
  createController: app.createController, createItemIdGenerator: app.createItemIdGenerator, createCaciController: caci.createCaciController,
  createLlm: llm.createLlm, createLlmConfig: llm.createLlmConfig, createDemoModelClient: llm.createDemoModelClient, createScriptedModelClient: testing.createScriptedModelClient,
  DEFAULT_TIERS: llm.DEFAULT_TIERS, createAnthropicClient: anthropic.createAnthropicClient, readAnthropicKey: anthropic.readAnthropicKey,
};

const controller = new AbortController();
process.once('SIGINT', () => {
  process.stderr.write('\nStopping after the current call…\n');
  controller.abort();
});

process.exitCode = await main({
  argv: process.argv.slice(2),
  env: process.env,
  lib,
  defaultControls: loadControlsOrThrow(controlsFiles),
  defaultScenarios: fileURLToPath(new URL('./scenarios', import.meta.url)),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  signal: controller.signal,
  loadControls: async (dir) => {
    const result = controlsFiles.loadControlsFolder(resolve(dir));
    return result.ok ? { ok: true, value: result.value } : { ok: false, problems: result.error };
  },
  loadScenarios: async (dir) => loadScenarios(resolve(dir)),
  readJson: async (file) => JSON.parse(await readFile(resolve(file), 'utf8')),
  save: async (dir, name, json) => {
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
    return path;
  },
});
