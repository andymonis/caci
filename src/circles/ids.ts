import { newUserId } from '../users/index.js';

/** A circle id is `c` and 16 random lowercase letters or digits; an invitation id is `i` and 16. Never chosen by a client. */
export const CIRCLE_ID_PATTERN = /^c[a-z0-9]{16}$/;
export const INVITATION_ID_PATTERN = /^i[a-z0-9]{16}$/;

type Random = (length: number) => Uint8Array;

// The user id generator is unbiased and uses the platform's secure source; only the prefix differs.
export const newCircleId = (random?: Random): string => `c${newUserId(random).slice(1)}`;
export const newInvitationId = (random?: Random): string => `i${newUserId(random).slice(1)}`;

export const isCircleId = (value: unknown): value is string => typeof value === 'string' && CIRCLE_ID_PATTERN.test(value);
export const isInvitationId = (value: unknown): value is string => typeof value === 'string' && INVITATION_ID_PATTERN.test(value);
