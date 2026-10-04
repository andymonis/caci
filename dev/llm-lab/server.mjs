// Starts the LLM lab against the built library: `npm run dev:lab`.
// The API key (if any) is read here, once, from ANTHROPIC_API_KEY, and handed to the app. It is never printed.
import { assertLocalDevelopment, createApp } from './app.mjs';

assertLocalDevelopment();

const llm = await import('../../dist/llm/index.js');
const testing = await import('../../dist/llm/testing/index.js');
const anthropic = await import('../../dist/llm/anthropic/index.js');
const app = await import('../../dist/app/index.js');

const key = anthropic.readAnthropicKey(process.env);
const lib = {
  createLlm: llm.createLlm,
  CAPABILITIES: llm.CAPABILITIES,
  MODEL_TIERS: llm.MODEL_TIERS,
  DEFAULT_TIERS: llm.DEFAULT_TIERS,
  DEFAULT_ROUTES: llm.DEFAULT_ROUTES,
  createScriptedModelClient: testing.createScriptedModelClient,
  createAnthropicClient: anthropic.createAnthropicClient,
  summarise: app.summarise,
  describeSummary: app.describeSummary,
};

const lab = createApp(lib, key.ok ? { apiKey: key.value } : {});
const port = await lab.listen(Number(process.env.LLM_LAB_PORT ?? 4318));
console.log(`LLM lab (local development only): http://127.0.0.1:${port}`);
console.log(key.ok ? 'An API key was found: real calls are possible, but only when a request asks for them explicitly.' : 'No API key found: only the scripted model is available.');
console.log('Run history lives in memory and is lost when this stops. Press Ctrl+C to quit.');
