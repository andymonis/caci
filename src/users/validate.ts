import { err, ok, type Result } from '../graph_store/index.js';
import { usersError, type UsersError } from './errors.js';

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const DISPLAY_NAME_MAX = 80;
export const EMAIL_MAX = 254;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

const USERNAME_PATTERN = /^[a-z0-9._-]+$/;
// C0 and C1 controls, the line and paragraph separators, and the byte order mark
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.][^\s@]*\.[^\s@.]+$/;

/**
 * Passwords at least 12 characters long that everyone tries first. Matched ignoring case, after
 * Unicode normalisation. Deliberately small: length does most of the work, this only stops the
 * obvious ones.
 */
export const COMMON_PASSWORDS: readonly string[] = Object.freeze([
  'password1234',
  'password12345',
  'passwordpassword',
  'password123456',
  'qwertyuiop12',
  'qwertyuiopas',
  'qwertyuiopasdf',
  'qwertyuiop123',
  '123456789012',
  '1234567890123',
  '12345678901234',
  'abcdefghijkl',
  'abcd12345678',
  'iloveyou1234',
  'iloveyou12345',
  'letmein12345',
  'welcome12345',
  'administrator',
  'administrator1',
  'changeme1234',
  'changemechangeme',
  'trustno1trustno1',
  'monkey123456',
  'dragon123456',
  'football1234',
  'baseball1234',
  'superman1234',
  'sunshine1234',
  'princess1234',
  'whatever1234',
  '1q2w3e4r5t6y',
  '1qaz2wsx3edc',
  'asdfghjkl123',
  'zxcvbnm12345',
  'correcthorsebatterystaple',
]);

const invalid = (field: string, message: string): Result<never, UsersError> => err(usersError('INVALID_INPUT', message, { field }));
const length = (text: string): number => [...text].length;

/** Lower-cases the username and checks it: 3 to 32 characters of `a-z`, `0-9`, `.`, `_`, `-`. */
export function parseUsername(raw: unknown): Result<string, UsersError> {
  if (typeof raw !== 'string') return invalid('username', 'username must be text');
  const username = raw.toLowerCase();
  if (length(username) < USERNAME_MIN || length(username) > USERNAME_MAX) return invalid('username', `username must be ${USERNAME_MIN} to ${USERNAME_MAX} characters`);
  if (!USERNAME_PATTERN.test(username)) return invalid('username', 'username may only contain letters, digits, ".", "_" and "-"');
  return ok(username);
}

/** 1 to 80 characters once trimmed, with no control characters. */
export function parseDisplayName(raw: unknown): Result<string, UsersError> {
  if (typeof raw !== 'string') return invalid('displayName', 'display name must be text');
  const name = raw.trim();
  if (name === '' || length(name) > DISPLAY_NAME_MAX) return invalid('displayName', `display name must be 1 to ${DISPLAY_NAME_MAX} characters`);
  if (CONTROL.test(name)) return invalid('displayName', 'display name must not contain control characters');
  return ok(name);
}

/**
 * Optional: `undefined` is fine. Otherwise at most 254 characters of the shape `a@b.c` with no spaces
 * or control characters. This is a typing check, not proof the address exists: it is never verified or mailed.
 */
export function parseEmail(raw: unknown): Result<string | undefined, UsersError> {
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== 'string') return invalid('email', 'email must be text');
  const email = raw.trim();
  if (length(email) > EMAIL_MAX) return invalid('email', `email must be at most ${EMAIL_MAX} characters`);
  if (CONTROL.test(email) || !EMAIL_SHAPE.test(email)) return invalid('email', 'email must look like name@example.com');
  return ok(email);
}

/**
 * Checks a password against the policy and returns it Unicode-normalised (NFKC, the form that is
 * hashed): 12 to 128 characters, no control characters, not just one repeated character, not the
 * username, not a very common password. No message ever repeats the password.
 */
export function parsePassword(raw: unknown, context: { readonly username?: string } = {}): Result<string, UsersError> {
  if (typeof raw !== 'string') return invalid('password', 'password must be text');
  const password = raw.normalize('NFKC');
  if (length(password) < PASSWORD_MIN || length(password) > PASSWORD_MAX) return invalid('password', `password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`);
  if (CONTROL.test(password)) return invalid('password', 'password must not contain control characters');
  const lower = password.toLowerCase();
  if (new Set(lower).size === 1) return invalid('password', 'password must not be one character repeated');
  if (context.username !== undefined && lower === context.username.normalize('NFKC').toLowerCase()) return invalid('password', 'password must not be the same as the username');
  if (COMMON_PASSWORDS.includes(lower)) return invalid('password', 'password is too common: choose something less guessable');
  return ok(password);
}
