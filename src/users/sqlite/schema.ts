import type { Db } from '../../sqlite/db.js';
import { prepareSchema, type Migration, type PrepareResult } from '../../sqlite/prepare.js';

/** The schema version this component writes, recorded with `PRAGMA user_version`. */
export const USERS_SCHEMA_VERSION = 6;

/** "CaUs": says "this is a CaCi user database" in the file header, so it is never mistaken for the graph database (or any other). */
export const USERS_APPLICATION_ID = 0x43615573;

/**
 * Version 1. The username is stored already lower-cased and the database checks it, so a plain
 * `UNIQUE` is a case-insensitive uniqueness without a collation. `WITHOUT ROWID` keeps the table in
 * primary key order.
 */
const V1: Migration = Object.freeze({
  to: 1,
  creates: Object.freeze(['users']),
  sql: Object.freeze([
    `CREATE TABLE users (
       id TEXT NOT NULL PRIMARY KEY,
       username TEXT NOT NULL UNIQUE CHECK (username <> '' AND username = lower(username)),
       display_name TEXT NOT NULL,
       email TEXT,
       role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
       password_hash TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     ) WITHOUT ROWID`,
    'CREATE INDEX users_by_role ON users (role)',
  ]),
});

/**
 * Version 2: sessions. Only the SHA-256 of a token is stored. A trigger removes a user's sessions
 * when the user goes, so no store has to remember to; sessions deliberately have no foreign key,
 * so the session store works without a user row (the controller is what knows about users).
 */
const V2: Migration = Object.freeze({
  to: 2,
  creates: Object.freeze(['sessions']),
  sql: Object.freeze([
    `CREATE TABLE sessions (
       token_hash TEXT NOT NULL PRIMARY KEY,
       user_id TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       last_used_at INTEGER NOT NULL
     ) WITHOUT ROWID`,
    'CREATE INDEX sessions_by_user ON sessions (user_id, last_used_at)',
    `CREATE TRIGGER sessions_end_with_user AFTER DELETE ON users
     BEGIN
       DELETE FROM sessions WHERE user_id = old.id;
     END`,
  ]),
});

/**
 * Version 3: circles (R-004). They live in this file, beside the accounts, so that deleting an
 * account can remove its memberships in the same transaction. Memberships and invitations belong to
 * a circle and go with it (`ON DELETE CASCADE`); they deliberately have no foreign key to `users`,
 * so the circle store works without a user row (the controller is what knows about users).
 * Invitation names are stored lower-cased and the database checks it, as for usernames. All ids are
 * plain ASCII, so SQLite's binary text order is the code-unit order the stores promise.
 */
const V3: Migration = Object.freeze({
  to: 3,
  creates: Object.freeze(['circles', 'circle_members', 'circle_invitations']),
  sql: Object.freeze([
    `CREATE TABLE circles (
       id TEXT NOT NULL PRIMARY KEY,
       name TEXT NOT NULL,
       description TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     ) WITHOUT ROWID`,
    `CREATE TABLE circle_members (
       circle_id TEXT NOT NULL REFERENCES circles (id) ON DELETE CASCADE,
       user_id TEXT NOT NULL,
       role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'member', 'observer')),
       joined_at INTEGER NOT NULL,
       PRIMARY KEY (circle_id, user_id)
     ) WITHOUT ROWID`,
    'CREATE INDEX circle_members_by_user ON circle_members (user_id, circle_id)',
    `CREATE TABLE circle_invitations (
       id TEXT NOT NULL PRIMARY KEY,
       circle_id TEXT NOT NULL REFERENCES circles (id) ON DELETE CASCADE,
       username TEXT NOT NULL CHECK (username <> '' AND username = lower(username)),
       role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'member', 'observer')),
       invited_by TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       UNIQUE (circle_id, username)
     ) WITHOUT ROWID`,
    'CREATE INDEX circle_invitations_by_name ON circle_invitations (username, id)',
    'CREATE INDEX circle_invitations_by_inviter ON circle_invitations (invited_by)',
    'CREATE INDEX circle_invitations_by_expiry ON circle_invitations (expires_at)',
  ]),
});

/**
 * Version 4: when an account is deleted, whoever deletes it, its place in every circle goes with it
 * in the same transaction. This is the same thing as the circle store's `removeUser` (the two are
 * tested against each other): a circle the person solely owned passes to its longest-standing
 * manager, else member, else observer (the earliest join, then the lowest user id) or, if nobody
 * else is in it, ceases to exist; their memberships go; and so do the invitations addressed to their
 * username or sent by them. The steps run in this order, and the order matters: the heir is chosen
 * while the person is still a member, and the circle is dissolved while they are still its only one.
 */
const V4: Migration = Object.freeze({
  to: 4,
  creates: Object.freeze([]),
  sql: Object.freeze([
    `CREATE TRIGGER circles_leave_with_user AFTER DELETE ON users
     BEGIN
       UPDATE circle_members SET role = 'owner'
        WHERE (circle_id, user_id) IN (
          SELECT m.circle_id,
                 (SELECT h.user_id FROM circle_members h
                   WHERE h.circle_id = m.circle_id AND h.user_id <> old.id
                   ORDER BY CASE h.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, h.joined_at, h.user_id
                   LIMIT 1)
            FROM circle_members m
           WHERE m.user_id = old.id AND m.role = 'owner'
             AND (SELECT count(*) FROM circle_members o WHERE o.circle_id = m.circle_id AND o.role = 'owner') = 1);
       DELETE FROM circles
        WHERE id IN (SELECT circle_id FROM circle_members WHERE user_id = old.id)
          AND NOT EXISTS (SELECT 1 FROM circle_members o WHERE o.circle_id = circles.id AND o.user_id <> old.id);
       DELETE FROM circle_members WHERE user_id = old.id;
       DELETE FROM circle_invitations WHERE username = old.username OR invited_by = old.id;
     END`,
  ]),
});

/**
 * Version 5 (R-008): what one person shares with one other member of a circle. One row per pair, holding the
 * categories as a JSON array (JSON text keeps any category id exactly, even one with a lone surrogate, which a
 * plain text column would not), so replacing a grant is one statement. The row goes with its circle (the cascade)
 * and, in a trigger, with either person's membership row, so **a grant never outlives a membership**, whoever
 * deletes the membership: leaving, removal, or the account-deletion trigger of version 4. Like memberships,
 * grants have no foreign key to `users`.
 */
const V5: Migration = Object.freeze({
  to: 5,
  creates: Object.freeze(['circle_grants']),
  sql: Object.freeze([
    `CREATE TABLE circle_grants (
       circle_id TEXT NOT NULL REFERENCES circles (id) ON DELETE CASCADE,
       owner_id TEXT NOT NULL,
       grantee_id TEXT NOT NULL,
       categories TEXT NOT NULL CHECK (json_valid(categories) AND json_array_length(categories) > 0),
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (circle_id, owner_id, grantee_id),
       CHECK (owner_id <> grantee_id)
     ) WITHOUT ROWID`,
    'CREATE INDEX circle_grants_by_grantee ON circle_grants (circle_id, grantee_id, owner_id)',
    `CREATE TRIGGER circle_grants_end_with_member AFTER DELETE ON circle_members
     BEGIN
       DELETE FROM circle_grants WHERE circle_id = old.circle_id AND (owner_id = old.user_id OR grantee_id = old.user_id);
     END`,
  ]),
});

/**
 * Version 6: the change log (R-014). One row per change to a brain: when, which scope (a person's own brain or one circle's),
 * who, what happened, and for a removal what the thing was called. The text columns hold JSON text, so any id or title is kept
 * exactly (a lone surrogate included, which a plain text column would not). Entries go with their circle (a trigger on the
 * circle row) and a person's own entries go with their account (a trigger on the user row), so deleting either, by any route,
 * leaves no entries behind. Like memberships, entries have no foreign key to `users`.
 */
const V6: Migration = Object.freeze({
  to: 6,
  creates: Object.freeze(['ledger']),
  sql: Object.freeze([
    `CREATE TABLE ledger (
       id TEXT NOT NULL PRIMARY KEY,
       at INTEGER NOT NULL CHECK (at >= 0),
       scope_kind TEXT NOT NULL CHECK (scope_kind IN ('personal', 'circle')),
       scope_id TEXT NOT NULL,
       actor TEXT NOT NULL,
       action TEXT NOT NULL CHECK (action IN ('added', 'updated', 'removed')),
       kind TEXT NOT NULL CHECK (kind IN ('item', 'category')),
       subject TEXT NOT NULL CHECK (json_valid(subject)),
       title TEXT CHECK (title IS NULL OR json_valid(title)),
       summary TEXT CHECK (summary IS NULL OR json_valid(summary)),
       proposal_id TEXT NOT NULL
     ) WITHOUT ROWID`,
    'CREATE INDEX ledger_by_scope ON ledger (scope_kind, scope_id, at DESC, id DESC)',
    'CREATE INDEX ledger_by_time ON ledger (at)',
    `CREATE TRIGGER ledger_ends_with_circle AFTER DELETE ON circles
     BEGIN
       DELETE FROM ledger WHERE scope_kind = 'circle' AND scope_id = old.id;
     END`,
    `CREATE TRIGGER ledger_ends_with_user AFTER DELETE ON users
     BEGIN
       DELETE FROM ledger WHERE scope_kind = 'personal' AND scope_id = old.id;
     END`,
  ]),
});

export const USERS_MIGRATIONS: readonly Migration[] = Object.freeze([V1, V2, V3, V4, V5, V6]);

export function prepareUsersDatabase(db: Db): PrepareResult {
  return prepareSchema(db, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS, foreignCode: 'NOT_A_USERS_DATABASE' });
}
