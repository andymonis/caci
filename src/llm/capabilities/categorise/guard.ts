import { err, ok, parseMutation, type JsonValue, type Mutation, type Result } from '../../../graph_store/index.js';
import { type LlmError } from '../../errors.js';
import type { ModelOutput } from '../../model-client.js';
import { rejectionError } from '../../text-blocks.js';
import { CATEGORISE_OPS, type AllowedOp } from './context.js';
import type { CategoriseSettings } from '../../controls/settings.js';

/** What the controller knows and the model must not choose. */
export interface GuardContext {
  readonly graphId: string;
  /** The id the controller minted for the note's item. */
  readonly itemId: string;
  readonly requestId?: string;
  /** How many existing notes the model was shown (R-014); the numbers it may name in `replaces` are 1 to this. 0 or absent means none. */
  readonly existingCount?: number;
}

export interface GuardOptions {
  readonly maxOps?: number;
  /** Largest `data` payload on any op, in UTF-8 bytes. Tighter than the library's default. */
  readonly maxDataBytes?: number;
  readonly maxIdLength?: number;
  /** Longest reply accepted, in characters, checked before any parsing. */
  readonly maxOutputChars?: number;
  readonly maxRationaleChars?: number;
  /** Most existing notes the reply may name in `replaces`. 0 switches replacing off. */
  readonly maxReplaces?: number;
  /** Most fact items one reply may hold (R-015). 1 is exactly one item per note. */
  readonly maxFacts?: number;
  /** Longest fact key, in characters. */
  readonly keyMaxChars?: number;
}

/** What the guard enforces, all of it: it comes from the controls' settings (and per call, from the options), never from constants here. */
export type GuardSettings = Required<GuardOptions>;

/** The guard's settings from the controls, so the guard, the prompt and the schema all follow the same numbers. */
export function guardSettingsOf(settings: CategoriseSettings): GuardSettings {
  return { maxOps: settings.maxOps, maxDataBytes: settings.maxDataBytes, maxIdLength: settings.maxIdLength, maxOutputChars: settings.maxOutputChars, maxRationaleChars: settings.maxRationaleChars, maxReplaces: settings.maxReplaces, maxFacts: settings.maxFacts, keyMaxChars: settings.keyMaxChars };
}

/** A reply that passed every check: a mutation the controller can preview, and the model's reason. */
export interface GuardedReply {
  readonly mutation: Mutation;
  readonly rationale?: string;
  /** The numbers (1 to the count shown) of the existing notes the reply says the new note replaces, ascending, each once. Empty for none. */
  readonly replaces: readonly number[];
}

/** The fields the model may set on each operation. Everything else is the controller's. */
const FIELDS: Readonly<Record<AllowedOp, readonly string[]>> = Object.freeze({
  upsertNode: Object.freeze(['op', 'partition', 'id', 'data']),
  link: Object.freeze(['op', 'item', 'category', 'weight']),
});
const CONTROLLER_FIELDS: readonly string[] = Object.freeze(['mode', 'ensureNodes', 'graphId', 'requestId', 'createIfMissing', 'version', 'kind']);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export { rejectionError };
const unknownKey = (where: string, key: string): string =>
  CONTROLLER_FIELDS.includes(key) ? `${where}: "${key}" is set by the system, not by you; leave it out` : `${where}: unknown field "${key}"`;

function readValue(output: ModelOutput, maxChars: number): Result<unknown, string[]> {
  if (output.kind === 'json') return ok(output.value);
  if (output.text.length > maxChars) return err([`the reply is ${output.text.length} characters, over the limit of ${maxChars}`]);
  try {
    return ok(JSON.parse(output.text) as JsonValue);
  } catch {
    return err(['the reply is not a single JSON object (reply with the JSON only, no other text, no code fences)']);
  }
}

/** Checks everything about the shape of the reply that depends on the controller, collecting every problem. */
function checkShape(value: unknown, context: GuardContext, options: Required<GuardOptions>): { problems: string[]; ops: Array<Record<string, unknown>>; rationale?: string; replaces: number[] } {
  const problems: string[] = [];
  const none = { problems, ops: [] as Array<Record<string, unknown>>, replaces: [] as number[] };
  if (!isObject(value)) return { ...none, problems: ['the reply must be a JSON object like {"ops": [...], "rationale": "..."}'] };
  for (const key of Object.keys(value)) if (key !== 'ops' && key !== 'rationale' && key !== 'replaces') problems.push(unknownKey('reply', key));

  let rationale: string | undefined;
  if ('rationale' in value) {
    if (typeof value.rationale !== 'string') problems.push('rationale: must be text');
    else if (value.rationale.length > options.maxRationaleChars) problems.push(`rationale: ${value.rationale.length} characters, over the limit of ${options.maxRationaleChars}`);
    else if (value.rationale.trim().length > 0) rationale = value.rationale.trim();
  }

  const replaces: number[] = [];
  if ('replaces' in value) {
    const shown = options.maxReplaces > 0 ? (context.existingCount ?? 0) : 0;
    const list = value.replaces;
    if (shown === 0) problems.push('replaces: there are no existing notes to replace here; leave it out');
    else if (!Array.isArray(list)) problems.push('replaces: must be a list of numbers');
    else {
      if (list.length > options.maxReplaces) problems.push(`replaces: ${list.length} numbers, over the limit of ${options.maxReplaces}`);
      const seen = new Set<number>();
      list.forEach((n: unknown, i) => {
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > shown) problems.push(`replaces[${i}]: must be a whole number from 1 to ${shown}`);
        else if (seen.has(n)) problems.push(`replaces[${i}]: ${n} is repeated`);
        else {
          seen.add(n);
          replaces.push(n);
        }
      });
    }
  }
  replaces.sort((a, b) => a - b);

  const { ops } = value;
  if (!Array.isArray(ops)) return { ...none, problems: [...problems, 'ops: must be a list of operations'] };
  if (ops.length === 0) return { ...none, problems: [...problems, 'ops: must contain at least one operation'] };
  if (ops.length > options.maxOps) return { ...none, problems: [...problems, `ops: ${ops.length} operations, over the limit of ${options.maxOps}`] };

  // The facts (R-015): item upserts in order, using the controller's ids: itemId, itemId-2, itemId-3 ...
  const factId = (k: number): string => (k === 1 ? context.itemId : `${context.itemId}-${k}`);
  const facts: string[] = [];
  ops.forEach((op: unknown) => {
    if (isObject(op) && op.op === 'upsertNode' && op.partition === 'item') facts.push(typeof op.id === 'string' ? op.id : '');
  });
  let links = 0;
  const linked = new Set<string>();
  let nextFact = 0;
  ops.forEach((op: unknown, i) => {
    const where = `ops[${i}]`;
    if (!isObject(op)) return void problems.push(`${where}: must be an object`);
    const name = op.op;
    if (typeof name !== 'string' || !(CATEGORISE_OPS as readonly string[]).includes(name)) {
      return void problems.push(`${where}: operation ${JSON.stringify(name)} is not allowed (allowed: ${CATEGORISE_OPS.join(', ')})`);
    }
    const allowed = FIELDS[name as AllowedOp];
    for (const key of Object.keys(op)) if (!allowed.includes(key)) problems.push(unknownKey(where, key));
    if (name === 'upsertNode') {
      if (op.partition === 'item') {
        nextFact++;
        const expected = factId(nextFact);
        if (nextFact <= options.maxFacts && op.id !== expected) problems.push(`${where}: the ${nextFact === 1 ? "note's" : `fact ${nextFact}'s`} item id must be exactly ${JSON.stringify(expected)}`);
        const data = op.data;
        if (isObject(data) && data.key !== undefined) {
          if (typeof data.key !== 'string' || data.key.trim() === '' || [...data.key].length > options.keyMaxChars || /\p{Cc}/u.test(data.key)) problems.push(`${where}: data.key must be 1 to ${options.keyMaxChars} characters of plain text`);
        }
      } else if (op.partition !== 'category') problems.push(`${where}: partition must be "item" or "category"`);
    } else {
      links++;
      if (typeof op.item === 'string') linked.add(op.item);
      if (!facts.includes(op.item as string)) {
        problems.push(options.maxFacts === 1 || facts.length <= 1 ? `${where}: a link's item must be exactly ${JSON.stringify(context.itemId)}` : `${where}: a link's item must be the id of one of this reply's facts`);
      }
      if (op.weight !== undefined && !(typeof op.weight === 'number' && op.weight >= 0 && op.weight <= 1)) problems.push(`${where}: weight must be a number from 0 to 1`);
    }
  });
  if (options.maxFacts === 1) {
    if (facts.length !== 1) problems.push(`there must be exactly one upsertNode for the note's item, found ${facts.length}`);
  } else {
    if (facts.length < 1 || facts.length > options.maxFacts) problems.push(`there must be 1 to ${options.maxFacts} upsertNode operations for items (one per fact), found ${facts.length}`);
    else if (new Set(facts).size !== facts.length) problems.push('two facts use the same item id');
    for (const fact of facts) if (!linked.has(fact)) problems.push(`the fact ${JSON.stringify(fact)} has no link to a category`);
  }
  if (links === 0) problems.push('there must be at least one link from the note to a category');
  return { problems, ops: ops as Array<Record<string, unknown>>, replaces, ...(rationale === undefined ? {} : { rationale }) };
}

/**
 * Checks the model's reply and gives either a mutation the controller can safely preview or the
 * complete list of what was wrong (not just the first few). Pure; never throws. The model only
 * chooses the operations: the graph id, request id, `createIfMissing`, `mode` and `ensureNodes` are
 * always the controller's. Only `upsertNode` and `link` pass, the note's item id is the one the
 * controller minted, and counts and sizes are capped tighter than the library's defaults. Anything
 * unexpected (prose, extra fields, other operations) rejects the whole reply; nothing is repaired
 * or dropped silently.
 */
export function inspectReply(output: ModelOutput, context: GuardContext, options: GuardSettings): Result<GuardedReply, readonly string[]> {
  try {
    const settings = options;
    const raw = readValue(output, settings.maxOutputChars);
    if (!raw.ok) return raw;
    const { problems, ops, rationale, replaces } = checkShape(raw.value, context, settings);
    if (problems.length > 0) return err(problems);

    const parsed = parseMutation(
      {
        version: 1,
        kind: 'mutation',
        graphId: context.graphId,
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
        createIfMissing: false,
        ops: ops.map((op) => (op.op === 'upsertNode' ? { ...op, mode: 'merge' } : { ...op, ensureNodes: false })),
      },
      { limits: { maxOps: settings.maxOps, maxDataBytes: settings.maxDataBytes, maxIdLength: settings.maxIdLength } },
    );
    if (!parsed.ok) {
      const path = parsed.error.path?.length ? `${parsed.error.path.join('.')}: ` : '';
      return err([`${path}${parsed.error.message}`]);
    }
    return ok({ mutation: parsed.value, replaces, ...(rationale === undefined ? {} : { rationale }) });
  } catch {
    return err(['the reply could not be read']);
  }
}

/** Like `inspectReply`, but a rejection is a `BAD_OUTPUT` error whose message numbers the first problems. */
export function guardReply(output: ModelOutput, context: GuardContext, options: GuardSettings): Result<GuardedReply, LlmError> {
  const inspected = inspectReply(output, context, options);
  return inspected.ok ? inspected : err(rejectionError(inspected.error));
}
