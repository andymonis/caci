import { MODEL_MAX } from './types.js';

/** What one model costs, per million tokens, in the table's currency (R-024 D7). A missing cache price is the plain input price. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** The operator's price table: a date, a currency label, a note and a price per model. The provider's invoice is the truth. */
export interface PriceTable {
  readonly asOf: string;
  readonly currency: string;
  readonly note: string;
  readonly models: Readonly<Record<string, ModelPrice>>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const PRICE_MAX = 100_000;
const isPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= PRICE_MAX;
const isModelName = (v: string): boolean => [...v].length >= 1 && [...v].length <= MODEL_MAX && !/[\s\p{Cc}\p{Cs}]/u.test(v);

/**
 * Checks a price table read from JSON. Every problem is listed, each saying where; nothing is repaired or guessed. Strict: any field
 * that is not listed is refused, so a misspelt price is an error and not silently a missing one.
 */
export function parsePrices(value: unknown): { ok: true; value: PriceTable } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(value)) return { ok: false, problems: ['the price table must be an object'] };
  for (const key of Object.keys(value)) if (!['asOf', 'currency', 'note', 'models'].includes(key)) problems.push(`the price table has no field ${JSON.stringify(key.slice(0, 20))}`);
  const asOf = value.asOf;
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`)) || new Date(`${asOf}T00:00:00Z`).toISOString().slice(0, 10) !== asOf) problems.push('asOf must be a real date written YYYY-MM-DD');
  const currency = value.currency;
  if (typeof currency !== 'string' || !/^[A-Za-z]{1,8}$/.test(currency)) problems.push('currency must be 1 to 8 letters, such as USD');
  const note = value.note;
  if (typeof note !== 'string' || [...note].length > 500) problems.push('note must be text of at most 500 characters');
  const models: Record<string, ModelPrice> = {};
  if (!isObject(value.models)) problems.push('models must be an object of prices by model name');
  else {
    for (const name of Object.keys(value.models)) {
      const entry = value.models[name];
      if (!isModelName(name)) {
        problems.push(`a model name must be 1 to ${MODEL_MAX} characters with no spaces or control characters`);
        continue;
      }
      if (!isObject(entry)) {
        problems.push(`${name}: the prices must be an object`);
        continue;
      }
      for (const key of Object.keys(entry)) if (!['input', 'output', 'cacheRead', 'cacheWrite'].includes(key)) problems.push(`${name}: no field ${JSON.stringify(key.slice(0, 20))}`);
      let good = true;
      for (const key of ['input', 'output'] as const) {
        if (!isPrice(entry[key])) {
          problems.push(`${name}: ${key} must be a number from 0 to ${PRICE_MAX} per million tokens`);
          good = false;
        }
      }
      for (const key of ['cacheRead', 'cacheWrite'] as const) {
        if (own(entry, key) && !isPrice(entry[key])) {
          problems.push(`${name}: ${key} must be a number from 0 to ${PRICE_MAX} per million tokens`);
          good = false;
        }
      }
      if (good) models[name] = Object.freeze({ input: entry.input as number, output: entry.output as number, cacheRead: (entry.cacheRead as number | undefined) ?? (entry.input as number), cacheWrite: (entry.cacheWrite as number | undefined) ?? (entry.input as number) });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: Object.freeze({ asOf: asOf as string, currency: currency as string, note: note as string, models: Object.freeze(models) }) };
}

/** Looks a model up by its exact name, never through the prototype. */
export function priceOf(table: PriceTable, model: string): ModelPrice | undefined {
  return Object.prototype.hasOwnProperty.call(table.models, model) ? table.models[model] : undefined;
}

/** The cost of some tokens at a price: plain input is whatever is not cached, then the two cache counts, then output. */
export function costOf(price: ModelPrice, tokens: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly cacheCreationTokens: number }): number {
  const plain = tokens.inputTokens - tokens.cacheReadTokens - tokens.cacheCreationTokens;
  return (plain * price.input + tokens.cacheReadTokens * price.cacheRead + tokens.cacheCreationTokens * price.cacheWrite + tokens.outputTokens * price.output) / 1_000_000;
}
