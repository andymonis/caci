// Shared by the evaluation tests: the real pieces under test, built from the sources.
import * as app from '../../src/app/index.ts';
import * as anthropic from '../../src/llm/anthropic/index.ts';
import * as llm from '../../src/llm/index.ts';
import * as testing from '../../src/llm/testing/index.ts';

export const lib = {
  createLlm: llm.createLlm,
  DEFAULT_TIERS: llm.DEFAULT_TIERS,
  createScriptedModelClient: testing.createScriptedModelClient,
  createAnthropicClient: anthropic.createAnthropicClient,
  readAnthropicKey: anthropic.readAnthropicKey,
  summarise: app.summarise,
};

export const KEY = 'sk-ant-api03-EVAL-SECRET-KEY-1234567890';

/** A scripted client that answers with a fixed reply for every call. */
export const replying = (reply, usage = { inputTokens: 100, outputTokens: 10 }) =>
  testing.createScriptedModelClient(() => ({ reply: JSON.stringify(reply), usage }));

/** A reply that links the note to one existing category (or makes one when there are none). */
export function lazyReply(caseDef, itemId) {
  const first = caseDef.categories[0]?.id;
  const ops = [{ op: 'upsertNode', partition: 'item', id: itemId, data: { title: 't', summary: 's' } }];
  if (first === undefined) ops.push({ op: 'upsertNode', partition: 'category', id: 'misc', data: { name: 'Misc' } }, { op: 'link', item: itemId, category: 'misc' });
  else ops.push({ op: 'link', item: itemId, category: first });
  return { ops };
}
