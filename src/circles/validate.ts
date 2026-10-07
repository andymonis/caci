import { parseUsername } from '../users/index.js';
import { circlesError, type CirclesError } from './errors.js';
import { err, ok, type Result } from './result.js';
import { CIRCLE_DESCRIPTION_MAX, CIRCLE_NAME_MAX, isCircleRole, type CircleRole } from './types.js';

const invalid = (field: string, message: string): Result<never, CirclesError> => err(circlesError('INVALID_INPUT', message, { field }));

const length = (text: string): number => [...text].length;

/** C0 and C1 controls, the line and paragraph separators and the byte order mark; `allowed` are let through. */
function hasControl(text: string, allowed: readonly number[] = []): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (allowed.includes(c)) continue;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff) return true;
  }
  return false;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);

/** `input` must be a plain object with only the `allowed` keys: anything else is refused by name. */
function strict(input: unknown, allowed: readonly string[]): Result<Record<string, unknown>, CirclesError> {
  if (!isPlainObject(input)) return invalid('body', 'a JSON object is required');
  for (const key of Object.keys(input)) if (!allowed.includes(key)) return invalid(key, `unknown field "${key.length > 40 ? `${key.slice(0, 40)}...` : key}"`);
  return ok(input);
}

/** 1 to 80 characters once trimmed, with no control characters. */
export function parseCircleName(raw: unknown): Result<string, CirclesError> {
  if (typeof raw !== 'string') return invalid('name', 'name must be text');
  const name = raw.trim();
  if (name === '' || length(name) > CIRCLE_NAME_MAX) return invalid('name', `name must be 1 to ${CIRCLE_NAME_MAX} characters`);
  if (hasControl(name)) return invalid('name', 'name must not contain control characters');
  return ok(name);
}

/** Optional: `undefined` is fine. Otherwise trimmed, at most 500 characters; new lines and tabs are allowed, other control characters are not. An empty one is "none". */
export function parseCircleDescription(raw: unknown): Result<string | undefined, CirclesError> {
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== 'string') return invalid('description', 'description must be text');
  const text = raw.trim();
  if (length(text) > CIRCLE_DESCRIPTION_MAX) return invalid('description', `description must be at most ${CIRCLE_DESCRIPTION_MAX} characters`);
  if (hasControl(text, [0x0a, 0x09])) return invalid('description', 'description must not contain control characters');
  return ok(text === '' ? undefined : text);
}

export function parseRole(raw: unknown, field = 'role'): Result<CircleRole, CirclesError> {
  if (!isCircleRole(raw)) return invalid(field, 'role must be one of: owner, manager, member, observer');
  return ok(raw);
}

export interface CreateCircleInput {
  readonly name: string;
  readonly description?: string;
}
/** `{ name, description? }`, nothing else. */
export function parseCreateCircle(input: unknown): Result<CreateCircleInput, CirclesError> {
  const body = strict(input, ['name', 'description']);
  if (!body.ok) return body;
  const name = parseCircleName(body.value.name);
  if (!name.ok) return name;
  const description = parseCircleDescription(body.value.description);
  if (!description.ok) return description;
  return ok(Object.freeze({ name: name.value, ...(description.value === undefined ? {} : { description: description.value }) }));
}

export interface UpdateCircleInput {
  readonly name?: string;
  /** `null` removes the description. */
  readonly description?: string | null;
}
/** `{ name?, description? }` with at least one; `description: null` (or empty) removes it. */
export function parseUpdateCircle(input: unknown): Result<UpdateCircleInput, CirclesError> {
  const body = strict(input, ['name', 'description']);
  if (!body.ok) return body;
  if (body.value.name === undefined && body.value.description === undefined) return invalid('body', 'nothing to change: give a name or a description');
  let name: string | undefined;
  if (body.value.name !== undefined) {
    const parsed = parseCircleName(body.value.name);
    if (!parsed.ok) return parsed;
    name = parsed.value;
  }
  let description: string | null | undefined;
  if (body.value.description === null) description = null;
  else if (body.value.description !== undefined) {
    const parsed = parseCircleDescription(body.value.description);
    if (!parsed.ok) return parsed;
    description = parsed.value ?? null;
  }
  return ok(Object.freeze({ ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }) }));
}

export interface InviteInput {
  /** Lower-case. */
  readonly username: string;
  readonly role: CircleRole;
}
/** `{ username, role }`, nothing else. The username is only checked for shape: whether the account exists is never revealed. */
export function parseInvite(input: unknown): Result<InviteInput, CirclesError> {
  const body = strict(input, ['username', 'role']);
  if (!body.ok) return body;
  const username = parseUsername(body.value.username);
  if (!username.ok) return invalid('username', username.error.message);
  const role = parseRole(body.value.role);
  if (!role.ok) return role;
  return ok(Object.freeze({ username: username.value, role: role.value }));
}

/** `{ role }`, nothing else. */
export function parseRoleChange(input: unknown): Result<CircleRole, CirclesError> {
  const body = strict(input, ['role']);
  if (!body.ok) return body;
  return parseRole(body.value.role);
}
