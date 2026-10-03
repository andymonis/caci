import { err, ok, type Result } from '../graph_store/index.js';
import { llmError, type LlmError } from './errors.js';

/**
 * Which model does the work is configuration, not code. Models come in three tiers by how much
 * they can do and cost: a cheap fast one for simple jobs such as categorising, a balanced one, and
 * a deep one for hard jobs. Each capability is routed to a tier (or to one exact model).
 */
export const MODEL_TIERS = ['fast', 'balanced', 'deep'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** The things the LLM component can do. A new capability adds its name here and a default route below. */
export const CAPABILITIES = ['categorise'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** A capability uses either a tier (resolved through the tier table) or one exact model id. */
export type CapabilityRoute = { readonly tier: ModelTier } | { readonly model: string };

/** What a caller may give: everything is optional, and anything left out takes its default. */
export interface LlmConfigInput {
  readonly tiers?: Partial<Record<ModelTier, string>>;
  readonly capabilities?: Partial<Record<Capability, CapabilityRoute>>;
}

/** The complete, checked configuration. */
export interface LlmConfig {
  readonly tiers: Readonly<Record<ModelTier, string>>;
  readonly capabilities: Readonly<Record<Capability, CapabilityRoute>>;
}

/** Defaults, provisional until the evaluation harness compares the tiers on real inputs. */
export const DEFAULT_TIERS: Readonly<Record<ModelTier, string>> = Object.freeze({
  fast: 'claude-haiku-4-5-20251001',
  balanced: 'claude-sonnet-5-5',
  deep: 'claude-opus-5-5',
});

/** Categorising is a simple job, so it starts on the fast tier. Heavier future capabilities start on `deep`. */
export const DEFAULT_ROUTES: Readonly<Record<Capability, CapabilityRoute>> = Object.freeze({
  categorise: Object.freeze({ tier: 'fast' }),
});

/** Chosen for one call: it beats the configuration. `model` wins over `tier` if both are given. */
export interface ModelChoice {
  readonly model?: string;
  readonly tier?: ModelTier;
}

const bad = (where: string, message: string) => err(llmError('CONFIG', `${where}: ${message}`));
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTier = (value: unknown): value is ModelTier => (MODEL_TIERS as readonly unknown[]).includes(value);
const isCapability = (value: unknown): value is Capability => (CAPABILITIES as readonly unknown[]).includes(value);

/** A model id as providers write them: non-empty, no whitespace or control characters, a sane length. */
function modelIdProblem(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'a model id must be a string';
  if (value.length === 0) return 'a model id must not be empty';
  if (value.length > 200) return 'a model id is too long (over 200 characters)';
  if ([...value].some((ch) => /\s/.test(ch) || ch.charCodeAt(0) <= 0x1f || ch.charCodeAt(0) === 0x7f)) {
    return 'a model id must not contain spaces or control characters';
  }
  return undefined;
}

const known = (list: readonly string[]) => `known: ${list.join(', ')}`;

function checkRoute(where: string, route: unknown): LlmError | undefined {
  if (!isObject(route)) return llmError('CONFIG', `${where}: a route must be an object like { tier: "fast" } or { model: "some-model-id" }`);
  const { tier, model, ...extra } = route;
  const unknownKey = Object.keys(extra)[0];
  if (unknownKey !== undefined) return llmError('CONFIG', `${where}: unknown field "${unknownKey}" (use tier or model)`);
  if ((tier === undefined) === (model === undefined)) return llmError('CONFIG', `${where}: give exactly one of tier or model`);
  if (tier !== undefined && !isTier(tier)) return llmError('CONFIG', `${where}.tier: unknown tier ${JSON.stringify(tier)} (${known(MODEL_TIERS)})`);
  if (model !== undefined) {
    const problem = modelIdProblem(model);
    if (problem !== undefined) return llmError('CONFIG', `${where}.model: ${problem}`);
  }
  return undefined;
}

/**
 * Checks what a caller gave and fills in the defaults. Pure; never throws. Anything unexpected
 * (an unknown tier, capability or field, an empty model id) is a `CONFIG` error that says where.
 * Reading environment variables or files belongs to the application, not here.
 */
export function createLlmConfig(input?: LlmConfigInput): Result<LlmConfig, LlmError> {
  try {
    if (input !== undefined && !isObject(input)) return bad('config', 'must be an object like { tiers, capabilities }');
    const { tiers, capabilities, ...extra } = (input ?? {}) as Record<string, unknown>;
    const unknownKey = Object.keys(extra)[0];
    if (unknownKey !== undefined) return bad('config', `unknown field "${unknownKey}" (use tiers or capabilities)`);

    const resolvedTiers: Record<ModelTier, string> = { ...DEFAULT_TIERS };
    if (tiers !== undefined) {
      if (!isObject(tiers)) return bad('config.tiers', 'must be an object mapping tier names to model ids');
      for (const [name, model] of Object.entries(tiers)) {
        if (!isTier(name)) return bad('config.tiers', `unknown tier ${JSON.stringify(name)} (${known(MODEL_TIERS)})`);
        const problem = modelIdProblem(model);
        if (problem !== undefined) return bad(`config.tiers.${name}`, problem);
        resolvedTiers[name] = model as string;
      }
    }

    const resolvedRoutes: Record<Capability, CapabilityRoute> = { ...DEFAULT_ROUTES };
    if (capabilities !== undefined) {
      if (!isObject(capabilities)) return bad('config.capabilities', 'must be an object mapping capability names to routes');
      for (const [name, route] of Object.entries(capabilities)) {
        if (!isCapability(name)) return bad('config.capabilities', `unknown capability ${JSON.stringify(name)} (${known(CAPABILITIES)})`);
        const problem = checkRoute(`config.capabilities.${name}`, route);
        if (problem !== undefined) return err(problem);
        const r = route as { tier?: ModelTier; model?: string };
        resolvedRoutes[name] = Object.freeze(r.tier !== undefined ? { tier: r.tier } : { model: r.model as string });
      }
    }
    return ok(Object.freeze({ tiers: Object.freeze(resolvedTiers), capabilities: Object.freeze(resolvedRoutes) }));
  } catch {
    return bad('config', 'could not be read');
  }
}

/**
 * Which model id to use for a capability. A model chosen for this call wins, then a tier chosen for
 * this call, then the capability's route from the configuration. Tier names always resolve through
 * the configuration's tier table, so changing a tier's model changes every capability routed to it.
 * Pure; never throws.
 */
export function resolveModel(config: LlmConfig, capability: Capability, choice: ModelChoice = {}): Result<string, LlmError> {
  try {
    if (!isCapability(capability)) return bad('capability', `unknown capability ${JSON.stringify(capability)} (${known(CAPABILITIES)})`);
    if (!isObject(choice)) return bad('choice', 'must be an object like { model } or { tier }');
    if (choice.model !== undefined) {
      const model: unknown = choice.model;
      const problem = modelIdProblem(model);
      return problem === undefined && typeof model === 'string' ? ok(model) : bad('choice.model', problem ?? 'a model id must be a string');
    }
    if (choice.tier !== undefined) {
      return isTier(choice.tier) ? ok(config.tiers[choice.tier]) : bad('choice.tier', `unknown tier ${JSON.stringify(choice.tier)} (${known(MODEL_TIERS)})`);
    }
    const route = config.capabilities[capability];
    return ok('tier' in route ? config.tiers[route.tier] : route.model);
  } catch {
    return bad('config', 'could not be read');
  }
}
