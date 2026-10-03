import { err, ok, type Result } from '../graph_store/index.js';
import { appError, type AppError } from './errors.js';

/** A note typed or pasted as text. The only kind handled today. */
export interface TextInput {
  readonly kind: 'text';
  readonly text: string;
}

/** A picture. Accepted by the type so callers need not change later; no normaliser exists yet. */
export interface ImageInput {
  readonly kind: 'image';
  readonly mediaType: string;
  readonly data: Uint8Array;
}

/** A voice recording. Same status as `ImageInput`. */
export interface AudioInput {
  readonly kind: 'audio';
  readonly mediaType: string;
  readonly data: Uint8Array;
}

export type Input = TextInput | ImageInput | AudioInput;
export type InputKind = Input['kind'];

export const INPUT_KINDS: readonly InputKind[] = Object.freeze(['text', 'image', 'audio']);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks that something is an `Input`: a known kind with exactly its own fields. Pure; never throws. */
export function parseInput(value: unknown): Result<Input, AppError> {
  try {
    if (!isObject(value)) return err(appError('INVALID_INPUT', 'input: must be an object like { kind: "text", text }'));
    const { kind } = value;
    if (typeof kind !== 'string' || !(INPUT_KINDS as readonly string[]).includes(kind)) {
      return err(appError('INVALID_INPUT', `input.kind: must be one of ${INPUT_KINDS.join(', ')}, not ${JSON.stringify(kind)}`));
    }
    const fields = kind === 'text' ? ['kind', 'text'] : ['kind', 'mediaType', 'data'];
    for (const key of Object.keys(value)) {
      if (!fields.includes(key)) return err(appError('INVALID_INPUT', `input: unknown field "${key}" for a ${kind} input`));
    }
    if (kind === 'text') {
      return typeof value.text === 'string' ? ok(Object.freeze({ kind: 'text', text: value.text })) : err(appError('INVALID_INPUT', 'input.text: must be text'));
    }
    if (typeof value.mediaType !== 'string' || value.mediaType.length === 0) return err(appError('INVALID_INPUT', 'input.mediaType: must be a non-empty text like "image/png"'));
    if (!(value.data instanceof Uint8Array)) return err(appError('INVALID_INPUT', 'input.data: must be a Uint8Array'));
    return ok(Object.freeze({ kind: kind as 'image' | 'audio', mediaType: value.mediaType, data: value.data }));
  } catch {
    return err(appError('INVALID_INPUT', 'input: could not be read'));
  }
}
