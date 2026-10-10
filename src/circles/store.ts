import type { CirclesError } from './errors.js';
import type { Result } from './result.js';
import type { Circle, CircleRole } from './types.js';

/** What `createCircle` is given. The creator's membership as `owner` is made in the same step. */
export interface CircleRecord {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Milliseconds since 1970; also the first `updatedAt` and the owner's `joinedAt`. */
  readonly createdAt: number;
}

/** One person in one circle. The role belongs to the membership, never to the account. */
export interface Membership {
  readonly circleId: string;
  readonly userId: string;
  readonly role: CircleRole;
  readonly joinedAt: number;
}

/** What `createInvitation` is given. The store lower-cases the username itself, so uniqueness never depends on the caller. */
export interface InvitationRecord {
  readonly id: string;
  readonly circleId: string;
  readonly username: string;
  readonly role: CircleRole;
  readonly invitedBy: string;
  readonly createdAt: number;
  /** Open while `now < expiresAt`. */
  readonly expiresAt: number;
}
export type Invitation = InvitationRecord;

/** A circle with the caller's place in it. */
export interface CircleSummary {
  readonly circle: Circle;
  readonly role: CircleRole;
  readonly joinedAt: number;
  readonly memberCount: number;
}

/** What may change. The id and `createdAt` never do. `description: null` removes the description. */
export interface CirclePatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly updatedAt: number;
}

export interface CirclePage {
  readonly limit: number;
  /** `null` for the first page; otherwise a `nextCursor` this store gave. */
  readonly cursor: string | null;
}

export interface Listing<T> {
  readonly items: readonly T[];
  /** `null` when there is nothing more. */
  readonly nextCursor: string | null;
}

export interface CreateCircleLimits {
  readonly maxCirclesPerUser: number;
}
export interface AcceptLimits {
  readonly maxCirclesPerUser: number;
  readonly maxMembersPerCircle: number;
}
export interface InviteLimits {
  readonly maxOpenInvitationsPerCircle: number;
}

export interface GrantLimits {
  /** The most categories one grant may name. */
  readonly maxCategoriesPerGrant: number;
}

/**
 * What one owner has shared with one other member of one circle (R-008): categories of the owner's own graph,
 * by id, in plain code-unit order, never empty (an empty set is no grant at all).
 */
export interface Grant {
  readonly circleId: string;
  readonly ownerId: string;
  readonly granteeId: string;
  readonly categories: readonly string[];
  /** When the set was last replaced. */
  readonly updatedAt: number;
}

/** What `removeUser` did. */

export interface RemoveUserOutcome {
  /** How many circles the person was in. */
  readonly left: number;
  /** Circles they solely owned that went to someone else. */
  readonly handedOver: readonly string[];
  /** Circles they solely owned and were alone in, which no longer exist. */
  readonly dissolved: readonly string[];
  /** Invitations removed: those addressed to their username and those they sent. */
  readonly invitationsRemoved: number;
}

/**
 * Where circles live (R-004). Like the other stores it is deliberately dumb: it keeps records and
 * enforces what only a store can enforce atomically (a circle always has an owner, the caps,
 * accepting an invitation together with adding the member, the hand-over when a person goes).
 * Authorisation, validation and who the caller is belong to the controller.
 *
 * Every method returns copies, never what it holds. A limit that is not a positive whole number,
 * or a cursor this store did not give, throws a `RangeError`.
 */
export interface CircleStore {
  /** `CONFLICT` if the id exists; `LIMIT_REACHED` if the owner is already in `maxCirclesPerUser` circles. Adds the owner's membership atomically. */
  createCircle(record: CircleRecord, ownerId: string, limits: CreateCircleLimits): Promise<Result<Circle, CirclesError>>;
  getCircle(id: string): Promise<Circle | undefined>;
  /** `NOT_FOUND` for a missing circle. */
  updateCircle(id: string, patch: CirclePatch): Promise<Result<Circle, CirclesError>>;
  /** Removes the circle, its memberships and its invitations. Idempotent: `false` if there was no such circle. */
  deleteCircle(id: string): Promise<boolean>;

  membershipOf(circleId: string, userId: string): Promise<Membership | undefined>;
  /** The circles a person is in, by circle id, with keyset paging. */
  listCirclesOf(userId: string, page: CirclePage): Promise<Listing<CircleSummary>>;
  /** The members of a circle by user id; empty for a missing circle. */
  listMembers(circleId: string, page: CirclePage): Promise<Listing<Membership>>;

  /** `NOT_FOUND` for a missing membership; `LAST_OWNER` if it would leave the circle without an owner. */
  changeRole(circleId: string, userId: string, role: CircleRole): Promise<Result<Membership, CirclesError>>;
  /** Idempotent: `false` if they were not a member. `LAST_OWNER` if they are the only owner. */
  removeMember(circleId: string, userId: string): Promise<Result<boolean, CirclesError>>;

  /**
   * Opens an invitation. `NOT_FOUND` for a missing circle; `LIMIT_REACHED` when the circle already has
   * `maxOpenInvitationsPerCircle` open ones. A repeat for the same circle and username (any case)
   * keeps the first one's id and `createdAt` and takes the new role, inviter and expiry, and does not
   * count against the cap again. Expired invitations never count.
   */
  createInvitation(record: InvitationRecord, limits: InviteLimits, now: number): Promise<Result<Invitation, CirclesError>>;
  getInvitation(id: string): Promise<Invitation | undefined>;
  /** Open invitations of a circle, by invitation id. */
  listInvitationsOfCircle(circleId: string, now: number, page: CirclePage): Promise<Listing<Invitation>>;
  /** Open invitations addressed to a username (any case), by invitation id. */
  listInvitationsFor(username: string, now: number, page: CirclePage): Promise<Listing<Invitation>>;
  /** Withdraws an open invitation of this circle. `false` if there is none (wrong circle, gone or expired). */
  revokeInvitation(invitationId: string, circleId: string, now: number): Promise<boolean>;
  /** Refuses an open invitation addressed to this username. `false` if there is none. */
  declineInvitation(invitationId: string, username: string, now: number): Promise<boolean>;
  /**
   * Accepts an open invitation addressed to `username`, atomically with adding the membership (`joinedAt` is
   * `now`). `NOT_FOUND` for anything else (missing, someone else's, expired, circle gone: all the same).
   * `LIMIT_REACHED` if the circle is full or the person is in `maxCirclesPerUser` circles, leaving the
   * invitation open. Someone already in the circle keeps their role and the invitation is closed.
   */
  acceptInvitation(invitationId: string, userId: string, username: string, now: number, limits: AcceptLimits): Promise<Result<Membership, CirclesError>>;

  /**
   * A person is gone: remove them from every circle, passing a circle they solely owned to its
   * longest-standing manager, else member, else observer (the earliest `joinedAt`, then the lowest
   * user id), or removing the circle if nobody is left; and remove the invitations addressed to their
   * username or sent by them. Idempotent.
   */
  removeUser(userId: string, username: string): Promise<RemoveUserOutcome>;
  /** Removes every invitation that has expired; returns how many. */
  purgeExpired(now: number): Promise<number>;

  /**
   * Replaces the whole set of categories `ownerId` shares with `granteeId` in a circle (R-008). Both must be current
   * members (`NOT_FOUND` otherwise, whichever is missing, and for a missing circle), and they must be different people
   * (`INVALID_INPUT`, field `granteeId`). Each category is an id of 1 to 256 characters (`INVALID_INPUT`, field
   * `categories`); duplicates are collapsed; more than `maxCategoriesPerGrant` is `LIMIT_REACHED`. An empty set removes
   * the grant and answers `ok(undefined)`. The store does not look at the owner's graph: that is the caller's job.
   */
  setGrant(circleId: string, ownerId: string, granteeId: string, categories: readonly string[], now: number, limits: GrantLimits): Promise<Result<Grant | undefined, CirclesError>>;
  getGrant(circleId: string, ownerId: string, granteeId: string): Promise<Grant | undefined>;
  /** What `ownerId` shares in a circle, one grant per grantee, by grantee id. */
  listGrantsBy(circleId: string, ownerId: string, page: CirclePage): Promise<Listing<Grant>>;
  /** What is shared with `granteeId` in a circle, one grant per owner, by owner id. */
  listGrantsTo(circleId: string, granteeId: string, page: CirclePage): Promise<Listing<Grant>>;
  /** Removes one grant. `false` if there was none. */
  withdrawGrant(circleId: string, ownerId: string, granteeId: string): Promise<boolean>;
  // A grant also ends, in the same step, when either person leaves or is removed (`removeMember`, `removeUser`) or when
  // the circle is deleted: a grant never outlives a membership.
}
