// Filler (R-013 D13): deterministic, unrelated everyday notes mixed in between a scenario's own notes, to push the brain past
// its context budget and show whether early facts survive volume. Seeded, so the same seed gives the same padded scenario.
import { validateScenario, timeOf } from './scenario.mjs';
import { hasPhrase, tokens } from './text.mjs';

export const MAX_PAD = 1000;

/** mulberry32: a small, well-known seeded generator. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FOOD = ['bread', 'milk', 'eggs', 'apples', 'pasta', 'rice', 'cheese', 'tomatoes', 'oranges', 'butter', 'flour', 'carrots'];
const THING = ['the bins', 'the recycling', 'the washing', 'the car', 'the lawn', 'the windows', 'the shed', 'the bathroom', 'the hallway', 'the garden path', 'the bookshelf', 'the kettle'];
const DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHOW = ['a quiz show', 'a cooking programme', 'a nature documentary', 'a quiz night repeat', 'a gardening programme', 'an old comedy', 'the evening news', 'a cycling race'];
const WEATHER = ['sunny', 'windy', 'foggy', 'cloudy', 'drizzly', 'frosty', 'warm', 'muggy'];
const PLACE = ['the park', 'the canal path', 'the high street', 'the allotment', 'the library', 'the market', 'the garden centre', 'the bakery'];
const JOB = ['paint', 'sandpaper', 'a spare key', 'light bulbs', 'string', 'a torch', 'batteries', 'glue'];
const TEMPLATES = [
  (r) => `Bought ${pick(r, FOOD)} and ${pick(r, FOOD)} at the shop.`,
  (r) => `Put out ${pick(r, THING)} on ${pick(r, DAY)}.`,
  (r) => `Watched ${pick(r, SHOW)} in the evening.`,
  (r) => `A ${pick(r, WEATHER)} day, so a walk around ${pick(r, PLACE)}.`,
  (r) => `Need to pick up ${pick(r, JOB)} when passing ${pick(r, PLACE)}.`,
  (r) => `Cleaned ${pick(r, THING)} and tidied up after lunch.`,
  (r) => `Made soup with ${pick(r, FOOD)} and ${pick(r, FOOD)}; plenty left over.`,
  (r) => `Rang the neighbour about ${pick(r, THING)}; nothing urgent.`,
  (r) => `Library book is due back by ${pick(r, DAY)}.`,
  (r) => `The ${pick(r, WEATHER)} weather meant ${pick(r, THING)} had to wait until ${pick(r, DAY)}.`,
  (r) => `Fancy trying a new recipe with ${pick(r, FOOD)} on ${pick(r, DAY)}.`,
  (r) => `Saw a heron by ${pick(r, PLACE)} this morning.`,
  (r) => `Ran out of ${pick(r, FOOD)} again; add it to the list.`,
  (r) => `Spent the afternoon sorting ${pick(r, THING)} and found ${pick(r, JOB)}.`,
];
const pick = (random, list) => list[Math.floor(random() * list.length)];

/** Words from a distractor question that no filler may contain, so filler cannot answer a question that expects nothing. */
const STOP = new Set(['when', 'what', 'where', 'which', 'does', 'have', 'with', 'that', 'this', 'from', 'your', 'there', 'their', 'about', 'would', 'should', 'could', 'were', 'will']);
const distractorWords = (scenario) =>
  new Set(scenario.questions.filter((q) => q.expectNothing === true).flatMap((q) => tokens(q.ask)).filter((w) => w.length >= 4 && !STOP.has(w)));

/** The phrases no filler may contain: every must and stale phrase of every question. */
const forbiddenPhrases = (scenario) => scenario.questions.flatMap((q) => [...(q.must ?? []).flat(), ...(q.stale ?? [])]);

/** Whether a piece of filler is safe for this scenario. */
export function safeFiller(scenario, text) {
  if (forbiddenPhrases(scenario).some((p) => hasPhrase(text, p))) return false;
  const words = distractorWords(scenario);
  return !tokens(text).some((w) => words.has(w));
}

const minute = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';

/**
 * The scenario with `count` filler notes mixed in between its own notes, dated between their neighbours. The original notes
 * keep their ids, order and dates, so the questions (which name a note to follow) mean the same thing.
 */
export function padScenario(scenario, count, seed = 1) {
  if (!Number.isInteger(count) || count < 0 || count > MAX_PAD) throw new RangeError(`pad must be a whole number from 0 to ${MAX_PAD}`);
  if (!Number.isInteger(seed)) throw new RangeError('seed must be a whole number');
  if (count === 0) return scenario;
  if (scenario.notes.length < 2) throw new RangeError(`scenario ${scenario.id} has fewer than two notes, so there is nowhere between them to put filler`);
  const random = seeded(seed);
  const times = scenario.notes.map((n) => timeOf(n.at));
  const made = [];
  const used = new Set(scenario.notes.map((n) => n.text));
  for (let i = 0; i < count; i++) {
    let text;
    for (let tries = 0; ; tries++) {
      text = TEMPLATES[Math.floor(random() * TEMPLATES.length)](random);
      if (!used.has(text) && safeFiller(scenario, text)) break;
      if (tries > 2000) throw new Error('could not make enough distinct, safe filler notes');
    }
    used.add(text);
    const gap = Math.floor(random() * (scenario.notes.length - 1));
    const lo = Math.ceil(times[gap] / 60_000);
    const hi = Math.floor(times[gap + 1] / 60_000);
    // a whole minute inside the gap; where the gap holds none (notes with seconds a few seconds apart), the earlier note's own time
    const at = lo <= hi ? minute((lo + Math.floor(random() * (hi - lo + 1))) * 60_000) : scenario.notes[gap].at;
    made.push({ id: `pad-${String(i + 1).padStart(4, '0')}`, at, text, gap, time: timeOf(at) });
  }
  const notes = [];
  scenario.notes.forEach((note, g) => {
    notes.push(note);
    for (const f of made.filter((m) => m.gap === g).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))) notes.push({ id: f.id, at: f.at, text: f.text });
  });
  const padded = { ...scenario, notes };
  const problems = validateScenario(padded);
  if (problems.length > 0) throw new Error(`the padded scenario ${scenario.id} is not valid: ${problems.join('; ')}`);
  return padded;
}
