import { describe, expect, it } from 'vitest';
import { world } from './controller.test-util.js';

describe('mode', () => {
  it('says demo by default, and anthropic when the operator chose it, and nothing else', async () => {
    const demo = await world();
    expect(await demo.caci.mode(demo.tokens.ann)).toEqual({ ok: true, value: { mode: 'demo' } });
    const real = await world({ mode: 'anthropic' });
    const r = await real.caci.mode(real.tokens.ann);
    expect(r).toEqual({ ok: true, value: { mode: 'anthropic' } });
    expect(Object.keys((r as { value: object }).value)).toEqual(['mode']);
  });

  it('is frozen, and asks no model', async () => {
    const w = await world();
    const r = await w.caci.mode(w.tokens.ann);
    expect(Object.isFrozen((r as { value: object }).value)).toBe(true);
    expect(w.modelCalls).toHaveLength(0);
  });

  it('needs a session: signed out, a made-up token, nonsense', async () => {
    const w = await world();
    for (const token of [undefined, null, '', 'nope', 5, {}, w.tokens.ann + 'x']) {
      expect(await w.caci.mode(token), String(token)).toMatchObject({ ok: false, error: { source: 'caci', error: { code: 'UNAUTHENTICATED' } } });
    }
  });

  it('is the same for every account, and the same as the mode on a proposal', async () => {
    const w = await world({ mode: 'anthropic', people: ['ann', 'bob'] });
    expect(await w.caci.mode(w.tokens.bob)).toEqual(await w.caci.mode(w.tokens.ann));
    const made = await w.caci.propose(w.tokens.ann, { text: 'a note about boats' });
    expect(made).toMatchObject({ ok: true, value: { mode: 'anthropic' } });
  });
});
