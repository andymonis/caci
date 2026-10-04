// Named behaviours for the scripted model, so the lab can show every path through `categorise`
// (a good answer, a repaired one, a rejection, a refusal, a time-out...) without calling a real model.

const USAGE = (n) => ({ inputTokens: 500 + n * 100, outputTokens: 80 });

const item = (itemId) => ({ op: 'upsertNode', partition: 'item', id: itemId, data: { title: 'Sample note', summary: 'A sample filing made by the scripted model.' } });
const category = (id) => ({ op: 'upsertNode', partition: 'category', id, data: { name: id } });
const link = (itemId, categoryId, weight = 0.8) => ({ op: 'link', item: itemId, category: categoryId, weight });

/** What a correct answer looks like for this graph: reuse the first existing category, or make one. */
function goodReply(itemId, categories) {
  const existing = categories[0]?.id;
  return existing === undefined
    ? { ops: [item(itemId), category('inbox'), link(itemId, 'inbox')], rationale: 'There were no categories yet, so a new one was created.' }
    : { ops: [item(itemId), link(itemId, existing)], rationale: `The note fits the existing category "${existing}".` };
}

const badReply = () => ({ ops: [{ op: 'deleteNode', partition: 'item', id: 'someone-elses-note' }, { op: 'dropGraph' }], rationale: 'Trying to do things it is not allowed to do.' });

export const SCENARIOS = Object.freeze({
  good: { description: 'A correct answer on the first try, reusing the first existing category (or creating "inbox").' },
  'good-new-category': { description: 'A correct answer that creates a new category and links to it.' },
  repaired: { description: 'A first answer the guard rejects (a delete, an unknown operation), then a correct one after the repair attempt.' },
  'rejected-twice': { description: 'Two rejected answers in a row: the call ends in BAD_OUTPUT.' },
  'link-missing-category': { description: 'Accepted by the guard, but links to a category that does not exist: the preview reports a problem.' },
  prose: { description: 'Prose instead of JSON: the client reports BAD_OUTPUT (no repair, as there is no reply to correct).' },
  refusal: { description: 'The model declines to answer: REFUSED.' },
  'rate-limited': { description: 'The provider asks to wait 1.5 s: RATE_LIMITED, retryable.' },
  'server-error': { description: 'A provider fault: a retryable MODEL_ERROR.' },
  hangs: { description: 'The provider never answers: the call times out (the lab uses a short limit for this one).' },
});

export const scenarioNames = () => Object.keys(SCENARIOS);
export const isScenario = (name) => Object.hasOwn(SCENARIOS, name);

/** The time limit a scenario needs, when the request does not choose one. */
export const defaultTimeoutMs = (name) => (name === 'hangs' ? 1500 : 30_000);

/** A script (for `createScriptedModelClient`) that acts out a scenario for this note id and these categories. */
export function scenarioScript(name, { itemId, categories }) {
  const reply = (value, n) => ({ reply: JSON.stringify(value), usage: USAGE(n) });
  switch (name) {
    case 'good':
      return (_request, n) => reply(goodReply(itemId, categories), n);
    case 'good-new-category':
      return (_request, n) => reply({ ops: [item(itemId), category('lab-new-category'), link(itemId, 'lab-new-category')], rationale: 'None of the existing categories fit, so a new one was created.' }, n);
    case 'repaired':
      return (_request, n) => (n === 1 ? reply(badReply(), n) : reply(goodReply(itemId, categories), n));
    case 'rejected-twice':
      return (_request, n) => reply(badReply(), n);
    case 'link-missing-category':
      return (_request, n) => reply({ ops: [item(itemId), link(itemId, 'a-category-that-does-not-exist')], rationale: 'Links to a category nobody created.' }, n);
    case 'prose':
      return () => ({ reply: 'Sure! I would file this under Health, with a note about the follow-up.', usage: USAGE(1) });
    case 'refusal':
      return () => ({ refusal: true });
    case 'rate-limited':
      return () => ({ rateLimited: true, retryAfterMs: 1500 });
    case 'server-error':
      return () => ({ serverError: true });
    case 'hangs':
      return () => ({ hang: true });
    default:
      throw new Error(`unknown scenario ${name}`);
  }
}
