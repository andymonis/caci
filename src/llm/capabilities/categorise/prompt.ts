import { err, mutationJsonSchema, ok, type JsonObject, type Result } from '../../../graph_store/index.js';
import type { CategoriseControls } from '../../controls/controls.js';
import type { CategoriseSettings } from '../../controls/settings.js';
import { renderTemplate } from '../../controls/template.js';
import { llmError, type LlmError } from '../../errors.js';
import type { ModelMessage } from '../../model-client.js';
import { escapeForBlock } from '../../text-blocks.js';
import type { PromptParts } from '../../trace.js';
import { CATEGORISE_OPS, type AllowedOp } from './context.js';

/** What the controller hands over for one note. The note's item id is minted by the controller, never chosen by the model. */
export interface PromptInput {
  /** The user's note, exactly as captured. */
  readonly text: string;
  /** The block built by `buildContext`: which categories exist and which operations are allowed. */
  readonly context: string;
  /** The id the note's item must use. */
  readonly itemId: string;
  /**
   * Notes already filed that this note might replace (R-014), as the controller found them. The model sees them numbered from 1 in an
   * `<existing>` block and may name some of those numbers in `replaces`; it never sees their ids. Leave out or empty for none.
   */
  readonly existing?: readonly ExistingNote[];
}

/** One already-filed note, as the categoriser is shown it. */
export interface ExistingNote {
  readonly title: string;
  readonly summary: string;
}

export interface PromptOptions {
  /** The most operations the model may return (default 25). */
  readonly maxOps?: number;
  /** Notes longer than this are refused, not cut (default 8000 characters). */
  readonly maxTextChars?: number;
  /** The context block may be at most this long (default 12000 characters). */
  readonly maxContextChars?: number;
}

export interface BuiltPrompt {
  /** Fixed rules plus the item id. Never contains any text from the user or the graph. */
  readonly system: string;
  /** One user message holding the category context and the note, each in its own escaped block. */
  readonly messages: readonly ModelMessage[];
  /** The JSON Schema the reply must match. */
  readonly outputSchema: JsonObject;
  /** The same message as three separate parts (R-012), for the trace and the lab. */
  readonly parts: PromptParts;
}

const PROMPT_OPTION_NAMES: readonly string[] = Object.freeze(['maxOps', 'maxTextChars', 'maxContextChars']);

/** Fields the model may not choose: the controller sets them (an upsert is always a merge, never a replace; a link never creates missing nodes or carries data). */
const OMITTED_FIELDS: Readonly<Record<AllowedOp, readonly string[]>> = Object.freeze({
  upsertNode: Object.freeze(['mode']),
  link: Object.freeze(['ensureNodes', 'data']),
});

/**
 * What the model may put in `data`. The graph store accepts any object there, but providers that
 * enforce a schema need every object closed, so the model is offered exactly what the prompt asks for.
 * The lengths and the descriptions come from the controls.
 */
function dataShapes(settings: CategoriseSettings): Record<'item' | 'category', { properties: Record<string, unknown>; required: string[] }> {
  return {
    item: {
      properties: {
        title: { type: 'string', minLength: 1, maxLength: settings.titleMaxChars, description: settings.descriptions.title },
        summary: { type: 'string', minLength: 1, maxLength: settings.summaryMaxChars, description: settings.descriptions.summary },
      },
      required: ['title', 'summary'],
    },
    category: {
      properties: { name: { type: 'string', minLength: 1, maxLength: settings.categoryNameMaxChars, description: settings.descriptions.name } },
      required: ['name'],
    },
  };
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const bad = (where: string, message: string) => err(llmError('CONFIG', `${where}: ${message}`));

export { escapeForBlock };

/** The trusted instructions: the controls' `system.txt` with the item id, the operation limit, the allowed operations and the replace limit filled in. */
export function buildSystemPrompt(controls: CategoriseControls, itemId: string, allowedOps: readonly AllowedOp[], maxOps: number, maxReplaces: number = controls.settings.maxReplaces): string {
  return renderTemplate(controls.system, { itemId, maxOps: String(maxOps), allowedOps: allowedOps.join(', '), maxReplaces: String(maxReplaces) });
}

const oneLine = (text: string): string => text.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();

/** The existing notes as numbered lines, one line each: `[1] title: summary`. Line breaks and control characters in them become spaces. */
export function existingLines(existing: readonly ExistingNote[]): string {
  return existing
    .map((note, i) => {
      const title = oneLine(note.title);
      const summary = oneLine(note.summary);
      return `[${i + 1}] ${title !== '' && summary !== '' ? `${title}: ${summary}` : title || summary || '(no text)'}`;
    })
    .join('\n');
}

/**
 * The two blocks of the user message: the category context (part 2) and the note (part 1), each escaped, in its own block. When there
 * are existing notes, their block follows the categories inside the same part, so the template and the three parts do not change.
 */
export function userBlocks(context: string, text: string, existing: readonly ExistingNote[] = []): { readonly contextBlock: string; readonly requestBlock: string } {
  const categories = `<categories>\n${escapeForBlock(context)}\n</categories>`;
  const contextBlock = existing.length === 0 ? categories : `${categories}\n<existing>\n${escapeForBlock(existingLines(existing))}\n</existing>`;
  return { contextBlock, requestBlock: `<note>\n${escapeForBlock(text)}\n</note>` };
}

/** The single user message: the controls' `frame.txt` with the category context (and any existing notes) and the note, each in an escaped block of its own. */
export function buildUserMessage(controls: CategoriseControls, context: string, text: string, existing: readonly ExistingNote[] = []): string {
  return renderTemplate(controls.frame, userBlocks(context, text, existing));
}

type Json = Record<string, unknown>;

/**
 * The JSON Schema the reply must match, derived from the real mutation schema every time so it
 * cannot drift from it: the same operation definitions, narrowed to the allowed operations and
 * with the fields the model may not choose removed.
 */
export function buildOutputSchema(settings: CategoriseSettings, allowedOps: readonly AllowedOp[], maxOps: number, existingCount = 0): Result<JsonObject, LlmError> {
  const full = structuredClone(mutationJsonSchema()) as Json;
  const variants = ((full.properties as Json | undefined)?.ops as Json | undefined)?.items as Json | undefined;
  const all = variants?.oneOf;
  if (!Array.isArray(all) || !all.every(isObject)) {
    return bad('output schema', 'the mutation schema does not have the expected shape (ops.items.oneOf), so the prompt builder needs updating');
  }
  const kept: Json[] = [];
  for (const op of allowedOps) {
    if (!(op in OMITTED_FIELDS)) return bad('output schema', `"${op}" is not an operation the categoriser may use`);
    const variant = (all as Json[]).find((v) => ((v.properties as Json | undefined)?.op as Json | undefined)?.const === op);
    if (variant === undefined) return bad('output schema', `the mutation schema has no "${op}" operation`);
    const properties = Object.fromEntries(Object.entries(variant.properties as Json).filter(([field]) => !OMITTED_FIELDS[op].includes(field)));
    const required = (variant.required as string[]).filter((f) => f in properties);
    if (op === 'upsertNode') {
      // one variant per partition, so each kind of node has its own closed `data`
      for (const partition of ['item', 'category'] as const) {
        const shape = dataShapes(settings)[partition];
        const data = { type: 'object', properties: shape.properties, required: shape.required, additionalProperties: false } as Json;
        kept.push({ ...variant, properties: { ...properties, partition: { type: 'string', const: partition }, data }, required: [...required, 'data'] });
      }
    } else {
      kept.push({ ...variant, properties, required });
    }
  }
  return ok({
    $schema: full.$schema as string,
    type: 'object',
    properties: {
      ops: { type: 'array', items: { oneOf: kept as never }, minItems: 1, maxItems: maxOps },
      rationale: { type: 'string', maxLength: settings.maxRationaleChars },
      ...(existingCount > 0 && settings.maxReplaces > 0
        ? { replaces: { type: 'array', items: { type: 'integer', minimum: 1, maximum: existingCount }, maxItems: Math.min(settings.maxReplaces, existingCount), uniqueItems: true } }
        : {}),
    },
    required: ['ops'],
    additionalProperties: false,
    ...(full.$defs === undefined || !JSON.stringify(kept).includes('"$ref"') ? {} : { $defs: full.$defs as never }),
  } as JsonObject);
}

function check(input: unknown, options: unknown): LlmError | undefined {
  if (!isObject(input)) return llmError('CONFIG', 'prompt input: must be an object like { text, context, itemId }');
  const { text, context, itemId, existing, ...extra } = input;
  const unknownField = Object.keys(extra)[0];
  if (unknownField !== undefined) return llmError('CONFIG', `prompt input: unknown field "${unknownField}"`);
  if (typeof itemId !== 'string' || !SAFE_ID.test(itemId)) {
    return llmError('CONFIG', 'prompt input.itemId: must be 1 to 128 letters, digits, "_", ".", ":" or "-", starting with a letter or digit (it is placed in the instructions)');
  }
  if (typeof context !== 'string' || context.length === 0) return llmError('CONFIG', 'prompt input.context: must be the non-empty block from buildContext');
  if (typeof text !== 'string') return llmError('CONFIG', 'prompt input.text: must be text');
  if (existing !== undefined) {
    if (!Array.isArray(existing)) return llmError('CONFIG', 'prompt input.existing: must be a list of { title, summary }');
    for (const [i, note] of existing.entries()) {
      if (!isObject(note) || typeof note.title !== 'string' || typeof note.summary !== 'string' || Object.keys(note).length !== 2) return llmError('CONFIG', `prompt input.existing[${i}]: must be exactly { title, summary }, both text`);
    }
  }
  if (options !== undefined) {
    if (!isObject(options)) return llmError('CONFIG', 'prompt options: must be an object');
    for (const [name, value] of Object.entries(options)) {
      if (!PROMPT_OPTION_NAMES.includes(name)) return llmError('CONFIG', `prompt options: unknown option "${name}"`);
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return llmError('CONFIG', `prompt options.${name}: must be a positive whole number`);
    }
  }
  return undefined;
}

/**
 * Builds everything sent to the model for one note. Pure and deterministic. The system prompt is
 * fixed trusted text; the user's note and the graph's category data only ever appear, escaped,
 * inside their own blocks of the user message. An empty or oversized note is refused rather than
 * cut. Never throws.
 */
export function buildPrompt(controls: CategoriseControls, input: PromptInput, options?: PromptOptions): Result<BuiltPrompt, LlmError> {
  try {
    const problem = check(input, options);
    if (problem !== undefined) return err(problem);
    const { maxOps, maxTextChars, maxContextChars } = controls.settings;
    const settings = { maxOps, maxTextChars, maxContextChars, ...options };
    if (input.text.trim().length === 0) return bad('prompt input.text', 'the note is empty');
    if (input.text.length > settings.maxTextChars) return bad('prompt input.text', `the note is ${input.text.length} characters, over the limit of ${settings.maxTextChars}`);
    if (input.context.length > settings.maxContextChars) return bad('prompt input.context', `the context is ${input.context.length} characters, over the limit of ${settings.maxContextChars}`);

    const existing = input.existing ?? [];
    const existingChars = existing.reduce((n, note) => n + note.title.length + note.summary.length, 0);
    if (existingChars > settings.maxContextChars) return bad('prompt input.existing', `the existing notes are ${existingChars} characters, over the limit of ${settings.maxContextChars}`);
    const schema = buildOutputSchema(controls.settings, CATEGORISE_OPS, settings.maxOps, existing.length);
    if (!schema.ok) return schema;
    const system = buildSystemPrompt(controls, input.itemId, CATEGORISE_OPS, settings.maxOps);
    const blocks = userBlocks(input.context, input.text, existing);
    return ok({
      system,
      messages: [{ role: 'user', content: renderTemplate(controls.frame, blocks) }],
      outputSchema: schema.value,
      parts: { controls: { system: system, frame: controls.frame.text }, request: blocks.requestBlock, context: blocks.contextBlock },
    });
  } catch {
    return bad('prompt', 'could not be built from the input given');
  }
}
