import { newUserId } from '../users/index.js';

/** A ledger entry id is `l` and 16 random lowercase letters or digits. */
export const LEDGER_ID_PATTERN = /^l[a-z0-9]{16}$/;

type Random = (length: number) => Uint8Array;

// The user id generator is unbiased and uses the platform's secure source; only the prefix differs.
export const newLedgerId = (random?: Random): string => `l${newUserId(random).slice(1)}`;
export const isLedgerId = (value: unknown): value is string => typeof value === 'string' && LEDGER_ID_PATTERN.test(value);
