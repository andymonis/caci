// Text matching shared by the scenario validator, the scoring and the filler check (R-013 D9). Pure.
// Phrases match on whole words after normalising, so "2x Tablet A", "two times tablet a" and "2 x tablet A" are one thing.

const NUMBER_WORDS = Object.freeze({ one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12' });

/** Lower case, numbers as digits, "2x", "2 times" and "2 ×" as "2 x", punctuation and hyphens as spaces. */
export function normalise(text) {
  let t = String(text).normalize('NFKC').toLowerCase().replace(/×/g, ' x ');
  t = t.replace(/[\p{L}]+/gu, (word) => NUMBER_WORDS[word] ?? word);
  t = t.replace(/(\d)\s*(?:x|times)(?![\p{L}])/gu, '$1 x ');
  t = t.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/** The words of a text, each with a trailing plural "s" removed (words of four letters or more, not "ss"). */
export function tokens(text) {
  const n = normalise(text);
  return n === '' ? [] : n.split(' ').map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/** Whether the phrase's words appear one after another in the text's words. An empty phrase never matches. */
export function containsPhrase(textTokens, phraseTokens) {
  if (phraseTokens.length === 0) return false;
  for (let i = 0; i + phraseTokens.length <= textTokens.length; i++) {
    let all = true;
    for (let j = 0; j < phraseTokens.length; j++) {
      if (textTokens[i + j] !== phraseTokens[j]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/** Whether the text holds the phrase. */
export const hasPhrase = (text, phrase) => containsPhrase(tokens(text), tokens(phrase));

/** Whether every group has at least one of its alternatives in the text. */
export const meetsGroups = (text, groups) => {
  const t = tokens(text);
  return groups.every((group) => group.some((alt) => containsPhrase(t, tokens(alt))));
};
