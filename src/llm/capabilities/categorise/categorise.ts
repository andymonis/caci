import { err, ok, type Result } from '../../../graph_store/index.js';
import { resolveModel, type LlmConfig, type ModelTier } from '../../config.js';
import { llmError, type LlmError } from '../../errors.js';
import type { ModelClient, ModelMessage, ModelOutput, ModelResponse } from '../../model-client.js';
import { addUsage, isValidUsage, NO_USAGE, type TokenUsage } from '../../usage.js';
import { buildContext, CATEGORISE_OPS, type CategoryEntry, type ContextOptions } from './context.js';
import { guardReply, type GuardedReply } from './guard.js';
import { buildPrompt, DEFAULT_PROMPT_OPTIONS } from './prompt.js';

/** What the controller hands over for one note. */
export interface CategoriseInput {
  /** The note, as the person wrote it. */
  readonly text: string;
  /** The graph the proposal is for. The model never chooses it. */
  readonly graphId: string;
  /** The id the controller minted for the note's item. The model must use exactly this. */
  readonly itemId: string;
  readonly requestId?: string;
  /** The categories that exist now (the controller reads them from the graph). */
  readonly categories: readonly CategoryEntry[];
}

export interface CategoriseOptions {
  /** Use this exact model for the call. Beats `tier` and the configured route. */
  readonly model?: string;
  /** Use this tier's model for the call. */
  readonly tier?: ModelTier;
  readonly signal?: AbortSignal;
  /** The whole call, including a repair attempt, must finish within this. Default 30,000. */
  readonly timeoutMs?: number;
  /** Most tokens the model may write in one attempt. Default 4,000. */
  readonly maxOutputTokens?: number;
  /** Most operations a proposal may hold. Told to the model and enforced on its reply. Default 25. */
  readonly maxOps?: number;
  readonly maxTextChars?: number;
  readonly maxContextChars?: number;
  readonly context?: ContextOptions;
}

/** What the model suggests, ready to preview. Nothing has been written. */
export interface Proposal {
  /** A mutation the controller can preview and, once approved, pass to `write`. */
  readonly mutation: GuardedReply['mutation'];
  readonly rationale?: string;
  /** Tokens used across all attempts. */
  readonly usage: TokenUsage;
  /** The model that answered. */
  readonly model: string;
  /** 1, or 2 when the first reply was rejected and the repair attempt was needed. */
  readonly attempts: 1 | 2;
}

export interface CategoriseDeps {
  readonly client: ModelClient;
  readonly config: LlmConfig;
  /** The clock, in milliseconds. Tests replace it. */
  readonly now: () => number;
}

export const DEFAULT_CATEGORISE_OPTIONS = Object.freeze({ timeoutMs: 30_000, maxOutputTokens: 4000 });

const INPUT_FIELDS: readonly string[] = Object.freeze(['text', 'graphId', 'itemId', 'requestId', 'categories']);
const OPTION_FIELDS: readonly string[] = Object.freeze(['model', 'tier', 'signal', 'timeoutMs', 'maxOutputTokens', 'maxOps', 'maxTextChars', 'maxContextChars', 'context']);
const NUMBER_OPTIONS: readonly string[] = Object.freeze(['timeoutMs', 'maxOutputTokens', 'maxOps', 'maxTextChars', 'maxContextChars']);
/** The most of a rejected reply, or of the reasons, that is sent back for the repair attempt. */
const ECHO_LIMIT = 4000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const config = (message: string): LlmError => llmError('CONFIG', message);
const cut = (text: string): string => (text.length > ECHO_LIMIT ? `${text.slice(0, ECHO_LIMIT)}… (cut)` : text);

function checkOptions(options: unknown): LlmError | undefined {
  if (options === undefined) return undefined;
  if (!isObject(options)) return config('categorise options: must be an object');
  for (const key of Object.keys(options)) if (!OPTION_FIELDS.includes(key)) return config(`categorise options: unknown option "${key}"`);
  for (const key of NUMBER_OPTIONS) {
    const value = options[key];
    if (value !== undefined && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 1)) return config(`categorise options.${key}: must be a positive whole number`);
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) return config('categorise options.signal: must be an AbortSignal');
  return undefined;
}

/** Checks the input's own fields, including the ids the guard will later enforce, before any model call is paid for. */
function checkInput(input: unknown): LlmError | undefined {
  if (!isObject(input)) return config('categorise input: must be an object like { text, graphId, itemId, categories }');
  for (const key of Object.keys(input)) if (!INPUT_FIELDS.includes(key)) return config(`categorise input: unknown field "${key}"`);
  const { graphId, itemId, requestId, categories } = input;
  if (typeof graphId !== 'string' || typeof itemId !== 'string') return config('categorise input: graphId and itemId must be text');
  if (requestId !== undefined && typeof requestId !== 'string') return config('categorise input.requestId: must be text');
  if (!Array.isArray(categories)) return config('categorise input.categories: must be a list (it may be empty)');
  // A made-up good reply for these ids: if the guard would refuse the ids, say so now rather than after the model has answered.
  const probe = guardReply(
    { kind: 'json', value: { ops: [{ op: 'upsertNode', partition: 'item', id: itemId }, { op: 'link', item: itemId, category: 'probe' }] } },
    { graphId, itemId, ...(requestId === undefined ? {} : { requestId }) },
  );
  return probe.ok ? undefined : config(`categorise input.graphId, itemId or requestId: ${probe.error.message.replace('The reply was not accepted: ', '')}`);
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
  readonly verdict: Result<GuardedReply, LlmError>;
}

/**
 * Suggests how to file one note. Builds the context and prompt, asks the model, and checks the
 * reply with the output guard. If the guard rejects it, the reasons go back to the model once;
 * a second rejection ends the call. Everything runs inside one time limit, honours cancellation,
 * and never throws. Nothing is written: the result is a proposal for a person to approve.
 */
export async function categorise(deps: CategoriseDeps, input: CategoriseInput, options?: CategoriseOptions): Promise<Result<Proposal, LlmError>> {
  try {
    const started = deps.now();
    const optionProblem = checkOptions(options);
    if (optionProblem !== undefined) return err(optionProblem);
    const inputProblem = checkInput(input);
    if (inputProblem !== undefined) return err(inputProblem);
    const settings = { ...DEFAULT_CATEGORISE_OPTIONS, maxOps: DEFAULT_PROMPT_OPTIONS.maxOps, ...options };

    const model = resolveModel(deps.config, 'categorise', {
      ...(settings.model === undefined ? {} : { model: settings.model }),
      ...(settings.tier === undefined ? {} : { tier: settings.tier }),
    });
    if (!model.ok) return model;

    const context = buildContext({ categories: input.categories, allowedOps: CATEGORISE_OPS }, options?.context);
    if (!context.ok) return context;
    const prompt = buildPrompt(
      { text: input.text, context: context.value.text, itemId: input.itemId },
      {
        maxOps: settings.maxOps,
        ...(options?.maxTextChars === undefined ? {} : { maxTextChars: options.maxTextChars }),
        ...(options?.maxContextChars === undefined ? {} : { maxContextChars: options.maxContextChars }),
      },
    );
    if (!prompt.ok) return prompt;

    const guardContext = { graphId: input.graphId, itemId: input.itemId, ...(input.requestId === undefined ? {} : { requestId: input.requestId }) };

    const attempt = async (messages: readonly ModelMessage[]): Promise<Result<Attempt, LlmError>> => {
      if (options?.signal?.aborted === true) return err(llmError('CANCELLED', 'the call was cancelled'));
      const remaining = settings.timeoutMs - (deps.now() - started);
      if (remaining < 1) return err(llmError('TIMEOUT', `the call used its whole time limit of ${settings.timeoutMs} ms`));
      let result: Result<ModelResponse, LlmError>;
      try {
        result = await deps.client.complete({
          model: model.value,
          system: prompt.value.system,
          messages,
          outputSchema: prompt.value.outputSchema,
          maxOutputTokens: settings.maxOutputTokens,
          timeoutMs: remaining,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch {
        return err(llmError('MODEL_ERROR', 'the model client threw instead of returning a result'));
      }
      if (!isObject(result) || typeof result.ok !== 'boolean') return err(llmError('MODEL_ERROR', 'the model client returned something that is not a result'));
      if (!result.ok) return result;
      const response = result.value;
      if (!isObject(response) || !isObject(response.output) || typeof response.model !== 'string' || !isObject(response.usage) || !isValidUsage(response.usage)) {
        return err(llmError('MODEL_ERROR', 'the model client returned a reply that is not a valid response'));
      }
      return ok({ response, verdict: guardReply(response.output, guardContext, { maxOps: settings.maxOps }) });
    };

    const first = await attempt(prompt.value.messages);
    if (!first.ok) return first;
    if (first.value.verdict.ok) return ok(propose(first.value.verdict.value, first.value.response.model, first.value.response.usage, 1));

    const repairMessages: readonly ModelMessage[] = [
      ...prompt.value.messages,
      { role: 'assistant', content: describeReply(first.value.response.output) },
      { role: 'user', content: `${cut(first.value.verdict.error.message)}\nReply again with the corrected JSON object only.` },
    ];
    const second = await attempt(repairMessages);
    if (!second.ok) return second;
    const usage = addUsage(first.value.response.usage, second.value.response.usage);
    if (second.value.verdict.ok) return ok(propose(second.value.verdict.value, second.value.response.model, usage, 2));
    return err(llmError('BAD_OUTPUT', `${second.value.verdict.error.message} (still not accepted after one repair attempt)`));
  } catch {
    return err(llmError('MODEL_ERROR', 'categorise failed unexpectedly'));
  }
}

function propose(reply: GuardedReply, model: string, usage: TokenUsage, attempts: 1 | 2): Proposal {
  return Object.freeze({
    mutation: reply.mutation,
    ...(reply.rationale === undefined ? {} : { rationale: reply.rationale }),
    usage: Object.freeze({ ...NO_USAGE, ...usage }),
    model,
    attempts,
  });
}
