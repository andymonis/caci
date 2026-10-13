// Starts the LLM lab against the built library: `npm run dev:lab`.
// The API key (if any) is read here, once, from ANTHROPIC_API_KEY, and handed to the app. It is never printed.
import { resolve } from 'node:path';
import { assertLocalDevelopment, createApp } from './app.mjs';

assertLocalDevelopment();

const llm = await import('../../dist/llm/index.js');
const testing = await import('../../dist/llm/testing/index.js');
const anthropic = await import('../../dist/llm/anthropic/index.js');
const app = await import('../../dist/app/index.js');
const controls = (await import('../shared/controls.mjs')).loadControlsOrThrow(await import('../../dist/service/controls-files.js'));
const { withControls } = await import('../shared/controls.mjs');

const key = anthropic.readAnthropicKey(process.env);
const lib = {
  createLlm: withControls(llm.createLlm, controls),
  CAPABILITIES: llm.CAPABILITIES,
  MODEL_TIERS: llm.MODEL_TIERS,
  DEFAULT_TIERS: llm.DEFAULT_TIERS,
  DEFAULT_ROUTES: llm.DEFAULT_ROUTES,
  createScriptedModelClient: testing.createScriptedModelClient,
  createAnthropicClient: anthropic.createAnthropicClient,
  summarise: app.summarise,
  describeSummary: app.describeSummary,
};

// `--controls DIR` tries a candidate folder of controls; it is checked with the service's own code first
const at = process.argv.indexOf('--controls');
let candidate = {};
if (at !== -1) {
  const dir = process.argv[at + 1];
  if (dir === undefined || dir.startsWith('--')) {
    console.error('--controls needs a folder');
    process.exit(1);
  }
  const loader = await import('../../dist/service/controls-files.js');
  const loaded = loader.loadControlsFolder(resolve(dir));
  if (!loaded.ok) {
    console.error(`The controls in ${dir} are not valid:\n${loaded.error.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  candidate = { controls: loaded.value, controlsLabel: dir };
}

const lab = createApp(lib, { ...(key.ok ? { apiKey: key.value } : {}), ...candidate });
const port = await lab.listen(Number(process.env.LLM_LAB_PORT ?? 4318));
console.log(`LLM lab (local development only): http://127.0.0.1:${port}`);
console.log(key.ok ? 'An API key was found: real calls are possible, but only when a request asks for them explicitly.' : 'No API key found: only the scripted model is available.');
console.log('Run history lives in memory and is lost when this stops. Press Ctrl+C to quit.');
