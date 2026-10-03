import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CAPABILITIES,
  createLlmConfig,
  DEFAULT_ROUTES,
  DEFAULT_TIERS,
  MODEL_TIERS,
  resolveModel,
  type Capability,
  type CapabilityRoute,
  type LlmConfig,
  type LlmConfigInput,
  type ModelChoice,
  type ModelTier,
} from './config.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';

function config(input?: LlmConfigInput): LlmConfig {
  const r = createLlmConfig(input);
  if (!r.ok) throw new Error(`config was rejected: ${r.error.message}`);
  return r.value;
}
function resolved(cfg: LlmConfig, choice?: ModelChoice, capability: Capability = 'categorise'): string {
  const r = resolveModel(cfg, capability, choice);
  if (!r.ok) throw new Error(`resolve failed: ${r.error.message}`);
  return r.value;
}

describe('defaults', () => {
  it('has three tiers: fast is Haiku 4.5, balanced is Sonnet 5.5, deep is Opus 5.5', () => {
    expect([...MODEL_TIERS]).toEqual(['fast', 'balanced', 'deep']);
    expect(DEFAULT_TIERS).toEqual({ fast: HAIKU, balanced: SONNET, deep: OPUS });
  });

  it('routes categorise to the fast tier', () => {
    expect(DEFAULT_ROUTES.categorise).toEqual({ tier: 'fast' });
    expect([...CAPABILITIES]).toEqual(['categorise']);
  });

  it('a config made with no input is exactly the defaults', () => {
    expect(config()).toEqual({ tiers: DEFAULT_TIERS, capabilities: DEFAULT_ROUTES });
    expect(config({})).toEqual(config());
    expect(config({ tiers: {}, capabilities: {} })).toEqual(config());
  });

  it('categorise resolves to Haiku with nothing configured', () => {
    expect(resolved(config())).toBe(HAIKU);
  });

  it('is frozen all the way down, and the defaults cannot be changed', () => {
    const cfg = config();
    for (const frozen of [cfg, cfg.tiers, cfg.capabilities, cfg.capabilities.categorise, DEFAULT_TIERS, DEFAULT_ROUTES]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
    expect(() => {
      (cfg.tiers as Record<string, string>).fast = 'x';
    }).toThrow(TypeError);
  });
});

describe('overriding the configuration', () => {
  it('overrides one tier and leaves the others at their defaults', () => {
    expect(config({ tiers: { deep: 'my-deep-model' } }).tiers).toEqual({ fast: HAIKU, balanced: SONNET, deep: 'my-deep-model' });
  });

  it('routes a capability to another tier', () => {
    const cfg = config({ capabilities: { categorise: { tier: 'deep' } } });
    expect(resolved(cfg)).toBe(OPUS);
  });

  it('routes a capability to one exact model, which is not looked up in the tier table', () => {
    const cfg = config({ capabilities: { categorise: { model: 'some-provider/special-model:1' } } });
    expect(resolved(cfg)).toBe('some-provider/special-model:1');
  });

  it('a capability routed by tier follows a changed tier model', () => {
    expect(resolved(config({ tiers: { fast: 'cheaper-model' } }))).toBe('cheaper-model');
    expect(resolved(config({ tiers: { fast: 'cheaper-model' }, capabilities: { categorise: { tier: 'balanced' } } }))).toBe(SONNET);
  });

  it('a capability routed to an exact model does not follow tier changes', () => {
    const cfg = config({ tiers: { fast: 'cheaper-model' }, capabilities: { categorise: { model: 'pinned' } } });
    expect(resolved(cfg)).toBe('pinned');
  });

  it('accepts model ids as providers write them', () => {
    for (const model of ['claude-haiku-4-5-20251001', 'anthropic.claude-3-haiku:0', 'org/model@v2', 'gpt_like.model-1', 'x']) {
      expect(config({ tiers: { fast: model } }).tiers.fast).toBe(model);
    }
  });
});

describe('resolveModel: a model chosen for one call beats the configuration', () => {
  const cfg = config({ capabilities: { categorise: { tier: 'balanced' } }, tiers: { deep: 'custom-deep' } });

  it.each([
    ['nothing chosen: the capability route (balanced)', {}, SONNET],
    ['a tier chosen for the call beats the capability route', { tier: 'fast' }, HAIKU],
    ['a tier chosen for the call resolves through the tier table', { tier: 'deep' }, 'custom-deep'],
    ['an exact model chosen for the call beats the capability route', { model: 'one-off' }, 'one-off'],
    ['an exact model beats a tier chosen for the same call', { model: 'one-off', tier: 'fast' }, 'one-off'],
    ['an exact model is used as given, even if it looks like a tier name', { model: 'fast' }, 'fast'],
  ] as Array<[string, ModelChoice, string]>)('%s', (_name, choice, expected) => {
    expect(resolved(cfg, choice)).toBe(expected);
  });

  it('beats a capability pinned to an exact model too', () => {
    const pinned = config({ capabilities: { categorise: { model: 'pinned' } } });
    expect(resolved(pinned, { tier: 'deep' })).toBe(OPUS);
    expect(resolved(pinned, { model: 'one-off' })).toBe('one-off');
    expect(resolved(pinned)).toBe('pinned');
  });

  it('every precedence combination: call model, then call tier, then capability route', () => {
    const calls: Array<ModelChoice | undefined> = [undefined, {}, { tier: 'fast' }, { tier: 'deep' }, { model: 'm' }, { model: 'm', tier: 'deep' }];
    const routes: CapabilityRoute[] = [{ tier: 'fast' }, { tier: 'deep' }, { model: 'pinned' }];
    for (const route of routes) {
      const c = config({ capabilities: { categorise: route } });
      for (const call of calls) {
        const expected =
          call?.model !== undefined ? call.model : call?.tier !== undefined ? DEFAULT_TIERS[call.tier] : 'tier' in route ? DEFAULT_TIERS[route.tier] : route.model;
        expect(resolved(c, call)).toBe(expected);
      }
    }
  });
});

describe('bad configuration is a CONFIG error that says where', () => {
  const problems: Array<[string, unknown, RegExp]> = [
    ['an unknown tier name', { tiers: { turbo: 'm' } }, /config\.tiers.*unknown tier "turbo".*known: fast, balanced, deep/],
    ['an empty model id for a tier', { tiers: { fast: '' } }, /config\.tiers\.fast.*must not be empty/],
    ['a model id that is only spaces', { tiers: { fast: '   ' } }, /config\.tiers\.fast.*spaces/],
    ['a model id with a space inside', { tiers: { fast: 'my model' } }, /spaces or control/],
    ['a model id with a newline', { tiers: { fast: 'm\nx' } }, /spaces or control/],
    ['a model id that is not a string', { tiers: { fast: 5 } }, /config\.tiers\.fast.*must be a string/],
    ['a model id that is far too long', { tiers: { fast: 'x'.repeat(201) } }, /too long/],
    ['tiers that are not an object', { tiers: ['fast'] }, /config\.tiers.*must be an object/],
    ['an unknown capability', { capabilities: { answer: { tier: 'deep' } } }, /unknown capability "answer".*known: categorise/],
    ['a route to an unknown tier', { capabilities: { categorise: { tier: 'fats' } } }, /config\.capabilities\.categorise\.tier.*unknown tier "fats"/],
    ['a route with both a tier and a model', { capabilities: { categorise: { tier: 'fast', model: 'm' } } }, /exactly one of tier or model/],
    ['a route with neither', { capabilities: { categorise: {} } }, /exactly one of tier or model/],
    ['a route with an empty model', { capabilities: { categorise: { model: '' } } }, /config\.capabilities\.categorise\.model.*empty/],
    ['a route with an unknown field', { capabilities: { categorise: { tier: 'fast', temperature: 0 } } }, /unknown field "temperature"/],
    ['a route that is a bare string', { capabilities: { categorise: 'fast' } }, /route must be an object/],
    ['capabilities that are not an object', { capabilities: 'categorise' }, /config\.capabilities.*must be an object/],
    ['an unknown top-level field', { tier: { fast: 'm' } }, /unknown field "tier".*use tiers or capabilities/],
    ['a config that is not an object', 'fast', /must be an object/],
    ['a config that is an array', [], /must be an object/],
    ['a config that is null', null, /must be an object/],
  ];

  it.each(problems)('%s', (_name, input, message) => {
    const r = createLlmConfig(input as LlmConfigInput);
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFIG', retryable: false } });
    if (!r.ok) expect(r.error.message).toMatch(message);
  });

  it('never throws, even for hostile input', () => {
    const hostile = { get tiers(): never { throw new Error('boom'); } };
    expect(createLlmConfig(hostile as never)).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
    const proxy = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
    expect(createLlmConfig(proxy as never)).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
  });

  it('stops at the first problem and keeps nothing from a rejected config', () => {
    expect(createLlmConfig({ tiers: { fast: 'ok', deep: '' } })).toMatchObject({ ok: false });
    expect(resolved(config())).toBe(HAIKU);
  });
});

describe('resolveModel refuses bad choices with a CONFIG error', () => {
  const cfg = config();
  it.each([
    ['an unknown capability', ['answer', {}]],
    ['an unknown tier for the call', ['categorise', { tier: 'turbo' }]],
    ['an empty model for the call', ['categorise', { model: '' }]],
    ['a model with a space for the call', ['categorise', { model: 'a b' }]],
    ['a model that is not text', ['categorise', { model: 7 }]],
    ['a choice that is not an object', ['categorise', 'fast']],
    ['a choice that is null', ['categorise', null]],
  ] as Array<[string, [string, unknown]]>)('%s', (_name, [capability, choice]) => {
    expect(resolveModel(cfg, capability as Capability, choice as ModelChoice)).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
  });

  it('never throws on a hostile choice or config', () => {
    const hostile = { get model(): never { throw new Error('boom'); } };
    expect(resolveModel(cfg, 'categorise', hostile as never)).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
    expect(resolveModel(null as never, 'categorise')).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
  });
});

describe('purity', () => {
  it('does not change its input, and the config does not follow later edits to it', () => {
    const input = { tiers: { fast: 'mine' }, capabilities: { categorise: { tier: 'deep' as const } } };
    const snapshot = JSON.stringify(input);
    const cfg = config(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    input.tiers.fast = 'changed-after';
    input.capabilities.categorise.tier = 'fast' as never;
    expect(cfg.tiers.fast).toBe('mine');
    expect(cfg.capabilities.categorise).toEqual({ tier: 'deep' });
  });

  it('accepts a frozen input', () => {
    const input = Object.freeze({ tiers: Object.freeze({ fast: 'mine' }) });
    expect(config(input).tiers.fast).toBe('mine');
  });

  it('gives the same answer every time', () => {
    const cfg = config({ capabilities: { categorise: { tier: 'balanced' } } });
    expect(resolveModel(cfg, 'categorise', { tier: 'deep' })).toEqual(resolveModel(cfg, 'categorise', { tier: 'deep' }));
    expect(createLlmConfig({ tiers: { fast: 'a' } })).toEqual(createLlmConfig({ tiers: { fast: 'a' } }));
  });

  it('two configs are independent of each other', () => {
    const a = config({ tiers: { fast: 'a' } });
    const b = config({ tiers: { fast: 'b' } });
    expect([a.tiers.fast, b.tiers.fast, config().tiers.fast]).toEqual(['a', 'b', HAIKU]);
  });
});

describe('types', () => {
  it('a route is exactly a tier or a model, never both and never neither', () => {
    const tier: CapabilityRoute = { tier: 'fast' };
    const model: CapabilityRoute = { model: 'm' };
    // @ts-expect-error a route needs a tier or a model
    const neither: CapabilityRoute = {};
    expect([tier, model, neither]).toHaveLength(3);
    expectTypeOf<ModelTier>().toEqualTypeOf<'fast' | 'balanced' | 'deep'>();
    expectTypeOf<Capability>().toEqualTypeOf<'categorise'>();
  });
});
