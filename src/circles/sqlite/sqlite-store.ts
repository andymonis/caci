import { DbError, openDb, type Db } from '../../sqlite/db.js';
import { prepareUsersDatabase } from '../../users/sqlite/index.js';
import { checkLimit, decodeCursor, encodeCursor } from '../cursor.js';
import { circlesError, type CirclesError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type { AcceptLimits, CirclePage, CirclePatch, CircleRecord, CircleStore, CircleSummary, CreateCircleLimits, Invitation, InvitationRecord, InviteLimits, Listing, Membership, RemoveUserOutcome } from '../store.js';
import type { Circle, CircleRole } from '../types.js';

export interface SqliteCircleStoreOptions {
  /** The user database's file (circles live beside the accounts), or `:memory:` (the default). */
  readonly path?: string;
  /** How long to wait for another process's lock before failing. Default 5,000 ms. */
  readonly busyTimeoutMs?: number;
}

/** A circle store in the user database, which must be closed when you are done with it. */
export interface SqliteCircleStore extends CircleStore {
  close(): void;
}

interface CircleRow {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}
interface MemberRow {
  circle_id: string;
  user_id: string;
  role: CircleRole;
  joined_at: number;
}
interface InvitationRow {
  id: string;
  circle_id: string;
  username: string;
  role: CircleRole;
  invited_by: string;
  created_at: number;
  expires_at: number;
}
interface SummaryRow extends CircleRow {
  role: CircleRole;
  joined_at: number;
  member_count: number;
}

const CIRCLE_COLUMNS = 'id, name, description, created_at, updated_at';
const MEMBER_COLUMNS = 'circle_id, user_id, role, joined_at';
const INVITATION_COLUMNS = 'id, circle_id, username, role, invited_by, created_at, expires_at';
/** Owner first, then managers, members, observers: who inherits a circle. */
const HEIR_ORDER = "CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, joined_at, user_id";

const circleOf = (row: CircleRow): Circle => ({ id: row.id, name: row.name, ...(row.description === null ? {} : { description: row.description }), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });
const memberOf = (row: MemberRow): Membership => ({ circleId: row.circle_id, userId: row.user_id, role: row.role, joinedAt: Number(row.joined_at) });
const invitationOf = (row: InvitationRow): Invitation => ({ id: row.id, circleId: row.circle_id, username: row.username, role: row.role, invitedBy: row.invited_by, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) });
const notFound = (what: string): CirclesError => circlesError('NOT_FOUND', `no such ${what}`);

/** A failure the caller can do nothing about, as a result: never the SQL, never a value. */
function failure(cause: unknown): CirclesError {
  return circlesError('STORAGE_ERROR', cause instanceof DbError ? cause.message : 'the circle database could not complete the request');
}

/**
 * The SQLite circle store. Every method does its work without awaiting, so calls never interleave in
 * this process, and anything that takes more than one statement runs in one `BEGIN IMMEDIATE`
 * transaction so other processes cannot interleave either. The rules that must hold under
 * concurrency (a circle keeps an owner, the caps, accept-with-membership, the hand-over) are checked
 * inside that transaction.
 */
export function createSqliteCircleStore(options: SqliteCircleStoreOptions = {}): SqliteCircleStore {
  const db = openDb(options);
  try {
    prepareUsersDatabase(db);
  } catch (cause) {
    db.close();
    throw cause;
  }

  function inTransaction<T>(body: (db: Db) => T): T {
    db.begin();
    try {
      const result = body(db);
      db.commit();
      return result;
    } catch (cause) {
      if (db.inTransaction) db.rollback();
      throw cause;
    }
  }
  const count = (sql: string, ...params: Array<string | number>): number => Number(db.get<{ n: number }>(sql, ...params)?.n ?? 0);
  const circleRow = (id: string): CircleRow | undefined => db.get<CircleRow>(`SELECT ${CIRCLE_COLUMNS} FROM circles WHERE id = ?`, id);
  const memberRow = (circleId: string, userId: string): MemberRow | undefined => db.get<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM circle_members WHERE circle_id = ? AND user_id = ?`, circleId, userId);
  const invitationRow = (id: string): InvitationRow | undefined => db.get<InvitationRow>(`SELECT ${INVITATION_COLUMNS} FROM circle_invitations WHERE id = ?`, id);
  const owners = (circleId: string): number => count("SELECT count(*) AS n FROM circle_members WHERE circle_id = ? AND role = 'owner'", circleId);
  const circlesOfUser = (userId: string): number => count('SELECT count(*) AS n FROM circle_members WHERE user_id = ?', userId);

  /** One page of `rows` fetched as limit + 1 in key order. */
  function listing<R, T>(page: CirclePage, fetch: (after: string | undefined, take: number) => R[], keyOf: (row: R) => string, map: (row: R) => T): Listing<T> {
    const limit = checkLimit(page.limit);
    const after = page.cursor === null ? undefined : decodeCursor(page.cursor);
    const rows = fetch(after, limit + 1);
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    return { items: shown.map(map), nextCursor: rows.length > limit && last !== undefined ? encodeCursor(keyOf(last)) : null };
  }

  return {
    createCircle: async (record: CircleRecord, ownerId: string, limits: CreateCircleLimits): Promise<Result<Circle, CirclesError>> => {
      try {
        return inTransaction(() => {
          if (circleRow(record.id) !== undefined) return err(circlesError('CONFLICT', 'that circle id already exists', { field: 'id' }));
          if (circlesOfUser(ownerId) >= limits.maxCirclesPerUser) return err(circlesError('LIMIT_REACHED', `a person may be in at most ${limits.maxCirclesPerUser} circles`));
          db.run(`INSERT INTO circles (${CIRCLE_COLUMNS}) VALUES (?, ?, ?, ?, ?)`, record.id, record.name, record.description ?? null, record.createdAt, record.createdAt);
          db.run(`INSERT INTO circle_members (${MEMBER_COLUMNS}) VALUES (?, ?, 'owner', ?)`, record.id, ownerId, record.createdAt);
          return ok(circleOf(circleRow(record.id) as CircleRow));
        });
      } catch (cause) {
        return err(failure(cause));
      }
    },
    getCircle: async (id) => {
      const row = circleRow(id);
      return row === undefined ? undefined : circleOf(row);
    },
    updateCircle: async (id: string, patch: CirclePatch): Promise<Result<Circle, CirclesError>> => {
      try {
        return inTransaction(() => {
          const row = circleRow(id);
          if (row === undefined) return err(notFound('circle'));
          const description = patch.description === undefined ? row.description : patch.description;
          db.run('UPDATE circles SET name = ?, description = ?, updated_at = ? WHERE id = ?', patch.name ?? row.name, description, patch.updatedAt, id);
          return ok(circleOf(circleRow(id) as CircleRow));
        });
      } catch (cause) {
        return err(failure(cause));
      }
    },
    deleteCircle: async (id) => db.run('DELETE FROM circles WHERE id = ?', id) > 0,

    membershipOf: async (circleId, userId) => {
      const row = memberRow(circleId, userId);
      return row === undefined ? undefined : memberOf(row);
    },
    listCirclesOf: async (userId, page) =>
      listing<SummaryRow, CircleSummary>(
        page,
        (after, take) => {
          const select = `SELECT c.id, c.name, c.description, c.created_at, c.updated_at, m.role, m.joined_at,
                            (SELECT count(*) FROM circle_members x WHERE x.circle_id = c.id) AS member_count
                          FROM circle_members m JOIN circles c ON c.id = m.circle_id`;
          return after === undefined ? db.all<SummaryRow>(`${select} WHERE m.user_id = ? ORDER BY c.id LIMIT ?`, userId, take) : db.all<SummaryRow>(`${select} WHERE m.user_id = ? AND c.id > ? ORDER BY c.id LIMIT ?`, userId, after, take);
        },
        (row) => row.id,
        (row) => ({ circle: circleOf(row), role: row.role, joinedAt: Number(row.joined_at), memberCount: Number(row.member_count) }),
      ),
    listMembers: async (circleId, page) =>
      listing<MemberRow, Membership>(
        page,
        (after, take) =>
          after === undefined
            ? db.all<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM circle_members WHERE circle_id = ? ORDER BY user_id LIMIT ?`, circleId, take)
            : db.all<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM circle_members WHERE circle_id = ? AND user_id > ? ORDER BY user_id LIMIT ?`, circleId, after, take),
        (row) => row.user_id,
        memberOf,
      ),

    changeRole: async (circleId: string, userId: string, role: CircleRole): Promise<Result<Membership, CirclesError>> => {
      try {
        return inTransaction(() => {
          const row = memberRow(circleId, userId);
          if (row === undefined) return err(notFound('member'));
          if (row.role === 'owner' && role !== 'owner' && owners(circleId) === 1) return err(circlesError('LAST_OWNER', 'a circle must keep an owner'));
          db.run('UPDATE circle_members SET role = ? WHERE circle_id = ? AND user_id = ?', role, circleId, userId);
          return ok(memberOf(memberRow(circleId, userId) as MemberRow));
        });
      } catch (cause) {
        return err(failure(cause));
      }
    },
    removeMember: async (circleId: string, userId: string): Promise<Result<boolean, CirclesError>> => {
      try {
        return inTransaction(() => {
          const row = memberRow(circleId, userId);
          if (row === undefined) return ok(false);
          if (row.role === 'owner' && owners(circleId) === 1) return err(circlesError('LAST_OWNER', 'a circle must keep an owner'));
          db.run('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?', circleId, userId);
          return ok(true);
        });
      } catch (cause) {
        return err(failure(cause));
      }
    },

    createInvitation: async (record: InvitationRecord, limits: InviteLimits, now: number): Promise<Result<Invitation, CirclesError>> => {
      try {
        return inTransaction(() => {
          if (circleRow(record.circleId) === undefined) return err(notFound('circle'));
          db.run('DELETE FROM circle_invitations WHERE circle_id = ? AND expires_at <= ?', record.circleId, now);
          const username = record.username.toLowerCase();
          const same = db.get<InvitationRow>(`SELECT ${INVITATION_COLUMNS} FROM circle_invitations WHERE circle_id = ? AND username = ?`, record.circleId, username);
          if (same !== undefined) {
            db.run('UPDATE circle_invitations SET role = ?, invited_by = ?, expires_at = ? WHERE id = ?', record.role, record.invitedBy, record.expiresAt, same.id);
            return ok(invitationOf(invitationRow(same.id) as InvitationRow));
          }
          if (invitationRow(record.id) !== undefined) return err(circlesError('CONFLICT', 'that invitation id already exists', { field: 'id' }));
          if (count('SELECT count(*) AS n FROM circle_invitations WHERE circle_id = ?', record.circleId) >= limits.maxOpenInvitationsPerCircle) {
            return err(circlesError('LIMIT_REACHED', `a circle may have at most ${limits.maxOpenInvitationsPerCircle} open invitations`));
          }
          db.run(`INSERT INTO circle_invitations (${INVITATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`, record.id, record.circleId, username, record.role, record.invitedBy, record.createdAt, record.expiresAt);
          return ok(invitationOf(invitationRow(record.id) as InvitationRow));
        });
      } catch (cause) {
        return err(failure(cause));
      }
    },
    getInvitation: async (id) => {
      const row = invitationRow(id);
      return row === undefined ? undefined : invitationOf(row);
    },
    listInvitationsOfCircle: async (circleId, now, page) =>
      listing<InvitationRow, Invitation>(
        page,
        (after, take) =>
          after === undefined
            ? db.all<InvitationRow>(`SELECT ${INVITATION_COLUMNS} FROM circle_invitations WHERE circle_id = ? AND expires_at > ? ORDER BY id LIMIT ?`, circleId, now, take)
            : db.all<InvitationRow>(`SELECT ${INVITATION_COLUMNS} FROM circle_invitations WHERE circle_id = ? AND expires_at > ? AND id > ? ORDER BY id LIMIT ?`, circleId, now, after, take),
        (row) => row.id,
        invitationOf,
      ),
    listInvitationsFor: async (username, now, page) =>
      listing<InvitationRow, Invitation>(
        page,
        (after, take) =>
          after === undefined
            ? db.all<InvitationRow>(`SELECT ${INVITATION_COLUMNS} FROM circle_invitations WHERE username = ? AND expires_at > ? ORDER BY id LIMIT ?`, username.toLowerCase(), now, take)
            : db.all<InvitationRow>(`SELECT ${INVITATION_COLUMNS} FROM circle_invitations WHERE username = ? AND expires_at > ? AND id > ? ORDER BY id LIMIT ?`, username.toLowerCase(), now, after, take),
        (row) => row.id,
        invitationOf,
      ),
    revokeInvitation: async (invitationId, circleId, now) =>
      inTransaction(() => {
        const row = invitationRow(invitationId);
        if (row === undefined || row.circle_id !== circleId) return false;
        db.run('DELETE FROM circle_invitations WHERE id = ?', invitationId);
        return now < Number(row.expires_at);
      }),
    declineInvitation: async (invitationId, username, now) =>
      inTransaction(() => {
        const row = invitationRow(invitationId);
        if (row === undefined || row.username !== username.toLowerCase()) return false;
        db.run('DELETE FROM circle_invitations WHERE id = ?', invitationId);
        return now < Number(row.expires_at);
      }),
    acceptInvitation: async (invitationId: string, userId: string, username: string, now: number, limits: AcceptLimits): Promise<Result<Membership, CirclesError>> => {
      try {
        return inTransaction(() => {
          const row = invitationRow(invitationId);
          if (row === undefined || row.username !== username.toLowerCase()) return err(notFound('invitation'));
          if (now >= Number(row.expires_at) || circleRow(row.circle_id) === undefined) {
            db.run('DELETE FROM circle_invitations WHERE id = ?', invitationId);
            return err(notFound('invitation'));
          }
          const existing = memberRow(row.circle_id, userId);
          if (existing !== undefined) {
            db.run('DELETE FROM circle_invitations WHERE id = ?', invitationId);
            return ok(memberOf(existing));
          }
          if (count('SELECT count(*) AS n FROM circle_members WHERE circle_id = ?', row.circle_id) >= limits.maxMembersPerCircle) {
            return err(circlesError('LIMIT_REACHED', `a circle may have at most ${limits.maxMembersPerCircle} people`));
          }
          if (circlesOfUser(userId) >= limits.maxCirclesPerUser) return err(circlesError('LIMIT_REACHED', `a person may be in at most ${limits.maxCirclesPerUser} circles`));
          db.run(`INSERT INTO circle_members (${MEMBER_COLUMNS}) VALUES (?, ?, ?, ?)`, row.circle_id, userId, row.role, now);
          db.run('DELETE FROM circle_invitations WHERE id = ?', invitationId);
          return ok(memberOf(memberRow(row.circle_id, userId) as MemberRow));
        });
      } catch (cause) {
        return err(failure(cause));
      }
    },

    removeUser: async (userId: string, username: string): Promise<RemoveUserOutcome> =>
      inTransaction(() => {
        const handedOver: string[] = [];
        const dissolved: string[] = [];
        const mine = db.all<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM circle_members WHERE user_id = ? ORDER BY circle_id`, userId);
        for (const me of mine) {
          if (me.role === 'owner' && owners(me.circle_id) === 1) {
            const heir = db.get<{ user_id: string }>(`SELECT user_id FROM circle_members WHERE circle_id = ? AND user_id <> ? ORDER BY ${HEIR_ORDER} LIMIT 1`, me.circle_id, userId);
            if (heir === undefined) {
              db.run('DELETE FROM circles WHERE id = ?', me.circle_id);
              dissolved.push(me.circle_id);
              continue;
            }
            db.run("UPDATE circle_members SET role = 'owner' WHERE circle_id = ? AND user_id = ?", me.circle_id, heir.user_id);
            handedOver.push(me.circle_id);
          }
          db.run('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?', me.circle_id, userId);
        }
        const removed = db.run('DELETE FROM circle_invitations WHERE username = ? OR invited_by = ?', username.toLowerCase(), userId);
        return { left: mine.length, handedOver, dissolved, invitationsRemoved: removed };
      }),
    purgeExpired: async (now) => db.run('DELETE FROM circle_invitations WHERE expires_at <= ?', now),

    close: () => db.close(),
  };
}
