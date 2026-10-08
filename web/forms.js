// Early feedback on the forms (R-005 WA-FR-03). These mirror the rules a person can see and nothing
// more: the SERVER is the authority and answers for everything else (a common password, a password
// that is the username, an email it dislikes). A check passing here proves nothing.
//
// Pure functions, no page access. A password is never trimmed, never kept, never logged.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const DISPLAY_NAME_MAX = 80;
export const EMAIL_MAX = 254;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

const USERNAME_PATTERN = /^[a-z0-9._-]+$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.][^\s@]*\.[^\s@.]+$/;

const length = (text) => [...text].length;

function hasControl(text) {
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff) return true;
  }
  return false;
}

function checkUsername(raw) {
  if (typeof raw !== 'string') return { error: 'Enter a username.' };
  const username = raw.trim().toLowerCase();
  if (username === '') return { error: 'Enter a username.' };
  if (length(username) < USERNAME_MIN || length(username) > USERNAME_MAX) return { error: `A username is ${USERNAME_MIN} to ${USERNAME_MAX} characters.` };
  if (!USERNAME_PATTERN.test(username)) return { error: 'A username can use letters, digits, ".", "_" and "-" only.' };
  return { value: username };
}

function checkDisplayName(raw) {
  if (typeof raw !== 'string') return { error: 'Enter the name to show.' };
  const name = raw.trim();
  if (name === '') return { error: 'Enter the name to show.' };
  if (length(name) > DISPLAY_NAME_MAX) return { error: `A display name is at most ${DISPLAY_NAME_MAX} characters.` };
  if (hasControl(name)) return { error: 'A display name cannot contain control characters.' };
  return { value: name };
}

function checkEmail(raw) {
  if (raw === undefined || raw === null) return { value: undefined };
  if (typeof raw !== 'string') return { error: 'That does not look like an email address.' };
  const email = raw.trim();
  if (email === '') return { value: undefined };
  if (length(email) > EMAIL_MAX || hasControl(email) || !EMAIL_SHAPE.test(email)) return { error: 'That does not look like an email address.' };
  return { value: email };
}

function checkNewPassword(raw) {
  if (typeof raw !== 'string' || raw === '') return { error: `Choose a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.` };
  const n = length(raw.normalize('NFKC')); // the service counts after normalising
  if (n < PASSWORD_MIN) return { error: `A password needs at least ${PASSWORD_MIN} characters.` };
  if (n > PASSWORD_MAX) return { error: `A password can have at most ${PASSWORD_MAX} characters.` };
  return { value: raw };
}

function collect(entries) {
  const errors = {};
  const value = {};
  for (const [field, result] of entries) {
    if (result.error !== undefined) errors[field] = result.error;
    else if (result.value !== undefined) value[field] = result.value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors: Object.freeze(errors) } : { ok: true, value: Object.freeze(value) };
}

/** `{ username, displayName, email?, password }`: the cleaned values, or an error message per field. */
export function checkRegister(input) {
  const i = input && typeof input === 'object' ? input : {};
  return collect([
    ['username', checkUsername(i.username)],
    ['displayName', checkDisplayName(i.displayName)],
    ['email', checkEmail(i.email)],
    ['password', checkNewPassword(i.password)],
  ]);
}

/** Signing in has no password policy: it only needs something to send. */
export function checkLogin(input) {
  const i = input && typeof input === 'object' ? input : {};
  const username = typeof i.username === 'string' ? i.username.trim().toLowerCase() : '';
  return collect([
    ['username', username === '' ? { error: 'Enter your username.' } : { value: username }],
    ['password', typeof i.password === 'string' && i.password !== '' ? { value: i.password } : { error: 'Enter your password.' }],
  ]);
}
