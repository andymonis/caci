import { err, ok, type Result } from '../../../graph_store/index.js';
import { resolveModel, type LlmConfig, type ModelTier } from '../../config.js';
import { llmError, type LlmError } from '../../errors.js';
import type { ModelClient, ModelMessage, ModelOutput, ModelResponse } from '../../model-client.js';
import { rejectionError } from '../../text-blocks.js';
import { makeEmitter, type Emit, type TraceEvent } from '../../trace.js';
import { addUsage, isValidUsage, NO_USAGE, type TokenUsage } from '../../usage.js';
import type { Controls } from '../../controls/controls.js';
import { inspectStatusReply, statusGuardSettingsOf, type GuardedStatus } from './guard.js';
import { buildStatusPrompt, isTimeZone, type StatusEntry } from './prompt.js';
import { horizonWindow, isHorizon, type Horizon } from './window.js';

/** What the controller hands over for one status request. */
export interface StatusInput {
  /** What the person typed. */
  readonly text: string;
  /** The numbered entries (their position is their number). May be empty. */
  readonly entries: readonly StatusEntry[];
  /** An IANA time zone name for the time the model is told. Default `UTC`. */
  readonly timeZone?: string;
  /** A focused check (R-018): `week`, `month` or `year`. The window is worked out here and stated to the model. Absent: an ordinary status. */
  readonly horizon?: Horizon;
}

export interface StatusOptions {
  /** Use this exact model for the call. Beats `tier` and the configured route. */
  readonly model?: string;
  /** Use this tier's model for the call. */
  readonly tier?: ModelTier;
  readonly signal?: AbortSignal;
  /** The whole call, including a repair attempt, must finish within this. Default 30,000. */
  readonly timeoutMs?: number;
  /** Most tokens the model may write in one attempt. Default 1,000. */
  readonly maxOutputTokens?: number;
  readonly maxRequestChars?: number;
  readonly maxEntries?: number;
  readonly maxEntryChars?: number;
  readonly maxTotalChars?: number;
  /** Called with each step of the call (see `TraceEvent`). Events are copies; a callback that throws or rejects is ignored. */
  readonly trace?: (event: TraceEvent) => void | Promise<void>;
}

/** The model's answer, checked. Nothing has been written anywhere. */
export interface StatusAnswer {
  readonly headline: string;
  /** Each point cites the entries it is based on by number (1-based, within the entries given). */
  readonly points: readonly { readonly text: string; readonly refs: readonly number[] }[];
  readonly nothing: boolean;
  /** Tokens used across all attempts. */
  readonly usage: TokenUsage;
  /** The model that answered. */
  readonly model: string;
  /** 1, or 2 when the first reply was rejected and the repair attempt was needed. */
  readonly attempts: 1 | 2;
}

export interface StatusDeps {
  readonly client: ModelClient;
  readonly config: LlmConfig;
  /** The instructions, framing and limits (R-012), read from the controls folder. */
  readonly controls: Controls;
  /** The clock, in milliseconds. It is also "now" for the model. Tests replace it. */
  readonly now: () => number;
}

export const DEFAULT_STATUS_OPTIONS = Object.freeze({ timeoutMs: 30_000, maxOutputTokens: 1000 });

const INPUT_FIELDS: readonly string[] = Object.freeze(['text', 'entries', 'timeZone', 'horizon']);
const OPTION_FIELDS: readonly string[] = Object.freeze(['model', 'tier', 'signal', 'timeoutMs', 'maxOutputTokens', 'maxRequestChars', 'maxEntries', 'maxEntryChars', 'maxTotalChars', 'trace']);
const NUMBER_OPTIONS: readonly string[] = Object.freeze(['timeoutMs', 'maxOutputTokens', 'maxRequestChars', 'maxEntries', 'maxEntryChars', 'maxTotalChars']);
const ECHO_LIMIT = 4000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const config = (message: string): LlmError => llmError('CONFIG', message);
const cut = (text: string): string => (text.length > ECHO_LIMIT ? `${text.slice(0, ECHO_LIMIT)}… (cut)` : text);

function checkOptions(options: unknown): LlmError | undefined {
  if (options === undefined) return undefined;
  if (!isObject(options)) return config('status options: must be an object');
  for (const key of Object.keys(options)) if (!OPTION_FIELDS.includes(key)) return config(`status options: unknown option "${key}"`);
  for (const key of NUMBER_OPTIONS) {
    const value = options[key];
    if (value !== undefined && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 1)) return config(`status options.${key}: must be a positive whole number`);
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) return config('status options.signal: must be an AbortSignal');
  if (options.trace !== undefined && typeof options.trace !== 'function') return config('status options.trace: must be a function');
  return undefined;
}

function checkInput(input: unknown): LlmError | undefined {
  if (!isObject(input)) return config('status input: must be an object like { text, entries, timeZone }');
  for (const key of Object.keys(input)) if (!INPUT_FIELDS.includes(key)) return config(`status input: unknown field "${key}"`);
  if (input.timeZone !== undefined && !isTimeZone(input.timeZone)) return config('status input.timeZone: must be a time zone name such as "Europe/London" or "UTC"');
  if (input.horizon !== undefined && !isHorizon(input.horizon)) return config('status input.horizon: must be "week", "month" or "year"');
  return undefined;
}

function describeReply(output: ModelOutput): string {
  try {
    return cut(output.kind === 'text' ? output.text : JSON.stringify(output.value));
  } catch {
    return '(unreadable)';
  }
}

interface Attempt {
  readonly response: ModelResponse;
  readonly verdict: Result<GuardedStatus, readonly string[]>;
}

/**
 * Answers a status request from numbered entries. Builds the prompt, asks the model, and checks the reply with the
 * guard. If the guard rejects it, the reasons go back to the model once; a second rejection ends the call. Everything
 * runs inside one time limit, honours cancellation, and never throws. Nothing is written: the result is an answer to show.
 */
export async function status(deps: StatusDeps, input: StatusInput, options?: StatusOptions): Promise<Result<StatusAnswer, LlmError>> {
  const started = deps.now();
  const emit = makeEmitter(options);
  const counter = { attempts: 0 };
  let result: Result<StatusAnswer, LlmError>;
  try {
    result = await run(deps, input, options, emit, counter, started);
  } catch {
    result = err(llmError('MODEL_ERROR', 'status failed unexpectedly'));
  }
  emit({ type: 'done', ok: result.ok, attempts: counter.attempts, elapsedMs: deps.now() - started, ...(result.ok ? {} : { error: result.error }) });
  return result;
}

async function run(deps: StatusDeps, input: StatusInput, options: StatusOptions | undefined, emit: Emit, counter: { attempts: number }, started: number): Promise<Result<StatusAnswer, LlmError>> {
  const optionProblem = checkOptions(options);
  if (optionProblem !== undefined) return err(optionProblem);
  const inputProblem = checkInput(input);
  if (inputProblem !== undefined) return err(inputProblem);
  const settings = { ...DEFAULT_STATUS_OPTIONS, ...options };

  const model = resolveModel(deps.config, 'status', {
    ...(settings.model === undefined ? {} : { model: settings.model }),
    ...(settings.tier === undefined ? {} : { tier: settings.tier }),
  });
  if (!model.ok) return model;

  const prompt = buildStatusPrompt(
    deps.controls.status,
    { text: input.text, entries: input.entries, now: started, timeZone: input.timeZone ?? 'UTC', ...(input.horizon === undefined ? {} : { horizon: input.horizon }) },
    {
      ...(options?.maxRequestChars === undefined ? {} : { maxRequestChars: options.maxRequestChars }),
      ...(options?.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
      ...(options?.maxEntryChars === undefined ? {} : { maxEntryChars: options.maxEntryChars }),
      ...(options?.maxTotalChars === undefined ? {} : { maxTotalChars: options.maxTotalChars }),
    },
  );
  if (!prompt.ok) return prompt;
  emit({ type: 'prompt', system: prompt.value.system, messages: prompt.value.messages, schema: prompt.value.outputSchema, parts: prompt.value.parts });
  const guardContext = { entryCount: input.entries.length };
  const windowMade = input.horizon === undefined ? undefined : horizonWindow(started, input.timeZone ?? 'UTC', input.horizon);
  const window = windowMade !== undefined && windowMade.ok ? windowMade.value : undefined;

  const attempt = async (messages: readonly ModelMessage[]): Promise<Result<Attempt, LlmError>> => {
    if (options?.signal?.aborted === true) return err(llmError('CANCELLED', 'the call was cancelled'));
    const remaining = settings.timeoutMs - (deps.now() - started);
    if (remaining < 1) return err(llmError('TIMEOUT', `the call used its whole time limit of ${settings.timeoutMs} ms`));
    const number = ++counter.attempts as 1 | 2;
    emit({ type: 'request', attempt: number, model: model.value, timeoutMs: remaining, messages });
    const asked = deps.now();
    const failed = (error: LlmError): Result<Attempt, LlmError> => {
      emit({ type: 'failure', attempt: number, error, elapsedMs: deps.now() - asked });
      return err(error);
    };
    let result: Result<ModelResponse, LlmError>;
    try {
      result = await deps.client.complete({
        model: model.value,
        system: prompt.value.system,
        messages,
        outputSchema: prompt.value.outputSchema,
        meta: { capability: 'status', entryCount: input.entries.length, now: started, timeZone: input.timeZone ?? 'UTC', ...(window === undefined ? {} : { horizon: { name: window.horizon, fromDay: window.fromDay, toDay: window.toDay, maxPoints: deps.controls.status.settings.horizons[window.horizon].maxPoints } }) },
        maxOutputTokens: settings.maxOutputTokens,
        timeoutMs: remaining,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch {
      return failed(llmError('MODEL_ERROR', 'the model client threw instead of returning a result'));
    }
    if (!isObject(result) || typeof result.ok !== 'boolean') return failed(llmError('MODEL_ERROR', 'the model client returned something that is not a result'));
    if (!result.ok) return failed(result.error);
    const response = result.value;
    if (!isObject(response) || !isObject(response.output) || typeof response.model !== 'string' || !isObject(response.usage) || !isValidUsage(response.usage)) {
      return failed(llmError('MODEL_ERROR', 'the model client returned a reply that is not a valid response'));
    }
    emit({ type: 'response', attempt: number, output: response.output, usage: response.usage, model: response.model, elapsedMs: deps.now() - asked });
    const verdict = inspectStatusReply(response.output, guardContext, statusGuardSettingsOf(deps.controls.status.settings, input.horizon));
    emit({ type: 'verdict', attempt: number, accepted: verdict.ok, problems: verdict.ok ? [] : verdict.error });
    return ok({ response, verdict });
  };

  const first = await attempt(prompt.value.messages);
  if (!first.ok) return first;
  if (first.value.verdict.ok) return ok(answer(first.value.verdict.value, first.value.response.model, first.value.response.usage, 1));

  const feedback = `${cut(rejectionError(first.value.verdict.error).message)}\nReply again with the corrected JSON object only.`;
  const repairMessages: readonly ModelMessage[] = [...prompt.value.messages, { role: 'assistant', content: describeReply(first.value.response.output) }, { role: 'user', content: feedback }];
  emit({ type: 'repair', feedback });
  const second = await attempt(repairMessages);
  if (!second.ok) return second;
  const usage = addUsage(first.value.response.usage, second.value.response.usage);
  if (second.value.verdict.ok) return ok(answer(second.value.verdict.value, second.value.response.model, usage, 2));
  return err(llmError('BAD_OUTPUT', `${rejectionError(second.value.verdict.error).message} (still not accepted after one repair attempt)`));
}

function answer(reply: GuardedStatus, model: string, usage: TokenUsage, attempts: 1 | 2): StatusAnswer {
  return Object.freeze({
    headline: reply.headline,
    points: Object.freeze(reply.points.map((p) => Object.freeze({ text: p.text, refs: Object.freeze([...p.refs]) }))),
    nothing: reply.nothing,
    usage: Object.freeze({ ...NO_USAGE, ...usage }),
    model,
    attempts,
  });
}
