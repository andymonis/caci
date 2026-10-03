// A manual check of the Anthropic client against the real API. NOT part of the gate: it needs a key,
// costs a small amount, and sends the sample note below to Anthropic.
//
//   ANTHROPIC_API_KEY=... npm run llm:try
//   ANTHROPIC_API_KEY=... npm run llm:try -- --tier balanced
//   ANTHROPIC_API_KEY=... npm run llm:try -- --model claude-haiku-4-5-20251001 --text "Dentist Friday 9am"
//
// The key is read here, from the environment, and handed to the client; it is never printed.

import { createLlm } from '../dist/llm/index.js';
import { createAnthropicClient, readAnthropicKey } from '../dist/llm/anthropic/index.js';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

const key = readAnthropicKey(process.env);
if (!key.ok) {
  console.error(`Cannot run: ${key.error.message}. Set it in your shell, not in a file in this repo.`);
  process.exit(1);
}

const tier = option('tier');
const model = option('model');
const text = option('text') ?? 'Saw Dr Patel on Tuesday about the blood test results. Need to book a follow-up in six weeks.';
const categories = [
  { id: 'health', data: { name: 'Health' }, linkCount: 12 },
  { id: 'appointments', data: { name: 'Appointments' }, linkCount: 7 },
  { id: 'errands', data: { name: 'Errands' }, linkCount: 3 },
];

const llm = createLlm({ client: createAnthropicClient({ apiKey: key.value }) });
console.log(`Sending one sample note to Anthropic${model ? ` (model ${model})` : tier ? ` (tier ${tier})` : ' (default tier for categorise)'}...`);

const started = Date.now();
const result = await llm.categorise(
  { text, graphId: 'try', itemId: 'note-try-1', categories },
  { ...(model ? { model } : {}), ...(tier ? { tier } : {}), timeoutMs: 60_000 },
);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (!result.ok) {
  console.error(`Failed after ${seconds}s: ${result.error.code}${result.error.retryable ? ' (retryable)' : ''}: ${result.error.message}`);
  process.exit(2);
}
const { mutation, rationale, usage, model: answered, attempts } = result.value;
console.log(`Answered by ${answered} in ${seconds}s, ${attempts} attempt(s), ${usage.inputTokens} tokens in, ${usage.outputTokens} out.`);
if (rationale) console.log(`Why: ${rationale}`);
console.log('Proposed operations:');
for (const op of mutation.ops) console.log(`  ${JSON.stringify(op)}`);
