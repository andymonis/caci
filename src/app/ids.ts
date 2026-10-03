/** Makes the id for a new note's item. The graph store never generates ids: the application does. */
export type ItemIdGenerator = () => string;

export interface ItemIdOptions {
  /** The clock, in milliseconds. Tests replace it. */
  readonly now?: () => number;
  /** Six lowercase base-36 characters. Tests replace it. */
  readonly random?: () => string;
  /** Put in front of every id. Lowercase letters, digits, `-` and `_`. Default "note". */
  readonly prefix?: string;
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const TIME_DIGITS = 9;
const SEQUENCE_DIGITS = 2;
const MAX_SEQUENCE = 36 ** SEQUENCE_DIGITS - 1;
const RANDOM_DIGITS = 6;
const PREFIX = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function randomSuffix(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(RANDOM_DIGITS));
  return Array.from(bytes, (b) => ALPHABET[b % 36]).join('');
}

const encode = (n: number, digits: number): string => n.toString(36).padStart(digits, '0');

/**
 * A generator of ids like `note-0m5xk2q9a-00-f3k9d2`: lowercase, safe as a file name, and sorting
 * by id is sorting by creation order. Three parts after the prefix: the time in milliseconds, a
 * counter that separates ids made in the same millisecond (and keeps order if the clock steps
 * back), and a random tail so two processes never collide. Throws a `TypeError` for a bad prefix or
 * clock, a coding mistake.
 */
export function createItemIdGenerator(options: ItemIdOptions = {}): ItemIdGenerator {
  const { now = Date.now, random = randomSuffix, prefix = 'note' } = options;
  if (!PREFIX.test(prefix)) throw new TypeError('createItemIdGenerator: prefix must be 1 to 32 lowercase letters, digits, "-" or "_", starting with a letter or digit');
  if (typeof now !== 'function' || typeof random !== 'function') throw new TypeError('createItemIdGenerator: now and random must be functions');
  let lastTime = -1;
  let sequence = 0;
  return () => {
    const time = Math.floor(now());
    if (!Number.isSafeInteger(time) || time < 0 || time >= 36 ** TIME_DIGITS) throw new RangeError('createItemIdGenerator: the clock must give whole milliseconds since 1970');
    if (time > lastTime) {
      lastTime = time;
      sequence = 0;
    } else if (sequence < MAX_SEQUENCE) {
      sequence++;
    } else {
      lastTime++; // a thousand ids in one millisecond: borrow the next one so the order holds
      sequence = 0;
    }
    return `${prefix}-${encode(lastTime, TIME_DIGITS)}-${encode(sequence, SEQUENCE_DIGITS)}-${random()}`;
  };
}
