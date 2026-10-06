import type { JsonValue } from '../graph_store/index.js';
import type { UsersError } from '../users/index.js';

/** What a handler reads when a request carried no body. */
export const NO_BODY: Readonly<Record<string, JsonValue>> = Object.freeze({});

/** A body with a key we do not know is refused by name, so a typo (or an attempt to send `role` to register) is never silently ignored. */
export function unknownKey(body: Readonly<Record<string, JsonValue>>, allowed: readonly string[]): UsersError | undefined {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) return { code: 'INVALID_INPUT', message: `${key} is not accepted here`, field: key };
  }
  return undefined;
}
