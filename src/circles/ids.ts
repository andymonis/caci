import { isWellFormedToken, newSessionToken, newUserId } from '../users/index.js';

/** A circle id is `c` and 16 random lowercase letters or digits; an invitation id is `i` and 16. Never chosen by a client. */
export const CIRCLE_ID_PATTERN = /^c[a-z0-9]{16}$/;
export const INVITATION_ID_PATTERN = /^i[a-z0-9]{16}$/;

type Random = (length: number) => Uint8Array;

// The user id generator is unbiased and uses the platform's secure source; only the prefix differs.
export const newCircleId = (random?: Random): string => `c${newUserId(random).slice(1)}`;
export const newInvitationId = (random?: Random): string => `i${newUserId(random).slice(1)}`;

export const isCircleId = (value: unknown): value is string => typeof value === 'string' && CIRCLE_ID_PATTERN.test(value);
export const isInvitationId = (value: unknown): value is string => typeof value === 'string' && INVITATION_ID_PATTERN.test(value);

/** A join link's id is `j` and 16 random characters; a join request's is `r` and 16 (R-023). Never chosen by a client. */
export const JOIN_LINK_ID_PATTERN = /^j[a-z0-9]{16}$/;
export const JOIN_REQUEST_ID_PATTERN = /^r[a-z0-9]{16}$/;
export const newJoinLinkId = (random?: Random): string => `j${newUserId(random).slice(1)}`;
export const newJoinRequestId = (random?: Random): string => `r${newUserId(random).slice(1)}`;
export const isJoinLinkId = (value: unknown): value is string => typeof value === 'string' && JOIN_LINK_ID_PATTERN.test(value);
export const isJoinRequestId = (value: unknown): value is string => typeof value === 'string' && JOIN_REQUEST_ID_PATTERN.test(value);

/** A join link's token is `cjoin_` and 43 base64url characters (256 random bits), shown once; only its hash is ever stored. */
export const JOIN_TOKEN_PREFIX = 'cjoin_';
export const newJoinToken = (random?: Random): string => `${JOIN_TOKEN_PREFIX}${newSessionToken(random)}`;
/** True only for text shaped exactly like a token this service makes. Anything else is a miss before a store is touched. */
export const isWellFormedJoinToken = (value: unknown): value is string => typeof value === 'string' && value.startsWith(JOIN_TOKEN_PREFIX) && isWellFormedToken(value.slice(JOIN_TOKEN_PREFIX.length));
