// A scripted stand-in for a model that answers every status golden case correctly, so the harness's
// plumbing can be run (in the gate, and with `--scripted`) without a model or a key.

const USAGE = { inputTokens: 900, outputTokens: 120 };
const cut = (text, n) => (text.length <= n ? text : `${text.slice(0, n - 1)}…`);

/** The correct reply: nothing relevant when the case says so, otherwise one point per entry it must cite. */
export function idealStatusReply(caseDef) {
  const { expect = {}, entries } = caseDef;
  // a focused case writes its own ideal answer down (R-018), so what 'good' looks like is part of the case
  if (caseDef.ideal !== undefined) {
    const points = caseDef.ideal.points.map((p) => ({ text: p.text, refs: [...p.refs] }));
    return { headline: caseDef.ideal.headline ?? 'Here is what matters right now.', points, nothing: points.length === 0 };
  }
  if (expect.nothing === true) return { headline: 'Nothing relevant to that.', points: [], nothing: true };
  const cite = (expect.cite ?? []).slice(0, expect.points?.max ?? 5);
  return {
    headline: 'Here is what matters right now.',
    points: cite.map((n) => ({ text: cut(entries[n - 1].text, 200), refs: [n] })),
    nothing: false,
  };
}

/** A script for `createScriptedModelClient` that always gives the ideal reply. */
export const idealStatusScript = (caseDef) => () => ({ reply: JSON.stringify(idealStatusReply(caseDef)), usage: USAGE });
