import { describe, expect, it, vi } from 'vitest';

// The output schema must be built from the real mutation schema each time, not copied. To prove it,
// replace the real schema with a changed one and check the change shows up.
vi.mock('../../../graph_store/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../graph_store/index.js')>();
  const changed = structuredClone(actual.mutationJsonSchema()) as { properties: { ops: { items: { oneOf: Array<{ properties: Record<string, unknown> }> } } } };
  const link = changed.properties.ops.items.oneOf.find((v) => (v.properties.op as { const: string }).const === 'link');
  if (link) link.properties.confidence = { type: 'number', minimum: 0, maximum: 1 };
  return { ...actual, mutationJsonSchema: () => ((globalThis as { __brokenShape?: boolean }).__brokenShape ? {} : changed) };
});

import { buildOutputSchema } from './prompt.js';

describe('the output schema follows the real schema', () => {
  it('picks up a field added to the real operation definition', () => {
    const r = buildOutputSchema(['link'], 5);
    expect(r.ok && JSON.stringify(r.value)).toContain('"confidence"');
  });

  it('is a CONFIG error, not a wrong schema, if the real schema changes shape', () => {
    (globalThis as { __brokenShape?: boolean }).__brokenShape = true;
    try {
      expect(buildOutputSchema(['link'], 5)).toMatchObject({ ok: false, error: { code: 'CONFIG', message: expect.stringContaining('expected shape') } });
    } finally {
      (globalThis as { __brokenShape?: boolean }).__brokenShape = false;
    }
  });
});
