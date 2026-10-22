// Pure checks for `status` runs: did one run satisfy one golden case? No I/O, no model, no clock.

const KNOWN_EXPECT = ['cite', 'avoidCite', 'nothing', 'points', 'forbidden', 'silent', 'mustInclude', 'mustNotMention', 'maxPointChars', 'maxTotalChars'];
const HORIZONS = ['week', 'month', 'year'];
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const inRange = (n, range) => (range?.min === undefined || n >= range.min) && (range?.max === undefined || n <= range.max);
const describeRange = (range) => `${range?.min ?? 0} to ${range?.max ?? 'any'}`;
const numbersIn = (text) => text.match(/\d+/g) ?? [];
/** The numbers a time can be written with: year, month, day, hour and minute, padded or not. */
function numbersOfTime(ms) {
  if (ms === undefined) return [];
  const d = new Date(ms);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()].flatMap((n) => [String(n), String(n).padStart(2, '0')]);
}

/** Each item is a phrase, or alternatives separated by `|` (any one is enough); matched without regard to case. */
const phraseAlternatives = (item) => item.split('|').map((s) => s.trim()).filter(Boolean);
const mentions = (text, item) => phraseAlternatives(item).some((phrase) => text.toLowerCase().includes(phrase.toLowerCase()));
const digitsOf = (day) => (typeof day === 'string' ? day.match(/\d+/g) ?? [] : []);

/** Everything the answer says, as one text. */
const answerText = (answer) => [answer.headline, ...answer.points.map((p) => p.text)].join('\n');

/**
 * @param caseDef a status golden case
 * @param outcome `{ ok: true, answer }` or `{ ok: false, error }`
 * @returns `{ pass, checks: [{ name, pass, detail }] }`; every check is reported, pass or fail
 */
export function evaluateStatusCase(caseDef, outcome, context = {}) {
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
  check('answered', outcome.ok, outcome.ok ? 'an answer came back' : `${outcome.error?.code ?? 'error'}: ${outcome.error?.message ?? ''}`.trim());
  if (!outcome.ok) return { pass: false, checks };

  const { answer } = outcome;
  const expect = caseDef.expect ?? {};
  const cited = new Set(answer.points.flatMap((p) => p.refs));
  const text = answerText(answer);

  // nothing invented: every number in the answer is in the request or in an entry
  // (a focused check also tells the model today's date and the window, so those numbers are known too)
  const windowNumbers = [...numbersOfTime(caseDef.now === undefined ? undefined : Date.parse(caseDef.now)), ...digitsOf(context.window?.fromDay), ...digitsOf(context.window?.toDay)].map((n) => String(Number(n))).flatMap((n) => [n, n.padStart(2, '0')]);
  const known = new Set([...numbersIn(caseDef.request), ...caseDef.entries.flatMap((e) => [...numbersIn(e.text), ...numbersOfTime(e.when)]), ...windowNumbers]);
  const invented = [...new Set(numbersIn(text))].filter((n) => !known.has(n));
  check('invents no numbers', invented.length === 0, invented.length === 0 ? 'every number is in the request or the entries' : `not in the context: ${invented.join(', ')}`);

  for (const n of expect.cite ?? []) check(`cites entry ${n}`, cited.has(n), `cited: ${[...cited].sort((a, b) => a - b).join(', ') || 'none'}`);
  for (const n of expect.avoidCite ?? []) check(`does not cite entry ${n}`, !cited.has(n), `cited: ${[...cited].sort((a, b) => a - b).join(', ') || 'none'}`);
  if (expect.nothing !== undefined) check(expect.nothing ? 'says nothing relevant' : 'finds something relevant', answer.nothing === expect.nothing, `nothing = ${answer.nothing}`);
  if (expect.points !== undefined) check(`points ${describeRange(expect.points)}`, inRange(answer.points.length, expect.points), `made ${answer.points.length}`);
  if ((expect.forbidden ?? []).length > 0) {
    const lower = text.toLowerCase();
    const said = expect.forbidden.filter((w) => lower.includes(w.toLowerCase()));
    check(`does not say ${expect.forbidden.join('/')}`, said.length === 0, said.length === 0 ? 'none of it appears' : `said: ${said.join(', ')}`);
  }
  // focus (R-018): silence, what must and must not be said, and how long the answer is
  if (expect.silent !== undefined) {
    const silent = answer.nothing === true && answer.points.length === 0;
    check(expect.silent ? 'is silent: one line, no points' : 'is not silent', silent === expect.silent, `nothing = ${answer.nothing}, points = ${answer.points.length}`);
  }
  for (const item of expect.mustInclude ?? []) check(`says ${item}`, mentions(text, item), mentions(text, item) ? 'it is there' : 'it is missing');
  for (const item of expect.mustNotMention ?? []) check(`does not mention ${item}`, !mentions(text, item), mentions(text, item) ? 'it is there' : 'it is not there');
  if (expect.maxPointChars !== undefined) {
    const longest = Math.max(0, ...answer.points.map((p) => [...p.text].length));
    check(`each point at most ${expect.maxPointChars} characters`, longest <= expect.maxPointChars, `longest ${longest}`);
  }
  if (expect.maxTotalChars !== undefined) {
    const total = [...text].length;
    check(`the whole answer at most ${expect.maxTotalChars} characters`, total <= expect.maxTotalChars, `${total} characters`);
  }
  return { pass: checks.every((c) => c.pass), checks };
}

/** What is wrong with a status golden set (an empty list means it is sound). */
export function validateStatusGolden(cases) {
  const problems = [];
  if (!Array.isArray(cases) || cases.length === 0) return ['the golden set must be a non-empty list'];
  const seen = new Set();
  for (const [i, c] of cases.entries()) {
    const where = `case ${i + 1}${isObject(c) && typeof c.id === 'string' ? ` (${c.id})` : ''}`;
    if (!isObject(c)) {
      problems.push(`${where}: must be an object`);
      continue;
    }
    if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) problems.push(`${where}: id must be lowercase letters, digits and hyphens`);
    else if (seen.has(c.id)) problems.push(`${where}: duplicate id`);
    else seen.add(c.id);
    if (typeof c.request !== 'string' || c.request.trim() === '') problems.push(`${where}: request must be non-empty text`);
    if (c.horizon !== undefined && !HORIZONS.includes(c.horizon)) problems.push(`${where}: horizon must be week, month or year`);
    if (c.now !== undefined && !(typeof c.now === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(c.now) && Number.isFinite(Date.parse(c.now)))) problems.push(`${where}: now must be a UTC time like 2026-10-22T09:00:00Z`);
    if (c.horizon !== undefined && c.now === undefined) problems.push(`${where}: a focused check needs a now`);
    if (c.timeZone !== undefined && typeof c.timeZone !== 'string') problems.push(`${where}: timeZone must be a time zone name`);
    if (c.ideal !== undefined && !(isObject(c.ideal) && Array.isArray(c.ideal.points) && c.ideal.points.every((p) => isObject(p) && typeof p.text === 'string' && Array.isArray(p.refs) && p.refs.every((n) => Number.isInteger(n) && n >= 1 && n <= (Array.isArray(c.entries) ? c.entries.length : 0))) && (c.ideal.headline === undefined || typeof c.ideal.headline === 'string'))) problems.push(`${where}: ideal must be { headline?, points: [{ text, refs }] } citing entries that exist`);
    if (!Array.isArray(c.entries) || c.entries.some((e) => !isObject(e) || typeof e.where !== 'string' || e.where === '' || typeof e.text !== 'string' || e.text === '' || !(e.when === undefined || Number.isSafeInteger(e.when)))) {
      problems.push(`${where}: entries must be a list of { where, text, when? } with text and a time in milliseconds`);
      continue;
    }
    if (!isObject(c.expect)) {
      problems.push(`${where}: expect must be an object`);
      continue;
    }
    for (const key of Object.keys(c.expect)) if (!KNOWN_EXPECT.includes(key)) problems.push(`${where}: unknown expectation "${key}"`);
    const { cite = [], avoidCite = [], nothing, points, forbidden = [], silent, mustInclude = [], mustNotMention = [], maxPointChars, maxTotalChars } = c.expect;
    if (silent !== undefined && typeof silent !== 'boolean') problems.push(`${where}: silent must be true or false`);
    if (silent === true && (cite.length > 0 || mustInclude.length > 0)) problems.push(`${where}: expects silence but also expects citations or phrases`);
    if (silent === true && nothing === false) problems.push(`${where}: silent contradicts nothing: false`);
    for (const [name, list] of [['mustInclude', mustInclude], ['mustNotMention', mustNotMention]]) {
      if (!Array.isArray(list) || list.some((w) => typeof w !== 'string' || phraseAlternatives(w).length === 0)) problems.push(`${where}: ${name} must be a list of phrases (alternatives separated by |)`);
    }
    for (const [name, v] of [['maxPointChars', maxPointChars], ['maxTotalChars', maxTotalChars]]) if (v !== undefined && !(Number.isInteger(v) && v >= 1)) problems.push(`${where}: ${name} must be a whole number from 1`);
    for (const n of [...cite, ...avoidCite]) if (!Number.isInteger(n) || n < 1 || n > c.entries.length) problems.push(`${where}: entry ${n} does not exist (there are ${c.entries.length})`);
    for (const n of cite) if (avoidCite.includes(n)) problems.push(`${where}: entry ${n} is both cited and avoided`);
    if (nothing !== undefined && typeof nothing !== 'boolean') problems.push(`${where}: nothing must be true or false`);
    if (nothing === true && cite.length > 0) problems.push(`${where}: says nothing is relevant but expects citations`);
    if (!Array.isArray(forbidden) || forbidden.some((w) => typeof w !== 'string' || w === '')) problems.push(`${where}: forbidden must be a list of words`);
    if (points !== undefined) {
      const bad = !isObject(points) || Object.keys(points).some((k) => k !== 'min' && k !== 'max') || [points.min, points.max].some((v) => v !== undefined && !(Number.isInteger(v) && v >= 0)) || (points.min !== undefined && points.max !== undefined && points.min > points.max);
      if (bad) problems.push(`${where}: points must be { min?, max? } with whole numbers and min not above max`);
      else if (points.max !== undefined && cite.length > points.max) problems.push(`${where}: expects ${cite.length} cited entries but allows at most ${points.max} points`);
    }
  }
  return problems;
}
