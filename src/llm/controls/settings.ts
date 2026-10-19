// The numbers and descriptions in `settings.json` (R-012). Validated here; the prompt, the output schema and the guard
// are all built from the validated object, so they cannot disagree. Pure.

export interface CategoriseSettings {
  readonly maxOps: number;
  readonly maxTextChars: number;
  readonly maxContextChars: number;
  readonly maxDataBytes: number;
  readonly maxIdLength: number;
  readonly maxOutputChars: number;
  readonly maxRationaleChars: number;
  readonly maxReplaces: number;
  /** Most facts (items) one note may be split into (R-015). 1 is one item per note, as before. */
  readonly maxFacts: number;
  readonly keyMaxChars: number;
  readonly titleMaxChars: number;
  readonly summaryMaxChars: number;
  readonly categoryNameMaxChars: number;
  readonly descriptions: { readonly title: string; readonly summary: string; readonly key: string; readonly name: string };
}

export interface StatusSettings {
  readonly maxHeadline: number;
  readonly maxPoints: number;
  readonly maxPointChars: number;
  readonly maxRefs: number;
  readonly maxRequestChars: number;
  readonly maxEntries: number;
  readonly maxEntryChars: number;
  readonly maxTotalChars: number;
  readonly maxOutputChars: number;
  readonly descriptions: { readonly headline: string; readonly pointText: string; readonly refs: string; readonly nothing: string };
}

type Range = readonly [min: number, max: number];

const CATEGORISE_RANGES: Readonly<Record<Exclude<keyof CategoriseSettings, 'descriptions'>, Range>> = Object.freeze({
  maxOps: [1, 100],
  maxTextChars: [1, 100_000],
  maxContextChars: [1, 100_000],
  maxDataBytes: [64, 65_536],
  maxIdLength: [8, 256],
  maxOutputChars: [1000, 200_000],
  maxRationaleChars: [1, 2000],
  maxReplaces: [0, 20],
  maxFacts: [1, 20],
  keyMaxChars: [1, 200],
  titleMaxChars: [1, 500],
  summaryMaxChars: [1, 1000],
  categoryNameMaxChars: [1, 200],
});

const STATUS_RANGES: Readonly<Record<Exclude<keyof StatusSettings, 'descriptions'>, Range>> = Object.freeze({
  maxHeadline: [1, 500],
  maxPoints: [1, 20],
  maxPointChars: [1, 1000],
  maxRefs: [1, 20],
  maxRequestChars: [1, 5000],
  maxEntries: [1, 2000],
  maxEntryChars: [1, 10_000],
  maxTotalChars: [1, 200_000],
  maxOutputChars: [500, 100_000],
});

/** The allowed range of every numeric setting, for the documentation and its tests (the parsers use the same table). */
export const SETTING_RANGES = Object.freeze({ categorise: CATEGORISE_RANGES, status: STATUS_RANGES });

const CATEGORISE_DESCRIPTIONS = ['title', 'summary', 'key', 'name'] as const;
const STATUS_DESCRIPTIONS = ['headline', 'pointText', 'refs', 'nothing'] as const;
export const MAX_DESCRIPTION_CHARS = 300;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const quote = (token: string): string => JSON.stringify(token.length > 20 ? `${token.slice(0, 19)}…` : token);

function readNumbers(file: string, data: Record<string, unknown>, ranges: Readonly<Record<string, Range>>, problems: string[]): void {
  for (const [name, [min, max]] of Object.entries(ranges)) {
    const value = data[name];
    if (value === undefined) problems.push(`${file}: "${name}" is missing`);
    else if (typeof value !== 'number' || !Number.isSafeInteger(value)) problems.push(`${file}: "${name}" must be a whole number`);
    else if (value < min || value > max) problems.push(`${file}: "${name}" is ${value}, outside ${min} to ${max}`);
  }
}

function readDescriptions(file: string, data: Record<string, unknown>, names: readonly string[], problems: string[]): void {
  const d = data.descriptions;
  if (!isObject(d)) {
    problems.push(`${file}: "descriptions" must be an object with ${names.map((n) => `"${n}"`).join(', ')}`);
    return;
  }
  for (const key of Object.keys(d)) if (!names.includes(key)) problems.push(`${file}: "descriptions" has an unknown entry ${quote(key)}`);
  for (const name of names) {
    const value = d[name];
    if (typeof value !== 'string') problems.push(`${file}: descriptions."${name}" must be text`);
    else if (value.trim() === '' || value.length > MAX_DESCRIPTION_CHARS) problems.push(`${file}: descriptions."${name}" must be 1 to ${MAX_DESCRIPTION_CHARS} characters`);
    else if (/\p{Cc}/u.test(value)) problems.push(`${file}: descriptions."${name}" must be one line without control characters`);
  }
}

function parseJson(file: string, source: unknown, allowed: readonly string[]): { data?: Record<string, unknown>; problems: string[] } {
  if (typeof source !== 'string') return { problems: [`${file}: must be text`] };
  if (source.length > 16_000) return { problems: [`${file}: ${source.length} characters, over the limit of 16000`] };
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return { problems: [`${file}: is not valid JSON`] };
  }
  if (!isObject(data)) return { problems: [`${file}: must be a JSON object`] };
  const problems: string[] = [];
  for (const key of Object.keys(data)) if (!allowed.includes(key)) problems.push(`${file}: unknown setting ${quote(key)}`);
  return { data, problems };
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly string[] };

export function parseCategoriseSettings(file: string, source: unknown): Parsed<CategoriseSettings> {
  const { data, problems } = parseJson(file, source, [...Object.keys(CATEGORISE_RANGES), 'descriptions']);
  if (data === undefined) return { ok: false, problems };
  readNumbers(file, data, CATEGORISE_RANGES, problems);
  readDescriptions(file, data, CATEGORISE_DESCRIPTIONS, problems);
  if (problems.length > 0) return { ok: false, problems };
  const s = data as unknown as CategoriseSettings;
  if (4 * (s.titleMaxChars + s.summaryMaxChars) + 64 > s.maxDataBytes) problems.push(`${file}: "maxDataBytes" (${s.maxDataBytes}) is too small for a title and summary of the allowed lengths (it needs at least ${4 * (s.titleMaxChars + s.summaryMaxChars) + 64})`);
  if (4 * (s.titleMaxChars + s.summaryMaxChars + s.keyMaxChars) + 96 > s.maxDataBytes) problems.push(`${file}: "maxDataBytes" (${s.maxDataBytes}) is too small for a fact (title, summary and key) of the allowed lengths (it needs at least ${4 * (s.titleMaxChars + s.summaryMaxChars + s.keyMaxChars) + 96})`);
  if (2 * s.maxFacts > s.maxOps) problems.push(`${file}: "maxOps" (${s.maxOps}) is too small for "maxFacts" (${s.maxFacts}): each fact needs an item and a link, so at least ${2 * s.maxFacts}`);
  const needOut = s.maxFacts * (s.titleMaxChars + s.summaryMaxChars + s.keyMaxChars + 400);
  if (needOut > s.maxOutputChars) problems.push(`${file}: "maxOutputChars" (${s.maxOutputChars}) is too small for the longest reply the other limits allow (it needs at least ${needOut})`);
  if (s.categoryNameMaxChars * 4 + 32 > s.maxDataBytes) problems.push(`${file}: "maxDataBytes" (${s.maxDataBytes}) is too small for a category name of the allowed length (it needs at least ${s.categoryNameMaxChars * 4 + 32})`);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: Object.freeze({ ...s, descriptions: Object.freeze({ ...s.descriptions }) }) };
}

export function parseStatusSettings(file: string, source: unknown): Parsed<StatusSettings> {
  const { data, problems } = parseJson(file, source, [...Object.keys(STATUS_RANGES), 'descriptions']);
  if (data === undefined) return { ok: false, problems };
  readNumbers(file, data, STATUS_RANGES, problems);
  readDescriptions(file, data, STATUS_DESCRIPTIONS, problems);
  if (problems.length > 0) return { ok: false, problems };
  const s = data as unknown as StatusSettings;
  const need = s.maxHeadline + s.maxPoints * (s.maxPointChars + 12 * s.maxRefs + 30) + 100;
  if (need > s.maxOutputChars) problems.push(`${file}: "maxOutputChars" (${s.maxOutputChars}) is too small for the longest reply the other limits allow (it needs at least ${need})`);
  if (s.maxEntryChars > s.maxTotalChars) problems.push(`${file}: "maxEntryChars" (${s.maxEntryChars}) is more than "maxTotalChars" (${s.maxTotalChars})`);
  if (s.maxRefs > s.maxEntries) problems.push(`${file}: "maxRefs" (${s.maxRefs}) is more than "maxEntries" (${s.maxEntries})`);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: Object.freeze({ ...s, descriptions: Object.freeze({ ...s.descriptions }) }) };
}
