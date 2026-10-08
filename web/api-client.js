// The web app's one way of talking to the service (R-005). Plain browser JavaScript, no dependency.
//
// - Same address only (the paths are absolute paths, never a full URL), JSON in and out, the session
//   cookie travels by itself (`credentials: 'same-origin'`) and is never read, set or stored here.
// - It never throws: every outcome is `{ ok: true, value }` or `{ ok: false, error: { kind, message, ... } }`.
// - Messages for people are written here from the status, or are the service's own short words with
//   control characters removed; they are shown as text only.
// - Only the fields the app needs are passed on (no email, no graph id).

const MAX_MESSAGE = 300;
const FIELDS = ['username', 'displayName', 'email', 'password'];

/** Removes control characters, separators and the byte order mark, and cuts to a reasonable length. */
export function cleanMessage(text, fallback) {
  if (typeof text !== 'string') return fallback;
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff) out += ' ';
    else out += ch;
  }
  out = out.replace(/ {2,}/g, ' ').trim();
  if (out === '') return fallback;
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE - 1)}…` : out;
}

/** Seconds to wait from a `Retry-After` header: a whole number of 1 to 86,400, or `undefined`. */
export function parseRetryAfter(value) {
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  if (seconds < 1) return 1;
  return Math.min(seconds, 86_400);
}

export const fail = (error) => ({ ok: false, error: Object.freeze(error) });
export const ok = (value) => ({ ok: true, value });

export const NETWORK = 'Cannot reach the service. Check your connection and try again.';
export const SERVER = 'Something went wrong on the service. Try again in a moment.';

/** The user as the app uses them, or `undefined` if the answer is not shaped like one. */
function userFrom(json) {
  const u = json && typeof json === 'object' ? json.user : undefined;
  if (!u || typeof u !== 'object') return undefined;
  if (typeof u.id !== 'string' || typeof u.username !== 'string' || typeof u.displayName !== 'string' || u.id === '' || u.username === '') return undefined;
  return Object.freeze({ id: u.id, username: u.username, displayName: u.displayName });
}

function errorFor(operation, status, json, retryAfter) {
  const serverMessage = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error.message : undefined;
  const serverField = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error.field : undefined;
  if (status === 401) {
    if (operation === 'me') return { kind: 'signed-out', message: 'You are not signed in.' };
    if (operation === 'login') return { kind: 'credentials', message: cleanMessage(serverMessage, 'Wrong username or password.') };
    return { kind: 'signed-out', message: 'You are not signed in.' };
  }
  if (status === 422) {
    const field = FIELDS.includes(serverField) ? serverField : undefined;
    return { kind: 'invalid', message: cleanMessage(serverMessage, 'Please check what you typed.'), ...(field === undefined ? {} : { field }) };
  }
  if (status === 409 && operation === 'register') return { kind: 'taken', message: cleanMessage(serverMessage, 'That username is taken.'), field: 'username' };
  if (status === 403 && operation === 'register') return { kind: 'closed', message: 'Registration is closed on this service.' };
  if (status === 403) return { kind: 'forbidden', message: 'The service refused that request.' };
  if (status === 429) {
    const seconds = parseRetryAfter(retryAfter);
    return { kind: 'throttled', message: seconds === undefined ? 'Too many tries. Wait a little and try again.' : `Too many tries. Wait ${seconds} ${seconds === 1 ? 'second' : 'seconds'} and try again.`, ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }) };
  }
  return { kind: 'server', message: SERVER };
}

/**
 * One way of sending a request and reading the answer, shared by every client of the service: the same
 * address, JSON, the cookie left to the browser, never throwing. `errorOf(status, json, retryAfter)` says
 * what a refusal means for the call being made; `parse(json)` turns a good answer into the value the app
 * uses (or `undefined` if it is not shaped right, which is a server problem).
 */
export function createRequester(fetchFn) {
  if (typeof fetchFn !== 'function') throw new TypeError('createRequester needs a fetch function');
  return async function request(method, path, body, parse, errorOf) {
    let response;
    try {
      response = await fetchFn(path, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch {
      return fail({ kind: 'network', message: NETWORK });
    }
    if (!response || typeof response.status !== 'number') return fail({ kind: 'server', message: SERVER });
    let text;
    try {
      text = await response.text();
    } catch {
      return fail({ kind: 'network', message: NETWORK });
    }
    let json;
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (response.status >= 200 && response.status < 300) {
      const value = parse(json);
      return value === undefined ? fail({ kind: 'server', message: SERVER }) : ok(value);
    }
    let retryAfter;
    try {
      retryAfter = response.headers?.get?.('retry-after') ?? undefined;
    } catch {
      retryAfter = undefined;
    }
    return fail(errorOf(response.status, json, retryAfter));
  };
}

/**
 * `fetchFn` is the browser's `fetch` (or a stand-in in tests). Nothing is read from the page or from
 * storage; the session cookie is the browser's business.
 */
export function createApiClient({ fetchFn }) {
  if (typeof fetchFn !== 'function') throw new TypeError('createApiClient needs a fetch function');
  const send = createRequester(fetchFn);
  const request = (operation, method, path, body, parse) => send(method, path, body, parse, (status, json, retryAfter) => errorFor(operation, status, json, retryAfter));

  return Object.freeze({
    /** Who is signed in, if anyone: `ok` with the user, or the error `signed-out`. */
    me: () => request('me', 'GET', '/api/me', undefined, userFrom),
    /** `{ username, displayName, email?, password }` */
    register: ({ username, displayName, email, password }) =>
      request('register', 'POST', '/api/register', { username, displayName, ...(email === undefined || email === '' ? {} : { email }), password }, userFrom),
    login: ({ username, password }) => request('login', 'POST', '/api/login', { username, password }, userFrom),
    /** Signing out always counts as done if the service says you were not signed in. */
    logout: () => request('logout', 'POST', '/api/logout', undefined, () => true),
  });
}
