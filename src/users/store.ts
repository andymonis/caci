import type { Result } from '../graph_store/index.js';
import type { UsersError } from './errors.js';
import type { Role, User } from './types.js';

/** What `create` is given. The username is lower-cased by the store itself, so uniqueness never depends on the caller. */
export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email?: string;
  readonly role: Role;
  /** The stored password hash (`scrypt$...`). Only the credential accessors give it back. */
  readonly passwordHash: string;
  /** Milliseconds since 1970; also the first `updatedAt`. */
  readonly createdAt: number;
}

/** A user and the hash to check a password against: the only way a hash ever leaves a store. */
export interface Credential {
  readonly user: User;
  readonly passwordHash: string;
}

/** What may change. The id, the username and `createdAt` never do. `email: null` removes the email. */
export interface UserPatch {
  readonly displayName?: string;
  readonly email?: string | null;
  readonly role?: Role;
  readonly passwordHash?: string;
  /** Milliseconds since 1970. */
  readonly updatedAt: number;
}

export interface CreateOptions {
  /** If this is the very first user, make them an admin, atomically with creating them. */
  readonly adminIfFirst?: boolean;
}

export interface GuardOptions {
  /** Refuse (`LAST_ADMIN`) an update or delete that would leave no admin, atomically with doing it. */
  readonly protectLastAdmin?: boolean;
}

export interface UserPage {
  readonly limit: number;
  /** `null` for the first page; otherwise a `nextCursor` this store gave. */
  readonly cursor: string | null;
}

export interface UserList {
  readonly items: readonly User[];
  /** `null` when there is nothing more. */
  readonly nextCursor: string | null;
}

/**
 * Where accounts live. Like a graph store adapter it is deliberately dumb: it keeps records and
 * enforces what only a store can enforce atomically (a unique username, the first admin, the last
 * admin). Validation, hashing, sessions and authorisation belong to the controller.
 *
 * Every method returns copies, never what it holds. `get`, `getByUsername` and `list` never
 * include a hash.
 */
export interface UserStore {
  /** `CONFLICT` if the username (case-insensitively) or the id is taken. Of simultaneous creates of one username, exactly one succeeds. */
  create(record: UserRecord, options?: CreateOptions): Promise<Result<User, UsersError>>;
  get(id: string): Promise<User | undefined>;
  /** The username is lower-cased first. */
  getByUsername(username: string): Promise<User | undefined>;
  credentialOf(id: string): Promise<Credential | undefined>;
  credentialByUsername(username: string): Promise<Credential | undefined>;
  /** `NOT_FOUND` for a missing user; `LAST_ADMIN` when guarded and it would leave no admin. */
  update(id: string, patch: UserPatch, options?: GuardOptions): Promise<Result<User, UsersError>>;
  /** Idempotent: `false` (not an error) if there was no such user. `LAST_ADMIN` when guarded and it would leave no admin. */
  delete(id: string, options?: GuardOptions): Promise<Result<boolean, UsersError>>;
  /** By username in plain code-unit order, with keyset paging: stable under inserts and deletes. A limit that is not a positive whole number, or a cursor not given by this store, throws a `RangeError`. */
  list(page: UserPage): Promise<UserList>;
  count(): Promise<number>;
}
