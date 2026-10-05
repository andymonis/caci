// A stand-in model for the explorer's capture panel, so the whole propose / preview / approve flow can
// be tried without a key or any cost. It reads the real prompt the controller builds (the note's id,
// the note, the existing categories) and answers with a simple, deterministic rule: link the note to the
// categories whose id or name shares a word with it, or create one named after its most common word.
// It is a demonstration, not a classifier. The real model is a switch away (see app.mjs).

const STOPWORDS = new Set(
  ('the and for with that this from have has had was were are not but you your our their about into onto over under again also just need needs want wants ' +
    'will would could should can may might get got make made new one two three four five six next last first then than them they she him her his its ' +
    'been being very more most some any all out off per via').split(' '),
);

const unescapeBlock = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const wordsOf = (text) => String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
const same = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
const capitalise = (word) => word.charAt(0).toUpperCase() + word.slice(1);

/** What the controller put in the prompt: the note's id, the note, and the existing categories. */
export function readRequest(request) {
  const itemId = /The note's own id is "([^"]+)"/.exec(request.system ?? '')?.[1];
  const content = request.messages?.[0]?.content ?? '';
  const note = /<note>\n([\s\S]*?)\n<\/note>/.exec(content)?.[1];
  const block = /<categories>\n([\s\S]*?)\n<\/categories>/.exec(content)?.[1] ?? '';
  const categories = [];
  for (const line of unescapeBlock(block).split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.id === 'string') categories.push(entry);
    } catch {
      // a line that is not an entry (a header or a note about omissions)
    }
  }
  return { itemId, note: note === undefined ? undefined : unescapeBlock(note), categories };
}

/** The reply the demo model gives for a prompt, as the JSON object the controller expects. */
export function demoReply(request) {
  const { itemId, note, categories } = readRequest(request);
  if (itemId === undefined || note === undefined) throw new Error('the prompt is not one the demo model understands');
  const noteWords = wordsOf(note);
  const scored = categories
    .map((c) => {
      const own = [...new Set([...wordsOf(c.id), ...wordsOf(c.data?.name ?? '')])];
      return { id: c.id, links: c.links ?? 0, score: own.filter((w) => noteWords.some((n) => same(n, w))).length };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || b.links - a.links || a.id.localeCompare(b.id))
    .slice(0, 2);

  const words = note.trim().split(/\s+/).filter(Boolean);
  const ops = [
    { op: 'upsertNode', partition: 'item', id: itemId, data: { title: words.slice(0, 8).join(' ').slice(0, 60) || 'Untitled', summary: note.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Empty note' } },
  ];
  let rationale;
  if (scored.length > 0) {
    scored.forEach((c, i) => ops.push({ op: 'link', item: itemId, category: c.id, weight: i === 0 ? 0.9 : 0.6 }));
    rationale = `The note shares words with ${scored.map((c) => `"${c.id}"`).join(' and ')}.`;
  } else {
    const counts = new Map();
    for (const w of noteWords) counts.set(w, (counts.get(w) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))[0]?.[0]?.slice(0, 30);
    const id = (best ?? 'inbox').replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40);
    ops.push({ op: 'upsertNode', partition: 'category', id, data: { name: capitalise(best ?? 'inbox') } }, { op: 'link', item: itemId, category: id, weight: 0.8 });
    rationale = best === undefined ? 'The note has no distinctive words, so it goes to a new "inbox" category.' : `No existing category shares a word with the note, so a new one was made from "${best}".`;
  }
  return { ops, rationale };
}

/** A `ModelClient` that answers with `demoReply`. `lib.createScriptedModelClient` does the request checking and bookkeeping. */
export function createDemoClient(lib) {
  return lib.createScriptedModelClient((request) => ({ reply: JSON.stringify(demoReply(request)), usage: { inputTokens: 400, outputTokens: 60 } }));
}
