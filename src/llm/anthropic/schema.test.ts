import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../graph_store/index.js';
import { createLlm } from '../index.js';
import { createScriptedModelClient } from '../testing/index.js';
import { toProviderSchema } from './schema.js';

const convert = (schema: Record<string, unknown>) => {
  const r = toProviderSchema(schema as never);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe('toProviderSchema: what is kept', () => {
  it('keeps types, properties, required, items, descriptions and titles, and closes objects', () => {
    expect(
      convert({ type: 'object', title: 'T', description: 'D', properties: { a: { type: 'string', description: 'A' }, b: { type: 'array', items: { type: 'integer' } } }, required: ['a'] }),
    ).toEqual({
      type: 'object',
      title: 'T',
      description: 'D',
      properties: { a: { type: 'string', description: 'A' }, b: { type: 'array', items: { type: 'integer' } } },
      additionalProperties: false,
      required: ['a'],
    });
  });

  it('closes objects even when the input left them open or said so', () => {
    expect(convert({ type: 'object', additionalProperties: true }).additionalProperties).toBe(false);
    expect(convert({ type: 'object', properties: { x: { type: 'object' } } })).toMatchObject({ properties: { x: { additionalProperties: false } } });
  });

  it('turns oneOf into anyOf, and keeps anyOf and allOf', () => {
    const one = convert({ type: 'object', properties: { x: { oneOf: [{ type: 'string' }, { type: 'number' }] } } });
    expect(one.properties).toEqual({ x: { anyOf: [{ type: 'string' }, { type: 'number' }] } });
    expect(convert({ type: 'object', properties: { x: { anyOf: [{ type: 'null' }] } } }).properties).toEqual({ x: { anyOf: [{ type: 'null' }] } });
    expect(convert({ type: 'object', properties: { x: { allOf: [{ type: 'string' }] } } }).properties).toEqual({ x: { allOf: [{ type: 'string' }] } });
  });

  it('keeps $defs and $ref, converting the definitions too', () => {
    const out = convert({ type: 'object', properties: { a: { $ref: '#/$defs/Thing' } }, $defs: { Thing: { type: 'object', properties: { n: { type: 'string', maxLength: 5 } } } } });
    expect(out.properties).toEqual({ a: { $ref: '#/$defs/Thing' } });
    expect(out.$defs).toEqual({ Thing: { type: 'object', properties: { n: { type: 'string', description: '{maxLength: 5}' } }, additionalProperties: false } });
  });

  it('keeps supported string formats and minItems of 0 or 1', () => {
    const out = convert({ type: 'object', properties: { d: { type: 'string', format: 'date-time' }, l: { type: 'array', items: { type: 'string' }, minItems: 1 }, z: { type: 'array', items: { type: 'string' }, minItems: 0 } } });
    expect(out.properties).toEqual({ d: { type: 'string', format: 'date-time' }, l: { type: 'array', items: { type: 'string' }, minItems: 1 }, z: { type: 'array', items: { type: 'string' }, minItems: 0 } });
  });
});

describe('toProviderSchema: what moves into the description', () => {
  it('turns unsupported constraints into text, so the model still sees the rule', () => {
    const out = convert({ type: 'object', properties: { s: { type: 'string', maxLength: 500, pattern: '^a', description: 'Why' }, n: { type: 'number', minimum: 0, maximum: 1 }, a: { type: 'array', items: { type: 'string' }, maxItems: 25, minItems: 2 }, e: { type: 'string', enum: ['x', 'y'] }, c: { type: 'string', const: 'link' }, f: { type: 'string', format: 'weird' } } });
    expect(out.properties).toEqual({
      s: { type: 'string', description: 'Why\n\n{maxLength: 500, pattern: "^a"}' },
      n: { type: 'number', description: '{minimum: 0, maximum: 1}' },
      a: { type: 'array', items: { type: 'string' }, description: '{maxItems: 25, minItems: 2}' },
      e: { type: 'string', description: '{enum: ["x","y"]}' },
      c: { type: 'string', description: '{const: "link"}' },
      f: { type: 'string', description: '{format: "weird"}' },
    });
  });

  it('drops schema-document keywords without comment', () => {
    const out = convert({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'x', $comment: 'c', type: 'object' });
    expect(out).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });
});

describe('toProviderSchema: what it refuses', () => {
  it.each([
    ['a top level that is not an object', { type: 'array' }],
    ['no type at the top', { properties: {} }],
    ['a nested schema with no type', { type: 'object', properties: { x: { description: 'no type' } } }],
    ['a nested schema that is not an object', { type: 'object', properties: { x: true } }],
    ['an items that is not a schema', { type: 'object', properties: { x: { type: 'array', items: 5 } } }],
    ['a bad definition', { type: 'object', $defs: { d: { nothing: true } } }],
  ])('%s is a CONFIG error that says where', (_n, schema) => {
    const r = toProviderSchema(schema as never);
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFIG', retryable: false } });
    if (!r.ok) expect(r.error.message).toMatch(/^outputSchema: schema/);
  });
});

describe('toProviderSchema: purity', () => {
  it('does not change its input and gives the same answer every time', () => {
    const input = { type: 'object', properties: { s: { type: 'string', maxLength: 5 } }, oneOf: undefined } as Record<string, unknown>;
    delete input.oneOf;
    const frozen = JSON.stringify(input);
    expect(convert(input)).toEqual(convert(input));
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it('returns something independent of the input', () => {
    const input = { type: 'object', properties: { s: { type: 'string' } } };
    const out = convert(input) as { properties: { s: { type: string } } };
    out.properties.s.type = 'number';
    expect(input.properties.s.type).toBe('string');
  });
});

/** The schema the categoriser really sends, captured from a call made through the public API. */
async function categoriserSchema(): Promise<JsonObject> {
  const client = createScriptedModelClient([{ refusal: true }]);
  await createLlm({ client }).categorise({ text: 'a note', graphId: 'g', itemId: 'note-1', categories: [] });
  const schema = client.requests[0]?.outputSchema;
  if (schema === undefined) throw new Error('the categoriser sent no schema');
  return schema;
}

describe('the categoriser\'s real schema', () => {
  it('converts without error', async () => {
    const converted = convert(await categoriserSchema());
    expect(converted.type).toBe('object');
    expect(converted.additionalProperties).toBe(false);
  });

  it('keeps all three operation shapes, now as anyOf, with the limits in the description', async () => {
    const converted = convert(await categoriserSchema());
    const ops = (converted.properties as { ops: { type: string; items: { anyOf: Array<{ properties: { op: { description: string }; partition?: { description: string } } }> }; description: string } }).ops;
    expect(ops.type).toBe('array');
    expect(ops.items.anyOf).toHaveLength(3);
    expect(ops.description).toContain('maxItems: 25');
    expect(ops.items.anyOf.map((v) => v.properties.partition?.description ?? 'none')).toEqual(['{const: "item"}', '{const: "category"}', 'none']);
  });

  it('keeps the data shapes: closed objects with named, typed fields', async () => {
    const converted = convert(await categoriserSchema());
    const [item, category] = (converted.properties as { ops: { items: { anyOf: Array<{ properties: { data: unknown } }> } } }).ops.items.anyOf;
    expect(item?.properties.data).toMatchObject({ type: 'object', additionalProperties: false, required: ['title', 'summary'], properties: { title: { type: 'string' }, summary: { type: 'string' } } });
    expect(category?.properties.data).toMatchObject({ type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } });
  });

  it('is plain JSON of only the keywords the provider accepts', async () => {
    const converted = convert(await categoriserSchema());
    const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'allOf', '$defs', '$ref', 'description', 'title', 'format', 'minItems']);
    const walk = (node: unknown, path: string): string[] => {
      if (Array.isArray(node)) return node.flatMap((v, i) => walk(v, `${path}[${i}]`));
      if (typeof node !== 'object' || node === null) return [];
      return Object.entries(node).flatMap(([key, value]) => {
        const here = `${path}.${key}`;
        // inside "properties" and "$defs" the keys are names, not keywords
        if (key === 'properties' || key === '$defs') return Object.entries(value as object).flatMap(([name, v]) => walk(v, `${here}.${name}`));
        return [...(allowed.has(key) ? [] : [here]), ...walk(value, here)];
      });
    };
    expect(walk(converted, 'schema')).toEqual([]);
  });

  it('is looser than the original only by the constraints it moved into text: a good reply still passes, a wrong shape still fails', async () => {
    const original = await categoriserSchema();
    const converted = convert(original);
    const ajv = new Ajv2020({ strict: false });
    const strict = ajv.compile(original);
    const loose = ajv.compile(converted);
    const good = { ops: [{ op: 'upsertNode', partition: 'item', id: 'n', data: { title: 't', summary: 's' } }, { op: 'upsertNode', partition: 'category', id: 'c', data: { name: 'C' } }, { op: 'link', item: 'n', category: 'c', weight: 0.5 }], rationale: 'r' };
    expect(strict(good)).toBe(true);
    expect(loose(good)).toBe(true);
    for (const wrong of [{ ops: 'x' }, { ops: [{ op: 'link' }] }, { ops: [{ op: 'upsertNode', partition: 'item', id: 'n', data: { title: 'only a title' } }] }, { extra: 1, ops: [] }]) {
      expect(strict(wrong)).toBe(false);
      expect(loose(wrong), JSON.stringify(wrong)).toBe(false);
    }
    // What the provider cannot enforce is pairing a partition with its data shape (a `const` becomes text),
    // so an item carrying a category's data passes the converted schema. Only the original schema refuses it.
    const mismatched = { ops: [{ op: 'upsertNode', partition: 'item', id: 'n', data: { name: 'x' } }] };
    expect(strict(mismatched)).toBe(false);
    expect(loose(mismatched)).toBe(true);
  });

  it('accepts exactly what the model is told it may write: any json the converted schema allows, the guard also reads', async () => {
    // every object closed means free-form `data` cannot sneak back in
    const text = JSON.stringify(convert(await categoriserSchema()));
    expect(text).not.toContain('propertyNames');
    expect(text).not.toContain('"additionalProperties":{');
  });
});
