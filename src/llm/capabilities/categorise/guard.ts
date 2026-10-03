import { err, ok, parseMutation, type JsonValue, type Mutation, type Result } from '../../../graph_store/index.js';
import { llmError, type LlmError } from '../../errors.js';
import type { ModelOutput } from '../../model-client.js';
import { CATEGORISE_OPS, type AllowedOp } from './context.js';
import { DEFAULT_PROMPT_OPTIONS } from './prompt.js';

/** What the controller knows and the model must not choose. */
export interface GuardContext {
  readonly graphId: string;
  /** The id the controller minted for the note's item. */
  readonly itemId: string;
  readonly requestId?: string;
}

export interface GuardOptions {
  readonly maxOps?: number;
  /** Largest `data` payload on any op, in UTF-8 bytes. Tighter than the library's default. */
  readonly maxDataBytes?: number;
  readonly maxIdLength?: number;
  /** Longest reply accepted, in characters, checked before any parsing. */
  readonly maxOutputChars?: number;
  readonly maxRationaleChars?: number;
}

export const DEFAULT_GUARD_OPTIONS = Object.freeze({
  maxOps: DEFAULT_PROMPT_OPTIONS.maxOps,
  maxDataBytes: 2048,
  maxIdLength: 128,
  maxOutputChars: 32_000,
  maxRationaleChars: 500,
});

/** A reply that passed every check: a mutation the controller can preview, and the model's reason. */
export interface GuardedReply {
  readonly mutation: Mutation;
  readonly rationale?: string;
}

/** The fields the model may set on each operation. Everything else is the controller's. */
const FIELDS: Readonly<Record<AllowedOp, readonly string[]>> = Object.freeze({
  upsertNode: Object.freeze(['op', 'partition', 'id', 'data']),
  link: Object.freeze(['op', 'item', 'category', 'weight', 'data']),
});
const CONTROLLER_FIELDS: readonly string[] = Object.freeze(['mode', 'ensureNodes', 'graphId', 'requestId', 'createIfMissing', 'version', 'kind']);
const MAX_PROBLEMS = 5;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const rejected = (problems: readonly string[]): LlmError =>
  llmError('BAD_OUTPUT', `The reply was not accepted: ${problems.slice(0, MAX_PROBLEMS).map((p, i) => `(${i + 1}) ${p}`).join(' ')}${problems.length > MAX_PROBLEMS ? ` (and ${problems.length - MAX_PROBLEMS} more)` : ''}`);
const unknownKey = (where: string, key: string): string =>
  CONTROLLER_FIELDS.includes(key) ? `${where}: "${key}" is set by the system, not by you; leave it out` : `${where}: unknown field "${key}"`;

function readValue(output: ModelOutput, maxChars: number): Result<unknown, LlmError> {
  if (output.kind === 'json') return ok(output.value);
  if (output.text.length > maxChars) return err(rejected([`the reply is ${output.text.length} characters, over the limit of ${maxChars}`]));
  try {
    return ok(JSON.parse(output.text) as JsonValue);
  } catch {
    return err(rejected(['the reply is not a single JSON object (reply with the JSON only, no other text, no code fences)']));
  }
}

/** Checks everything about the shape of the reply that depends on the controller, collecting every problem. */
function checkShape(value: unknown, context: GuardContext, options: Required<GuardOptions>): { problems: string[]; ops: Array<Record<string, unknown>>; rationale?: string } {
  const problems: string[] = [];
  const none = { problems, ops: [] as Array<Record<string, unknown>> };
  if (!isObject(value)) return { ...none, problems: ['the reply must be a JSON object like {"ops": [...], "rationale": "..."}'] };
  for (const key of Object.keys(value)) if (key !== 'ops' && key !== 'rationale') problems.push(unknownKey('reply', key));

  let rationale: string | undefined;
  if ('rationale' in value) {
    if (typeof value.rationale !== 'string') problems.push('rationale: must be text');
    else if (value.rationale.length > options.maxRationaleChars) problems.push(`rationale: ${value.rationale.length} characters, over the limit of ${options.maxRationaleChars}`);
    else if (value.rationale.trim().length > 0) rationale = value.rationale.trim();
  }

  const { ops } = value;
  if (!Array.isArray(ops)) return { ...none, problems: [...problems, 'ops: must be a list of operations'] };
  if (ops.length === 0) return { ...none, problems: [...problems, 'ops: must contain at least one operation'] };
  if (ops.length > options.maxOps) return { ...none, problems: [...problems, `ops: ${ops.length} operations, over the limit of ${options.maxOps}`] };

  let itemUpserts = 0;
  let links = 0;
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
        itemUpserts++;
        if (op.id !== context.itemId) problems.push(`${where}: the note's item id must be exactly ${JSON.stringify(context.itemId)}`);
      } else if (op.partition !== 'category') problems.push(`${where}: partition must be "item" or "category"`);
    } else {
      links++;
      if (op.item !== context.itemId) problems.push(`${where}: a link's item must be exactly ${JSON.stringify(context.itemId)}`);
      if (op.weight !== undefined && !(typeof op.weight === 'number' && op.weight >= 0 && op.weight <= 1)) problems.push(`${where}: weight must be a number from 0 to 1`);
    }
  });
  if (itemUpserts !== 1) problems.push(`there must be exactly one upsertNode for the note's item, found ${itemUpserts}`);
  if (links === 0) problems.push('there must be at least one link from the note to a category');
  return { problems, ops: ops as Array<Record<string, unknown>>, ...(rationale === undefined ? {} : { rationale }) };
}

/**
 * Turns the model's reply into a mutation the controller can safely preview, or says what was
 * wrong. Pure; never throws. The model only chooses the operations: the graph id, request id,
 * `createIfMissing`, `mode` and `ensureNodes` are always the controller's. Only `upsertNode` and
 * `link` pass, the note's item id is the one the controller minted, and counts and sizes are capped
 * tighter than the library's defaults. Anything unexpected (prose, extra fields, other
 * operations) rejects the whole reply; nothing is repaired or dropped silently.
 */
export function guardReply(output: ModelOutput, context: GuardContext, options: GuardOptions = {}): Result<GuardedReply, LlmError> {
  try {
    const settings: Required<GuardOptions> = { ...DEFAULT_GUARD_OPTIONS, ...options };
    const raw = readValue(output, settings.maxOutputChars);
    if (!raw.ok) return raw;
    const { problems, ops, rationale } = checkShape(raw.value, context, settings);
    if (problems.length > 0) return err(rejected(problems));

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
      return err(rejected([`${path}${parsed.error.message}`]));
    }
    return ok({ mutation: parsed.value, ...(rationale === undefined ? {} : { rationale }) });
  } catch {
    return err(rejected(['the reply could not be read']));
  }
}
