// A scripted stand-in for a model that answers every golden case correctly, so the harness's own
// plumbing can be run (in the gate, and with `--scripted`) without a model or a key.

const USAGE = { inputTokens: 700, outputTokens: 90 };

/** The correct reply for a case: link what must be reused; otherwise a fitting existing category, or make one. */
export function idealReply(caseDef, itemId) {
  const { expect = {}, categories } = caseDef;
  const maxLinks = expect.links?.max ?? 3;
  const ops = [{ op: 'upsertNode', partition: 'item', id: itemId, data: { title: 'Sample note', summary: 'A sample filing.' } }];
  const targets = [];
  const wantsNew = (expect.newCategories?.min ?? 0) > 0;
  for (const id of expect.reuse ?? []) targets.push({ id, isNew: false });
  if (targets.length === 0 && !wantsNew) {
    const avoid = new Set(expect.avoidReuse ?? []);
    const fit = categories.find((c) => !avoid.has(c.id));
    if (fit) targets.push({ id: fit.id, isNew: false });
  }
  if (wantsNew || targets.length === 0) targets.push({ id: 'eval-new-category', isNew: true });
  for (const target of targets.slice(0, Math.max(1, maxLinks))) {
    if (target.isNew) ops.push({ op: 'upsertNode', partition: 'category', id: target.id, data: { name: 'Eval new category' } });
    ops.push({ op: 'link', item: itemId, category: target.id, weight: 0.8 });
  }
  return { ops, rationale: 'The scripted ideal answer.' };
}

/** A script for `createScriptedModelClient` that always gives the ideal reply. */
export const idealScript = (caseDef, itemId) => () => ({ reply: JSON.stringify(idealReply(caseDef, itemId)), usage: USAGE });
