import { err, ok, type JsonObject, type Result } from '../../../graph_store/index.js';
import type { StatusControls } from '../../controls/controls.js';
import type { StatusSettings } from '../../controls/settings.js';
import { renderTemplate } from '../../controls/template.js';
import { llmError, type LlmError } from '../../errors.js';
import type { ModelMessage } from '../../model-client.js';
import { escapeForBlock } from '../../text-blocks.js';
import type { PromptParts } from '../../trace.js';

// The `status` capability (R-011): the person asks for a short status and the model answers from numbered entries of
// what they can read. This file builds everything sent to the model; `guard.ts` checks what comes back. Both are pure.

/** One piece of the person's readable brain, as the controller hands it over. Its number is its position (1, 2, 3...). */
export interface StatusEntry {
  /** Where it came from, in words (`personal`, or `circle "Name"`). Untrusted text: a circle's name is written by a person. */
  readonly where: string;
  /** What it says: title, summary and the rest of its data as one line or a few. Untrusted text. */
  readonly text: string;
  /** When it was made or contributed, in milliseconds since 1970, when known. */
  readonly when?: number;
}

export interface StatusPromptInput {
  /** What the person typed ("Give me a morning status check"). */
  readonly text: string;
  readonly entries: readonly StatusEntry[];
  /** The current time, in milliseconds since 1970. */
  readonly now: number;
  /** An IANA time zone name, for the time shown to the model. */
  readonly timeZone: string;
}

export interface StatusPromptOptions {
  /** The request is refused, not cut, beyond this many characters (default 500). */
  readonly maxRequestChars?: number;
  /** Most entries accepted (default 500). */
  readonly maxEntries?: number;
  /** An entry longer than this is refused, not cut: the controller cuts its own text (default 1500). */
  readonly maxEntryChars?: number;
  /** All entries together may be at most this long (default 30000). */
  readonly maxTotalChars?: number;
}

export interface BuiltStatusPrompt {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly outputSchema: JsonObject;
  /** The same message as three separate parts (R-012), for the trace and the lab. */
  readonly parts: PromptParts;
}

const PROMPT_OPTION_NAMES: readonly string[] = Object.freeze(['maxRequestChars', 'maxEntries', 'maxEntryChars', 'maxTotalChars']);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const bad = (where: string, message: string) => err(llmError('CONFIG', `${where}: ${message}`));

/** Whether the name is a time zone the runtime knows. */
export function isTimeZone(name: unknown): name is string {
  if (typeof name !== 'string' || name === '' || name.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(name)) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** `Thursday 15 October 2026, 08:30 (Europe/London)`. */
export function describeTime(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')} (${timeZone})`;
}

/** `2026-10-15` in the zone. */
export function describeDay(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The trusted instructions: the controls' `system.txt` with the entry count, the time and the reply limits filled in. */
export function buildStatusSystemPrompt(controls: StatusControls, entryCount: number, nowText: string): string {
  const { maxHeadline, maxPoints, maxPointChars, maxRefs } = controls.settings;
  return renderTemplate(controls.system, {
    entryCount: String(entryCount),
    now: nowText,
    maxHeadline: String(maxHeadline),
    maxPoints: String(maxPoints),
    maxPointChars: String(maxPointChars),
    maxRefs: String(maxRefs),
  });
}

function formatEntry(entry: StatusEntry, number: number, timeZone: string): string {
  const when = entry.when === undefined ? '' : `, ${describeDay(entry.when, timeZone)}`;
  return `[${number}] (${entry.where}${when}) ${entry.text}`;
}

/** The two blocks of the user message: the numbered entries (part 2) and the request (part 1), each escaped, in its own block. */
export function statusBlocks(entries: readonly StatusEntry[], text: string, timeZone: string): { readonly entriesBlock: string; readonly requestBlock: string } {
  const lines = entries.map((e, i) => formatEntry(e, i + 1, timeZone).replace(/[\r\n]+/g, ' '));
  return {
    entriesBlock: `<entries>\n${lines.length === 0 ? '(there are no entries)' : escapeForBlock(lines.join('\n'))}\n</entries>`,
    requestBlock: `<request>\n${escapeForBlock(text)}\n</request>`,
  };
}

/** The single user message: the controls' `frame.txt` with the numbered entries and the request, each in its own escaped block. */
export function buildStatusUserMessage(controls: StatusControls, entries: readonly StatusEntry[], text: string, timeZone: string): string {
  return renderTemplate(controls.frame, statusBlocks(entries, text, timeZone));
}

/** The JSON Schema the reply must match. */
export function buildStatusOutputSchema(settings: StatusSettings, entryCount: number): JsonObject {
  const { maxHeadline, maxPoints, maxPointChars, maxRefs, descriptions } = settings;
  return {
    type: 'object',
    properties: {
      headline: { type: 'string', minLength: 1, maxLength: maxHeadline, description: descriptions.headline },
      points: {
        type: 'array',
        maxItems: maxPoints,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', minLength: 1, maxLength: maxPointChars, description: descriptions.pointText },
            refs: { type: 'array', minItems: 1, maxItems: maxRefs, items: { type: 'integer', minimum: 1, maximum: Math.max(1, entryCount) }, description: `${descriptions.refs} (1 to ${entryCount}).` },
          },
          required: ['text', 'refs'],
          additionalProperties: false,
        },
      },
      nothing: { type: 'boolean', description: descriptions.nothing },
    },
    required: ['headline', 'points', 'nothing'],
    additionalProperties: false,
  };
}

function check(input: unknown, options: unknown): LlmError | undefined {
  if (!isObject(input)) return llmError('CONFIG', 'prompt input: must be an object like { text, entries, now, timeZone }');
  const { text, entries, now, timeZone, ...extra } = input;
  const unknownField = Object.keys(extra)[0];
  if (unknownField !== undefined) return llmError('CONFIG', `prompt input: unknown field "${unknownField}"`);
  if (typeof text !== 'string') return llmError('CONFIG', 'prompt input.text: must be text');
  if (!Array.isArray(entries)) return llmError('CONFIG', 'prompt input.entries: must be a list');
  for (const [i, entry] of entries.entries()) {
    if (!isObject(entry)) return llmError('CONFIG', `prompt input.entries[${i}]: must be an object like { where, text, when? }`);
    const { where, text: body, when, ...rest } = entry;
    if (Object.keys(rest).length > 0) return llmError('CONFIG', `prompt input.entries[${i}]: unknown field "${Object.keys(rest)[0]}"`);
    if (typeof where !== 'string' || where.trim() === '') return llmError('CONFIG', `prompt input.entries[${i}].where: must be non-empty text`);
    if (typeof body !== 'string' || body.trim() === '') return llmError('CONFIG', `prompt input.entries[${i}].text: must be non-empty text`);
    if (when !== undefined && !(typeof when === 'number' && Number.isSafeInteger(when) && when >= 0 && when < 8.64e15)) return llmError('CONFIG', `prompt input.entries[${i}].when: must be milliseconds since 1970`);
  }
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0 || now >= 8.64e15) return llmError('CONFIG', 'prompt input.now: must be milliseconds since 1970');
  if (!isTimeZone(timeZone)) return llmError('CONFIG', 'prompt input.timeZone: must be a time zone name such as "Europe/London" or "UTC"');
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
 * Builds everything sent to the model for one status request. Pure and deterministic. The system prompt is fixed
 * trusted text; the request and the entries (including the names of circles) appear only, escaped, inside their own
 * blocks of the user message. An empty or oversized request, too many entries or too much text is refused, not cut.
 * Never throws.
 */
export function buildStatusPrompt(controls: StatusControls, input: StatusPromptInput, options?: StatusPromptOptions): Result<BuiltStatusPrompt, LlmError> {
  try {
    const problem = check(input, options);
    if (problem !== undefined) return err(problem);
    const { maxRequestChars, maxEntries, maxEntryChars, maxTotalChars } = controls.settings;
    const settings = { maxRequestChars, maxEntries, maxEntryChars, maxTotalChars, ...options };
    if (input.text.trim().length === 0) return bad('prompt input.text', 'the request is empty');
    if ([...input.text].length > settings.maxRequestChars) return bad('prompt input.text', `the request is ${[...input.text].length} characters, over the limit of ${settings.maxRequestChars}`);
    if (input.entries.length > settings.maxEntries) return bad('prompt input.entries', `${input.entries.length} entries, over the limit of ${settings.maxEntries}`);
    let total = 0;
    for (const [i, entry] of input.entries.entries()) {
      const size = [...entry.text].length + [...entry.where].length;
      if (size > settings.maxEntryChars) return bad(`prompt input.entries[${i}]`, `${size} characters, over the limit of ${settings.maxEntryChars}`);
      total += size;
    }
    if (total > settings.maxTotalChars) return bad('prompt input.entries', `${total} characters in all, over the limit of ${settings.maxTotalChars}`);
    const system = buildStatusSystemPrompt(controls, input.entries.length, describeTime(input.now, input.timeZone));
    const blocks = statusBlocks(input.entries, input.text, input.timeZone);
    return ok({
      system,
      messages: [{ role: 'user', content: renderTemplate(controls.frame, blocks) }],
      outputSchema: buildStatusOutputSchema(controls.settings, input.entries.length),
      parts: { controls: { system, frame: controls.frame.text }, request: blocks.requestBlock, context: blocks.entriesBlock },
    });
  } catch {
    return bad('prompt', 'could not be built from the input given');
  }
}
