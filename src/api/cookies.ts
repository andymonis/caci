/** Longest cookie header and value we look at: anything bigger is ignored, so a request cannot make us parse megabytes. */
const MAX_HEADER = 8192;
const MAX_VALUE = 4096;
const MAX_COOKIES = 50;
/** A cookie name: an HTTP token (letters, digits and a few symbols, no separators). */
const NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** What may appear in a cookie value we write: visible ASCII except space, double quote, comma, semicolon and backslash. */
const SAFE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

/**
 * Reads a `Cookie` request header into a plain map. Malformed pairs are skipped, the first of a repeated
 * name wins (a later one cannot shadow it), and the map has no prototype, so a cookie called
 * `__proto__` or `constructor` is just a name.
 */
export function parseCookies(header: string | undefined): Readonly<Record<string, string>> {
  const cookies: Record<string, string> = Object.create(null) as Record<string, string>;
  if (typeof header !== 'string' || header.length === 0 || header.length > MAX_HEADER) return Object.freeze(cookies);
  let count = 0;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    let value = part.slice(at + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!NAME.test(name) || value.length > MAX_VALUE || !SAFE_VALUE.test(value)) continue;
    if (name in cookies) continue;
    if (++count > MAX_COOKIES) break;
    cookies[name] = value;
  }
  return Object.freeze(cookies);
}

export interface CookieOptions {
  /** Add `Secure`: the browser sends the cookie only over HTTPS. */
  readonly secure: boolean;
  /** How long the browser keeps it. Omit for a cookie that ends with the browser session. */
  readonly maxAgeSeconds?: number;
}

/** A `Set-Cookie` value: always `HttpOnly`, `SameSite=Strict` and `Path=/`. Throws `TypeError` for a name or value that is not safe to write. */
export function serialiseCookie(name: string, value: string, options: CookieOptions): string {
  if (!NAME.test(name)) throw new TypeError('not a valid cookie name');
  if (typeof value !== 'string' || value.length > MAX_VALUE || !SAFE_VALUE.test(value)) throw new TypeError('not a valid cookie value');
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (options.maxAgeSeconds !== undefined) {
    if (!Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 0) throw new TypeError('maxAgeSeconds must be a whole number of seconds');
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** A `Set-Cookie` that tells the browser to forget the cookie now. */
export function clearCookie(name: string, options: { readonly secure: boolean }): string {
  return `${serialiseCookie(name, '', { secure: options.secure, maxAgeSeconds: 0 })}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
