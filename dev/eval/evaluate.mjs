// Pure checks: did one run satisfy one golden case? No I/O, no model, no clock.

const KNOWN_EXPECT = ['reuse', 'avoidReuse', 'mustNotCreate', 'newCategories', 'links'];
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The words of an id: "doctor-visits_2" gives doctor, visits, 2. Matching is by whole word, ignoring case. */
export function wordsOf(id) {
  return String(id).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const inRange = (n, range) => (range?.min === undefined || n >= range.min) && (range?.max === undefined || n <= range.max);
const describeRange = (range) => `${range?.min ?? 0} to ${range?.max ?? 'any'}`;

/**
 * @param caseDef a golden case
 * @param outcome `{ ok: true, summary }` (the preview's summary of the proposal) or `{ ok: false, error }`
 * @returns `{ pass, checks: [{ name, pass, detail }] }`; every check is reported, pass or fail
 */
export function evaluateCase(caseDef, outcome) {
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });

  check('answered', outcome.ok, outcome.ok ? 'a proposal came back' : `${outcome.error?.code ?? 'error'}: ${outcome.error?.message ?? ''}`.trim());
  if (!outcome.ok) return { pass: false, checks };

  const { summary } = outcome;
  const expect = caseDef.expect ?? {};
  check('valid', summary.problems.length === 0, summary.problems.length === 0 ? 'the preview found no problems' : summary.problems.join(' | '));

  for (const id of expect.reuse ?? []) {
    check(`reuses ${id}`, summary.reusedCategories.includes(id), `reused: ${summary.reusedCategories.join(', ') || 'none'}`);
  }
  for (const id of expect.avoidReuse ?? []) {
    check(`avoids ${id}`, !summary.reusedCategories.includes(id), `reused: ${summary.reusedCategories.join(', ') || 'none'}`);
  }
  if ((expect.mustNotCreate ?? []).length > 0) {
    const banned = expect.mustNotCreate.map((w) => w.toLowerCase());
    const offending = summary.newCategories.filter((id) => wordsOf(id).some((w) => banned.includes(w)));
    check(`does not create ${expect.mustNotCreate.join('/')}`, offending.length === 0, offending.length === 0 ? `new: ${summary.newCategories.join(', ') || 'none'}` : `created: ${offending.join(', ')}`);
  }
  if (expect.newCategories !== undefined) {
    const n = summary.newCategories.length;
    check(`new categories ${describeRange(expect.newCategories)}`, inRange(n, expect.newCategories), `created ${n}: ${summary.newCategories.join(', ') || 'none'}`);
  }
  if (expect.links !== undefined) {
    const n = summary.newLinks.length;
    check(`links ${describeRange(expect.links)}`, inRange(n, expect.links), `made ${n}`);
  }
  return { pass: checks.every((c) => c.pass), checks };
}

/** What is wrong with a golden set (an empty list means it is sound). */
export function validateGolden(cases) {
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
    if (typeof c.note !== 'string' || c.note.trim() === '') problems.push(`${where}: note must be non-empty text`);
    if (!Array.isArray(c.categories) || c.categories.some((x) => !isObject(x) || typeof x.id !== 'string' || x.id === '')) {
      problems.push(`${where}: categories must be a list of objects with a text id`);
      continue;
    }
    const ids = new Set(c.categories.map((x) => x.id));
    if (ids.size !== c.categories.length) problems.push(`${where}: duplicate category ids`);
    if (!isObject(c.expect)) {
      problems.push(`${where}: expect must be an object`);
      continue;
    }
    for (const key of Object.keys(c.expect)) if (!KNOWN_EXPECT.includes(key)) problems.push(`${where}: unknown expectation "${key}"`);
    const { reuse = [], avoidReuse = [], mustNotCreate = [], newCategories, links } = c.expect;
    for (const id of [...reuse, ...avoidReuse]) if (!ids.has(id)) problems.push(`${where}: expects something about "${id}", which is not one of its categories`);
    for (const id of reuse) if (avoidReuse.includes(id)) problems.push(`${where}: "${id}" is both reused and avoided`);
    for (const id of mustNotCreate) if (typeof id !== 'string' || id === '' || ids.has(id)) problems.push(`${where}: mustNotCreate "${id}" must be a word that is not an existing category`);
    for (const [name, range] of [['newCategories', newCategories], ['links', links]]) {
      if (range === undefined) continue;
      const bad = !isObject(range) || Object.keys(range).some((k) => k !== 'min' && k !== 'max') || [range.min, range.max].some((v) => v !== undefined && !(Number.isInteger(v) && v >= 0)) || (range.min !== undefined && range.max !== undefined && range.min > range.max);
      if (bad) problems.push(`${where}: ${name} must be { min?, max? } with whole numbers and min not above max`);
    }
    if (links?.max !== undefined && reuse.length > links.max) problems.push(`${where}: reuses ${reuse.length} categories but allows at most ${links.max} links`);
    if (newCategories?.max === 0 && c.categories.length === 0) problems.push(`${where}: no categories exist, so it cannot also forbid creating any`);
  }
  return problems;
}
