import { err, ok, type Result } from '../graph_store/index.js';
import { appError, type AppError } from './errors.js';
import { parseInput, type AudioInput, type ImageInput, type Input, type InputKind, type TextInput } from './input.js';

/** Turns one kind of input into the text the categoriser reads (for example a transcript or a description). */
export type InputNormaliser<T extends Input> = (input: T) => Promise<Result<string, AppError>>;

/**
 * The normaliser for each kind of input. Adding picture or voice support later means supplying
 * `image` or `audio` here; nothing else changes. A kind without one is `UNSUPPORTED_INPUT`.
 */
export interface Normalisers {
  readonly text?: InputNormaliser<TextInput>;
  readonly image?: InputNormaliser<ImageInput>;
  readonly audio?: InputNormaliser<AudioInput>;
}

/** Text is already text: it only has to contain something. */
export const normaliseText: InputNormaliser<TextInput> = (input) =>
  Promise.resolve(input.text.trim().length === 0 ? err(appError('INVALID_INPUT', 'the note is empty')) : ok(input.text));

/**
 * Turns any input into text, or says why not. Validates the input first, picks the normaliser for
 * its kind, and never throws (a normaliser that throws or returns something that is not text is
 * `NORMALISER_FAILED`).
 */
export async function normaliseInput(input: unknown, normalisers: Normalisers = {}): Promise<Result<string, AppError>> {
  const parsed = parseInput(input);
  if (!parsed.ok) return parsed;
  const kind: InputKind = parsed.value.kind;
  const normalise = (kind === 'text' ? (normalisers.text ?? normaliseText) : normalisers[kind]) as InputNormaliser<Input> | undefined;
  if (normalise === undefined) return err(appError('UNSUPPORTED_INPUT', `${kind} input is not supported yet`));
  try {
    const result = await normalise(parsed.value);
    if (typeof result !== 'object' || result === null || typeof result.ok !== 'boolean') return err(appError('NORMALISER_FAILED', `the ${kind} normaliser did not return a result`));
    if (!result.ok) return result;
    return typeof result.value === 'string' ? result : err(appError('NORMALISER_FAILED', `the ${kind} normaliser did not return text`));
  } catch {
    return err(appError('NORMALISER_FAILED', `the ${kind} normaliser failed`));
  }
}
