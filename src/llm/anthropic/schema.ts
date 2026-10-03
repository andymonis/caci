import { err, ok, type JsonObject, type JsonValue, type Result } from '../../graph_store/index.js';
import { llmError, type LlmError } from '../errors.js';

/**
 * The provider's structured output accepts only part of JSON Schema. This keeps what it accepts
 * (types, properties, required, items, `anyOf`, `$defs`/`$ref`, descriptions, a few string formats,
 * `minItems` of 0 or 1) and turns every other constraint (`maxItems`, `maxLength`, `const`, `enum`,
 * patterns, ranges) into text in the `description`, so the model still sees the rule but the
 * provider is not asked to enforce what it cannot. `oneOf` becomes `anyOf`, and objects are closed
 * (`additionalProperties: false`). The rules follow the Anthropic SDK's own schema helper, which is
 * not part of its public API.
 *
 * The caller's own checks (for the categoriser, the output guard) are what enforce the full schema.
 */

const STRING_FORMATS: readonly string[] = Object.freeze(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);
/** Keywords about the schema document itself, not about the data. Dropped without comment. */
const DOCUMENT_KEYS: readonly string[] = Object.freeze(['$schema', '$id', '$comment']);

class Unsupported extends Error {}

const isObject = (value: unknown): value is Record<string, JsonValue> => typeof value === 'object' && value !== null && !Array.isArray(value);

function take(schema: Record<string, JsonValue>, key: string): JsonValue | undefined {
  const value = schema[key];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete schema[key];
  return value;
}

function convert(input: JsonValue, path: string): JsonObject {
  if (!isObject(input)) throw new Unsupported(`${path}: must be an object schema`);
  const rest: Record<string, JsonValue> = { ...input };
  for (const key of DOCUMENT_KEYS) take(rest, key);
  const out: Record<string, JsonValue> = {};

  const defs = take(rest, '$defs');
  if (isObject(defs)) out.$defs = Object.fromEntries(Object.entries(defs).map(([name, schema]) => [name, convert(schema, `${path}.$defs.${name}`)]));
  const ref = take(rest, '$ref');
  if (ref !== undefined) {
    out.$ref = ref;
    return out;
  }

  const type = take(rest, 'type');
  const anyOf = take(rest, 'anyOf');
  const oneOf = take(rest, 'oneOf');
  const allOf = take(rest, 'allOf');
  if (Array.isArray(anyOf)) out.anyOf = anyOf.map((v, i) => convert(v, `${path}.anyOf[${i}]`));
  else if (Array.isArray(oneOf)) out.anyOf = oneOf.map((v, i) => convert(v, `${path}.oneOf[${i}]`));
  else if (Array.isArray(allOf)) out.allOf = allOf.map((v, i) => convert(v, `${path}.allOf[${i}]`));
  else if (type === undefined) throw new Unsupported(`${path}: needs a type (or anyOf, oneOf or allOf)`);
  else out.type = type;

  for (const key of ['description', 'title']) {
    const value = take(rest, key);
    if (value !== undefined) out[key] = value;
  }

  if (type === 'object') {
    const properties = take(rest, 'properties');
    out.properties = Object.fromEntries(Object.entries(isObject(properties) ? properties : {}).map(([name, schema]) => [name, convert(schema, `${path}.properties.${name}`)]));
    take(rest, 'additionalProperties');
    out.additionalProperties = false;
    const required = take(rest, 'required');
    if (required !== undefined) out.required = required;
  } else if (type === 'string') {
    const format = rest.format;
    if (typeof format === 'string' && STRING_FORMATS.includes(format)) out.format = take(rest, 'format') as string;
  } else if (type === 'array') {
    const items = take(rest, 'items');
    if (items !== undefined) out.items = convert(items, `${path}.items`);
    const minItems = rest.minItems;
    if (minItems === 0 || minItems === 1) out.minItems = take(rest, 'minItems') as number;
  }

  const leftover = Object.entries(rest);
  if (leftover.length > 0) {
    const note = `{${leftover.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')}}`;
    out.description = typeof out.description === 'string' && out.description !== '' ? `${out.description}\n\n${note}` : note;
  }
  return out as JsonObject;
}

/** The schema in the form the provider accepts, or a `CONFIG` error if it cannot be expressed. Pure; never throws. */
export function toProviderSchema(schema: JsonObject): Result<JsonObject, LlmError> {
  try {
    if (schema.type !== 'object') throw new Unsupported('schema: the top level must be an object schema');
    return ok(convert(schema, 'schema'));
  } catch (error) {
    return err(llmError('CONFIG', `outputSchema: ${error instanceof Unsupported ? error.message : 'could not be read'}`));
  }
}
