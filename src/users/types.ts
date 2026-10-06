export const ROLES = ['user', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/**
 * A person's account as the rest of the system sees it. It never holds a password, a hash or a
 * session token: those live only in the stores and are returned only by their own accessors.
 */
export interface User {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email?: string;
  readonly role: Role;
  /** Milliseconds since 1970. */
  readonly createdAt: number;
  readonly updatedAt: number;
}
