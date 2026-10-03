import { describe, expect, it, vi } from 'vitest';

// `write` is meant never to throw, but if it ever did, the proposal must not be lost: it was taken
// out of the store before the write started, so it has to be put back.
vi.mock('../graph_store/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../graph_store/index.js')>();
  const state = globalThis as { __writeThrows?: boolean };
  return { ...actual, write: (...args: Parameters<typeof actual.write>) => (state.__writeThrows === true ? Promise.reject(new Error('surprise')) : actual.write(...args)) };
});

import { NOTE, EXISTING, setup } from './controller-fixture.test-util.js';

describe('approve when write throws', () => {
  it('keeps the proposal and reports UNEXPECTED without the message', async () => {
    const s = await setup({ existing: EXISTING });
    const p = await s.controller.propose('notes', NOTE);
    if (!p.ok) throw new Error('expected a proposal');
    (globalThis as { __writeThrows?: boolean }).__writeThrows = true;
    try {
      const r = await s.controller.approve(p.value.id);
      expect(r).toMatchObject({ ok: false, error: { source: 'app', error: { code: 'UNEXPECTED' } } });
      expect(JSON.stringify(r)).not.toContain('surprise');
      expect(s.controller.get(p.value.id)).toBe(p.value);
    } finally {
      (globalThis as { __writeThrows?: boolean }).__writeThrows = false;
    }
    expect((await s.controller.approve(p.value.id)).ok).toBe(true);
  });
});
