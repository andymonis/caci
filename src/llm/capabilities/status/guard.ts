import { err, ok, type JsonValue, type Result } from '../../../graph_store/index.js';
import { type LlmError } from '../../errors.js';
import type { ModelOutput } from '../../model-client.js';
import { rejectionError } from '../../text-blocks.js';
import { STATUS_LIMITS } from './prompt.js';

/** What the controller knows and the model must not choose. */
export interface StatusGuardContext {
  /** How many numbered entries the model was given. A cited number must be between 1 and this. */
  readonly entryCount: number;
}

export interface StatusGuardOptions {
  /** Longest reply accepted, in characters, checked before any parsing. */
  readonly maxOutputChars?: number;
}

export const DEFAULT_STATUS_GUARD_OPTIONS = Object.freeze({ maxOutputChars: 8000 });

/** A reply that passed every check. All text is trimmed. */
export interface GuardedStatus {
  readonly headline: string;
  readonly points: readonly { readonly text: string; readonly refs: readonly number[] }[];
  readonly nothing: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const CONTROL = /\p{Cc}/u;

/** Checks one line of text: a string of 1 to `max` characters (after trimming) with no control characters, newlines included. */
function line(where: string, value: unknown, max: number, problems: string[]): string | undefined {
  if (typeof value !== 'string') {
    problems.push(`${where}: must be text`);
    return undefined;
  }
  const text = value.trim();
  const length = [...text].length;
  if (length === 0) problems.push(`${where}: must not be empty`);
  else if (length > max) problems.push(`${where}: ${length} characters, over the limit of ${max}`);
  else if (CONTROL.test(text)) problems.push(`${where}: must be one line of plain text (no line breaks or control characters)`);
  else return text;
  return undefined;
}

/**
 * Checks the model's reply and gives either a status the controller can pass on or the complete list of what was
 * wrong. Pure; never throws. Anything unexpected (prose, extra fields, a number outside the entries given, a
 * contradiction between `nothing` and `points`) rejects the whole reply; nothing is repaired or dropped silently.
 */
export function inspectStatusReply(output: ModelOutput, context: StatusGuardContext, options: StatusGuardOptions = {}): Result<GuardedStatus, readonly string[]> {
  try {
    const maxChars = options.maxOutputChars ?? DEFAULT_STATUS_GUARD_OPTIONS.maxOutputChars;
    let value: unknown;
    if (output.kind === 'json') value = output.value;
    else {
      if (output.text.length > maxChars) return err([`the reply is ${output.text.length} characters, over the limit of ${maxChars}`]);
      try {
        value = JSON.parse(output.text) as JsonValue;
      } catch {
        return err(['the reply is not a single JSON object (reply with the JSON only, no other text, no code fences)']);
      }
    }
    if (!isObject(value)) return err(['the reply must be a JSON object like {"headline": "...", "points": [...], "nothing": false}']);
    const problems: string[] = [];
    for (const key of Object.keys(value)) if (key !== 'headline' && key !== 'points' && key !== 'nothing') problems.push(`reply: unknown field "${key}"`);

    const headline = line('headline', value.headline, STATUS_LIMITS.maxHeadline, problems);

    let nothing = false;
    if ('nothing' in value) {
      if (typeof value.nothing !== 'boolean') problems.push('nothing: must be true or false');
      else nothing = value.nothing;
    }

    const points: { text: string; refs: number[] }[] = [];
    if (!Array.isArray(value.points)) problems.push('points: must be a list');
    else {
      if (value.points.length > STATUS_LIMITS.maxPoints) problems.push(`points: ${value.points.length} points, over the limit of ${STATUS_LIMITS.maxPoints}`);
      value.points.slice(0, STATUS_LIMITS.maxPoints).forEach((point: unknown, i) => {
        const where = `points[${i}]`;
        if (!isObject(point)) return void problems.push(`${where}: must be an object like {"text": "...", "refs": [1]}`);
        for (const key of Object.keys(point)) if (key !== 'text' && key !== 'refs') problems.push(`${where}: unknown field "${key}"`);
        const text = line(`${where}.text`, point.text, STATUS_LIMITS.maxPointChars, problems);
        let refs: number[] | undefined;
        if (!Array.isArray(point.refs) || point.refs.length === 0) problems.push(`${where}.refs: must be a list of 1 to ${STATUS_LIMITS.maxRefs} entry numbers`);
        else if (point.refs.length > STATUS_LIMITS.maxRefs) problems.push(`${where}.refs: ${point.refs.length} numbers, over the limit of ${STATUS_LIMITS.maxRefs}`);
        else {
          const numbers = point.refs as unknown[];
          const wrong = numbers.filter((n) => !(typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= context.entryCount));
          if (wrong.length > 0) problems.push(`${where}.refs: ${wrong.map((n) => JSON.stringify(n)).join(', ')} is not an entry number (the entries are numbered 1 to ${context.entryCount})`);
          else if (new Set(numbers).size !== numbers.length) problems.push(`${where}.refs: each entry number may appear once`);
          else refs = numbers as number[];
        }
        if (text !== undefined && refs !== undefined) points.push({ text, refs });
      });
    }
    if (Array.isArray(value.points)) {
      if (nothing && value.points.length > 0) problems.push('nothing: true cannot be combined with points; either list points or set nothing to true with an empty list');
      if (!nothing && value.points.length === 0) problems.push('points: must have at least one point, or set nothing to true when no entry is relevant');
    }
    if (problems.length > 0 || headline === undefined) return err(problems.length > 0 ? problems : ['headline: missing']);
    return ok({ headline, points, nothing });
  } catch {
    return err(['the reply could not be read']);
  }
}

/** Like `inspectStatusReply`, but a rejection is a `BAD_OUTPUT` error whose message numbers the first problems. */
export function guardStatusReply(output: ModelOutput, context: StatusGuardContext, options: StatusGuardOptions = {}): Result<GuardedStatus, LlmError> {
  const inspected = inspectStatusReply(output, context, options);
  return inspected.ok ? inspected : err(rejectionError(inspected.error));
}
