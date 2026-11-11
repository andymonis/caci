import { DbError, openDb, type Db } from '../../sqlite/db.js';
import { prepareUsersDatabase } from '../../users/sqlite/index.js';
import { checkLimit, decodeCursor, encodeCursor } from '../cursor.js';
import { normaliseCategories, SELF_GRANT } from '../grants.js';
import { circlesError, type CirclesError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type { AcceptLimits, CirclePage, CirclePatch, CircleRecord, CircleStore, CircleSummary, CreateCircleLimits, Grant, GrantLimits, Invitation, InvitationRecord, InviteLimits, JoinLink, JoinLinkLimits, JoinLinkRecord, JoinOutcome, JoinRequest, JoinRequestLimits, Listing, Membership, RemoveUserOutcome, RequestOutcome } from '../store.js';
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
interface GrantRow {
  circle_id: string;
  owner_id: string;
  grantee_id: string;
  categories: string;
  updated_at: number;
}
interface JoinLinkRow {
  id: string;
  circle_id: string;
  role: JoinLinkRecord['role'];
  label: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  max_uses: number;
  uses: number;
  approval: number;
}
interface JoinRequestRow {
  id: string;
  circle_id: string;
  user_id: string;
  role: JoinRequest['role'];
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

const LINK_COLUMNS = 'id, circle_id, role, label, created_by, created_at, expires_at, max_uses, uses, approval';
const REQUEST_COLUMNS = 'id, circle_id, user_id, role, created_at, expires_at';
/** A link that can still be used: not expired and with uses left (the circle being there is the cascade's job). */
const LIVE_LINK = 'expires_at > ? AND uses < max_uses';
const HASH_SHAPE = /^[0-9a-f]{64}$/;
const linkOf = (row: JoinLinkRow): JoinLink => ({ id: row.id, circleId: row.circle_id, role: row.role, label: row.label, createdBy: row.created_by, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), maxUses: Number(row.max_uses), uses: Number(row.uses), approval: Number(row.approval) === 1 });
const requestOf = (row: JoinRequestRow): JoinRequest => ({ id: row.id, circleId: row.circle_id, userId: row.user_id, role: row.role, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) });
const GRANT_COLUMNS = 'circle_id, owner_id, grantee_id, categories, updated_at';
const grantOf = (row: GrantRow): Grant => ({ circleId: row.circle_id, ownerId: row.owner_id, granteeId: row.grantee_id, categories: JSON.parse(row.categories) as string[], updatedAt: Number(row.updated_at) });
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
    listCircleIds: async (page) =>
      listing<{ id: string }, string>(
        page,
        (after, take) => (after === undefined ? db.all<{ id: string }>('SELECT id FROM circles ORDER BY id LIMIT ?', take) : db.all<{ id: string }>('SELECT id FROM circles WHERE id > ? ORDER BY id LIMIT ?', after, take)),
        (row) => row.id,
        (row) => row.id,
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
        db.run('DELETE FROM circle_join_requests WHERE user_id = ?', userId);
        const removed = db.run('DELETE FROM circle_invitations WHERE username = ? OR invited_by = ?', username.toLowerCase(), userId);
        return { left: mine.length, handedOver, dissolved, invitationsRemoved: removed };
      }),
    purgeExpired: async (now) => db.run('DELETE FROM circle_invitations WHERE expires_at <= ?', now),

    setGrant: async (circleId: string, ownerId: string, granteeId: string, categories: readonly string[], now: number, limits: GrantLimits): Promise<Result<Grant | undefined, CirclesError>> => {
      try {
        return inTransaction(() => {
          if (circleRow(circleId) === undefined) return err(notFound('circle'));
          if (memberRow(circleId, ownerId) === undefined || memberRow(circleId, granteeId) === undefined) return err(notFound('member'));
          if (ownerId === granteeId) return err(SELF_GRANT());
          const normal = normaliseCategories(categories, limits.maxCategoriesPerGrant);
          if (!normal.ok) return normal;
          if (normal.value.length === 0) {
            db.run('DELETE FROM circle_grants WHERE circle_id = ? AND owner_id = ? AND grantee_id = ?', circleId, ownerId, granteeId);
            return ok(undefined);
          }
          db.run(`INSERT OR REPLACE INTO circle_grants (${GRANT_COLUMNS}) VALUES (?, ?, ?, ?, ?)`, circleId, ownerId, granteeId, JSON.stringify(normal.value), now);
          return ok(grantOf(db.get<GrantRow>(`SELECT ${GRANT_COLUMNS} FROM circle_grants WHERE circle_id = ? AND owner_id = ? AND grantee_id = ?`, circleId, ownerId, granteeId) as GrantRow));
        });
      } catch (cause) {
        return err(failure(cause));
      }
    },
    getGrant: async (circleId, ownerId, granteeId) => {
      const row = db.get<GrantRow>(`SELECT ${GRANT_COLUMNS} FROM circle_grants WHERE circle_id = ? AND owner_id = ? AND grantee_id = ?`, circleId, ownerId, granteeId);
      return row === undefined ? undefined : grantOf(row);
    },
    listGrantsBy: async (circleId, ownerId, page) =>
      listing<GrantRow, Grant>(
        page,
        (after, take) =>
          after === undefined
            ? db.all<GrantRow>(`SELECT ${GRANT_COLUMNS} FROM circle_grants WHERE circle_id = ? AND owner_id = ? ORDER BY grantee_id LIMIT ?`, circleId, ownerId, take)
            : db.all<GrantRow>(`SELECT ${GRANT_COLUMNS} FROM circle_grants WHERE circle_id = ? AND owner_id = ? AND grantee_id > ? ORDER BY grantee_id LIMIT ?`, circleId, ownerId, after, take),
        (row) => row.grantee_id,
        grantOf,
      ),
    listGrantsTo: async (circleId, granteeId, page) =>
      listing<GrantRow, Grant>(
        page,
        (after, take) =>
          after === undefined
            ? db.all<GrantRow>(`SELECT ${GRANT_COLUMNS} FROM circle_grants WHERE circle_id = ? AND grantee_id = ? ORDER BY owner_id LIMIT ?`, circleId, granteeId, take)
            : db.all<GrantRow>(`SELECT ${GRANT_COLUMNS} FROM circle_grants WHERE circle_id = ? AND grantee_id = ? AND owner_id > ? ORDER BY owner_id LIMIT ?`, circleId, granteeId, after, take),
        (row) => row.owner_id,
        grantOf,
      ),
    withdrawGrant: async (circleId, ownerId, granteeId) => db.run('DELETE FROM circle_grants WHERE circle_id = ? AND owner_id = ? AND grantee_id = ?', circleId, ownerId, granteeId) > 0,
    createJoinLink: async (record: JoinLinkRecord, limits: JoinLinkLimits, now: number): Promise<Result<JoinLink, CirclesError>> => {
      try {
        return inTransaction(() => {
          if (circleRow(record.circleId) === undefined) return err(notFound('circle'));
          if (record.role !== 'member' && record.role !== 'observer') return err(circlesError('INVALID_INPUT', 'a join link can only offer member or observer', { field: 'role' }));
          if (typeof record.tokenHash !== 'string' || !HASH_SHAPE.test(record.tokenHash)) return err(circlesError('INVALID_INPUT', 'bad token hash', { field: 'tokenHash' }));
          if (!Number.isInteger(record.maxUses) || record.maxUses < 1 || record.maxUses > 100) return err(circlesError('INVALID_INPUT', 'a link allows 1 to 100 uses', { field: 'uses' }));
          db.run('DELETE FROM circle_join_links WHERE circle_id = ? AND NOT (expires_at > ? AND uses < max_uses)', record.circleId, now);
          if (count('SELECT count(*) AS n FROM circle_join_links WHERE id = ? OR token_hash = ?', record.id, record.tokenHash) > 0) return err(circlesError('CONFLICT', 'that join link already exists', { field: 'id' }));
          if (count('SELECT count(*) AS n FROM circle_join_links WHERE circle_id = ?', record.circleId) >= limits.maxLiveLinksPerCircle) {
            return err(circlesError('LIMIT_REACHED', `a circle may have at most ${limits.maxLiveLinksPerCircle} live join links`));
          }
          db.run('INSERT INTO circle_join_links (id, circle_id, token_hash, role, label, created_by, created_at, expires_at, max_uses, uses, approval) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)', record.id, record.circleId, record.tokenHash, record.role, record.label, record.createdBy, record.createdAt, record.expiresAt, record.maxUses, record.approval ? 1 : 0);
          return ok(linkOf(db.get<JoinLinkRow>(`SELECT ${LINK_COLUMNS} FROM circle_join_links WHERE id = ?`, record.id) as JoinLinkRow));
        });
      } catch (cause) {
        return err(failure(cause));
      }
    },
    getJoinLinkByHash: async (tokenHash, now) => {
      if (typeof tokenHash !== 'string') return undefined;
      const row = db.get<JoinLinkRow>(`SELECT ${LINK_COLUMNS} FROM circle_join_links WHERE token_hash = ? AND ${LIVE_LINK}`, tokenHash, now);
      return row === undefined ? undefined : linkOf(row);
    },
    listJoinLinks: async (circleId, now, page) =>
      listing(
        page,
        (after, take) =>
          after === undefined
            ? db.all<JoinLinkRow>(`SELECT ${LINK_COLUMNS} FROM circle_join_links WHERE circle_id = ? AND ${LIVE_LINK} ORDER BY id LIMIT ?`, circleId, now, take)
            : db.all<JoinLinkRow>(`SELECT ${LINK_COLUMNS} FROM circle_join_links WHERE circle_id = ? AND ${LIVE_LINK} AND id > ? ORDER BY id LIMIT ?`, circleId, now, after, take),
        (row) => row.id,
        linkOf,
      ),
    revokeJoinLink: async (linkId, circleId, now) =>
      inTransaction(() => {
        const row = db.get<JoinLinkRow>(`SELECT ${LINK_COLUMNS} FROM circle_join_links WHERE id = ? AND circle_id = ?`, linkId, circleId);
        if (row === undefined) return false;
        db.run('DELETE FROM circle_join_links WHERE id = ?', linkId);
        return now < Number(row.expires_at) && Number(row.uses) < Number(row.max_uses);
      }),
    joinWithLink: async (tokenHash: string, userId: string, now: number, limits: AcceptLimits): Promise<Result<JoinOutcome, CirclesError>> => {
      try {
        return inTransaction(() => {
          const link = typeof tokenHash === 'string' ? db.get<JoinLinkRow>(`SELECT ${LINK_COLUMNS} FROM circle_join_links WHERE token_hash = ? AND ${LIVE_LINK}`, tokenHash, now) : undefined;
          if (link === undefined) return err(notFound('join link'));
          if (Number(link.approval) === 1) return err(circlesError('CONFLICT', 'this join link needs approval'));
          const existing = memberRow(link.circle_id, userId);
          if (existing !== undefined) return ok({ membership: memberOf(existing), joined: false });
          if (count('SELECT count(*) AS n FROM circle_members WHERE circle_id = ?', link.circle_id) >= limits.maxMembersPerCircle) {
            return err(circlesError('LIMIT_REACHED', `a circle may have at most ${limits.maxMembersPerCircle} people`));
          }
          if (circlesOfUser(userId) >= limits.maxCirclesPerUser) return err(circlesError('LIMIT_REACHED', `a person may be in at most ${limits.maxCirclesPerUser} circles`));
          db.run(`INSERT INTO circle_members (${MEMBER_COLUMNS}) VALUES (?, ?, ?, ?)`, link.circle_id, userId, link.role, now);
          db.run('UPDATE circle_join_links SET uses = uses + 1 WHERE id = ?', link.id);
          return ok({ membership: memberOf(memberRow(link.circle_id, userId) as MemberRow), joined: true });
        });
      } catch (cause) {
        return err(failure(cause));
      }
    },

    requestJoin: async (tokenHash: string, requestId: string, userId: string, now: number, limits: JoinRequestLimits): Promise<Result<RequestOutcome, CirclesError>> => {
      try {
        return inTransaction(() => {
          const link = typeof tokenHash === 'string' ? db.get<JoinLinkRow>(`SELECT ${LINK_COLUMNS} FROM circle_join_links WHERE token_hash = ? AND ${LIVE_LINK}`, tokenHash, now) : undefined;
          if (link === undefined) return err(notFound('join link'));
          if (Number(link.approval) !== 1) return err(circlesError('CONFLICT', 'this join link does not need approval'));
          const existing = memberRow(link.circle_id, userId);
          if (existing !== undefined) return ok({ state: 'member', membership: memberOf(existing) });
          db.run('DELETE FROM circle_join_requests WHERE circle_id = ? AND expires_at <= ?', link.circle_id, now);
          const earlier = db.get<JoinRequestRow>(`SELECT ${REQUEST_COLUMNS} FROM circle_join_requests WHERE circle_id = ? AND user_id = ?`, link.circle_id, userId);
          if (earlier !== undefined) return ok({ state: 'waiting', request: requestOf(earlier) });
          if (count('SELECT count(*) AS n FROM circle_join_requests WHERE id = ?', requestId) > 0) return err(circlesError('CONFLICT', 'that join request id already exists', { field: 'id' }));
          if (count('SELECT count(*) AS n FROM circle_join_requests WHERE circle_id = ?', link.circle_id) >= limits.maxPendingPerCircle) {
            return err(circlesError('LIMIT_REACHED', `a circle may have at most ${limits.maxPendingPerCircle} requests waiting`));
          }
          db.run(`INSERT INTO circle_join_requests (${REQUEST_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`, requestId, link.circle_id, userId, link.role, now, now + limits.ttlMs);
          db.run('UPDATE circle_join_links SET uses = uses + 1 WHERE id = ?', link.id);
          return ok({ state: 'requested', request: requestOf(db.get<JoinRequestRow>(`SELECT ${REQUEST_COLUMNS} FROM circle_join_requests WHERE id = ?`, requestId) as JoinRequestRow) });
        });
      } catch (cause) {
        return err(failure(cause));
      }
    },
    listJoinRequests: async (circleId, now, page) =>
      listing(
        page,
        (after, take) =>
          after === undefined
            ? db.all<JoinRequestRow>(`SELECT ${REQUEST_COLUMNS} FROM circle_join_requests WHERE circle_id = ? AND expires_at > ? ORDER BY id LIMIT ?`, circleId, now, take)
            : db.all<JoinRequestRow>(`SELECT ${REQUEST_COLUMNS} FROM circle_join_requests WHERE circle_id = ? AND expires_at > ? AND id > ? ORDER BY id LIMIT ?`, circleId, now, after, take),
        (row) => row.id,
        requestOf,
      ),
    listJoinRequestsBy: async (userId, now, page) =>
      listing(
        page,
        (after, take) =>
          after === undefined
            ? db.all<JoinRequestRow>(`SELECT ${REQUEST_COLUMNS} FROM circle_join_requests WHERE user_id = ? AND expires_at > ? ORDER BY id LIMIT ?`, userId, now, take)
            : db.all<JoinRequestRow>(`SELECT ${REQUEST_COLUMNS} FROM circle_join_requests WHERE user_id = ? AND expires_at > ? AND id > ? ORDER BY id LIMIT ?`, userId, now, after, take),
        (row) => row.id,
        requestOf,
      ),
    approveJoinRequest: async (requestId: string, circleId: string, now: number, limits: AcceptLimits): Promise<Result<Membership, CirclesError>> => {
      try {
        return inTransaction(() => {
          const row = db.get<JoinRequestRow>(`SELECT ${REQUEST_COLUMNS} FROM circle_join_requests WHERE id = ? AND circle_id = ? AND expires_at > ?`, requestId, circleId, now);
          if (row === undefined) return err(notFound('join request'));
          const existing = memberRow(circleId, row.user_id);
          if (existing !== undefined) {
            db.run('DELETE FROM circle_join_requests WHERE id = ?', requestId);
            return ok(memberOf(existing));
          }
          if (count('SELECT count(*) AS n FROM circle_members WHERE circle_id = ?', circleId) >= limits.maxMembersPerCircle) {
            return err(circlesError('LIMIT_REACHED', `a circle may have at most ${limits.maxMembersPerCircle} people`));
          }
          if (circlesOfUser(row.user_id) >= limits.maxCirclesPerUser) return err(circlesError('LIMIT_REACHED', `a person may be in at most ${limits.maxCirclesPerUser} circles`));
          db.run(`INSERT INTO circle_members (${MEMBER_COLUMNS}) VALUES (?, ?, ?, ?)`, circleId, row.user_id, row.role, now);
          db.run('DELETE FROM circle_join_requests WHERE id = ?', requestId);
          return ok(memberOf(memberRow(circleId, row.user_id) as MemberRow));
        });
      } catch (cause) {
        return err(failure(cause));
      }
    },
    declineJoinRequest: async (requestId, circleId, now) =>
      inTransaction(() => {
        const row = db.get<JoinRequestRow>(`SELECT ${REQUEST_COLUMNS} FROM circle_join_requests WHERE id = ? AND circle_id = ?`, requestId, circleId);
        if (row === undefined) return false;
        db.run('DELETE FROM circle_join_requests WHERE id = ?', requestId);
        return now < Number(row.expires_at);
      }),
    close: () => db.close(),
  };
}
