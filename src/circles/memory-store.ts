import { circlesError, type CirclesError } from './errors.js';
import { pageOf } from './cursor.js';
import { err, ok, type Result } from './result.js';
import type { AcceptLimits, CirclePage, CirclePatch, CircleRecord, CircleStore, CircleSummary, CreateCircleLimits, Invitation, InvitationRecord, InviteLimits, Listing, Membership, RemoveUserOutcome } from './store.js';
import type { Circle, CircleRole } from './types.js';

const copyCircle = (c: Circle): Circle => ({ ...c });
const copyMember = (m: Membership): Membership => ({ ...m });
const copyInvitation = (i: Invitation): Invitation => ({ ...i });
const RANK: Readonly<Record<CircleRole, number>> = { owner: 0, manager: 1, member: 2, observer: 3 };
const notFound = (what: string): CirclesError => circlesError('NOT_FOUND', `no such ${what}`);

/**
 * The reference circle store: in memory, for tests and as the model the SQLite store must match.
 * Every method runs to completion without awaiting, so no two calls interleave and each is atomic.
 */
export function createMemoryCircleStore(): CircleStore {
  const circles = new Map<string, Circle>();
  const members = new Map<string, Map<string, Membership>>();
  const invitations = new Map<string, Invitation>();

  const circlesOfUser = (userId: string): string[] => [...members.entries()].filter(([, m]) => m.has(userId)).map(([id]) => id).sort();
  const owners = (circleId: string): number => [...(members.get(circleId)?.values() ?? [])].filter((m) => m.role === 'owner').length;
  const isOpen = (i: Invitation, now: number): boolean => now < i.expiresAt;
  const dropCircle = (id: string): void => {
    circles.delete(id);
    members.delete(id);
    for (const [invitationId, i] of invitations) if (i.circleId === id) invitations.delete(invitationId);
  };
  const page = <T>(rows: readonly T[], keyOf: (row: T) => string, p: CirclePage): Listing<T> => pageOf(rows, keyOf, p);

  return {
    createCircle: async (record: CircleRecord, ownerId: string, limits: CreateCircleLimits): Promise<Result<Circle, CirclesError>> => {
      if (circles.has(record.id)) return err(circlesError('CONFLICT', 'that circle id already exists', { field: 'id' }));
      if (circlesOfUser(ownerId).length >= limits.maxCirclesPerUser) return err(circlesError('LIMIT_REACHED', `a person may be in at most ${limits.maxCirclesPerUser} circles`));
      const circle: Circle = { id: record.id, name: record.name, ...(record.description === undefined ? {} : { description: record.description }), createdAt: record.createdAt, updatedAt: record.createdAt };
      circles.set(circle.id, circle);
      members.set(circle.id, new Map([[ownerId, { circleId: circle.id, userId: ownerId, role: 'owner', joinedAt: record.createdAt }]]));
      return ok(copyCircle(circle));
    },
    getCircle: async (id) => {
      const circle = circles.get(id);
      return circle === undefined ? undefined : copyCircle(circle);
    },
    updateCircle: async (id: string, patch: CirclePatch): Promise<Result<Circle, CirclesError>> => {
      const circle = circles.get(id);
      if (circle === undefined) return err(notFound('circle'));
      const description = patch.description === undefined ? circle.description : patch.description === null ? undefined : patch.description;
      const next: Circle = { id: circle.id, name: patch.name ?? circle.name, ...(description === undefined ? {} : { description }), createdAt: circle.createdAt, updatedAt: patch.updatedAt };
      circles.set(id, next);
      return ok(copyCircle(next));
    },
    deleteCircle: async (id) => {
      if (!circles.has(id)) return false;
      dropCircle(id);
      return true;
    },

    membershipOf: async (circleId, userId) => {
      const m = members.get(circleId)?.get(userId);
      return m === undefined ? undefined : copyMember(m);
    },
    listCirclesOf: async (userId, p) => {
      const rows: CircleSummary[] = circlesOfUser(userId).map((id) => {
        const m = members.get(id)?.get(userId) as Membership;
        return { circle: copyCircle(circles.get(id) as Circle), role: m.role, joinedAt: m.joinedAt, memberCount: members.get(id)?.size ?? 0 };
      });
      return page(rows, (r) => r.circle.id, p);
    },
    listMembers: async (circleId, p) => {
      const rows = [...(members.get(circleId)?.values() ?? [])].sort((a, b) => (a.userId < b.userId ? -1 : 1)).map(copyMember);
      return page(rows, (r) => r.userId, p);
    },

    changeRole: async (circleId: string, userId: string, role: CircleRole): Promise<Result<Membership, CirclesError>> => {
      const m = members.get(circleId)?.get(userId);
      if (m === undefined) return err(notFound('member'));
      if (m.role === 'owner' && role !== 'owner' && owners(circleId) === 1) return err(circlesError('LAST_OWNER', 'a circle must keep an owner'));
      const next: Membership = { ...m, role };
      members.get(circleId)?.set(userId, next);
      return ok(copyMember(next));
    },
    removeMember: async (circleId: string, userId: string): Promise<Result<boolean, CirclesError>> => {
      const m = members.get(circleId)?.get(userId);
      if (m === undefined) return ok(false);
      if (m.role === 'owner' && owners(circleId) === 1) return err(circlesError('LAST_OWNER', 'a circle must keep an owner'));
      members.get(circleId)?.delete(userId);
      return ok(true);
    },

    createInvitation: async (record: InvitationRecord, limits: InviteLimits, now: number): Promise<Result<Invitation, CirclesError>> => {
      if (!circles.has(record.circleId)) return err(notFound('circle'));
      for (const [id, i] of invitations) if (i.circleId === record.circleId && !isOpen(i, now)) invitations.delete(id);
      const username = record.username.toLowerCase();
      const same = [...invitations.values()].find((i) => i.circleId === record.circleId && i.username === username);
      if (same !== undefined) {
        const next: Invitation = { ...same, role: record.role, invitedBy: record.invitedBy, expiresAt: record.expiresAt };
        invitations.set(same.id, next);
        return ok(copyInvitation(next));
      }
      if (invitations.has(record.id)) return err(circlesError('CONFLICT', 'that invitation id already exists', { field: 'id' }));
      const open = [...invitations.values()].filter((i) => i.circleId === record.circleId).length;
      if (open >= limits.maxOpenInvitationsPerCircle) return err(circlesError('LIMIT_REACHED', `a circle may have at most ${limits.maxOpenInvitationsPerCircle} open invitations`));
      const invitation: Invitation = { ...record, username };
      invitations.set(invitation.id, invitation);
      return ok(copyInvitation(invitation));
    },
    getInvitation: async (id) => {
      const i = invitations.get(id);
      return i === undefined ? undefined : copyInvitation(i);
    },
    listInvitationsOfCircle: async (circleId, now, p) => {
      const rows = [...invitations.values()].filter((i) => i.circleId === circleId && isOpen(i, now)).sort((a, b) => (a.id < b.id ? -1 : 1)).map(copyInvitation);
      return page(rows, (r) => r.id, p);
    },
    listInvitationsFor: async (username, now, p) => {
      const name = username.toLowerCase();
      const rows = [...invitations.values()].filter((i) => i.username === name && isOpen(i, now)).sort((a, b) => (a.id < b.id ? -1 : 1)).map(copyInvitation);
      return page(rows, (r) => r.id, p);
    },
    revokeInvitation: async (invitationId, circleId, now) => {
      const i = invitations.get(invitationId);
      if (i === undefined || i.circleId !== circleId) return false;
      invitations.delete(invitationId);
      return isOpen(i, now);
    },
    declineInvitation: async (invitationId, username, now) => {
      const i = invitations.get(invitationId);
      if (i === undefined || i.username !== username.toLowerCase()) return false;
      invitations.delete(invitationId);
      return isOpen(i, now);
    },
    acceptInvitation: async (invitationId: string, userId: string, username: string, now: number, limits: AcceptLimits): Promise<Result<Membership, CirclesError>> => {
      const i = invitations.get(invitationId);
      if (i === undefined || i.username !== username.toLowerCase()) return err(notFound('invitation'));
      if (!isOpen(i, now) || !circles.has(i.circleId)) {
        invitations.delete(invitationId);
        return err(notFound('invitation'));
      }
      const here = members.get(i.circleId) as Map<string, Membership>;
      const existing = here.get(userId);
      if (existing !== undefined) {
        invitations.delete(invitationId);
        return ok(copyMember(existing));
      }
      if (here.size >= limits.maxMembersPerCircle) return err(circlesError('LIMIT_REACHED', `a circle may have at most ${limits.maxMembersPerCircle} people`));
      if (circlesOfUser(userId).length >= limits.maxCirclesPerUser) return err(circlesError('LIMIT_REACHED', `a person may be in at most ${limits.maxCirclesPerUser} circles`));
      const membership: Membership = { circleId: i.circleId, userId, role: i.role, joinedAt: now };
      here.set(userId, membership);
      invitations.delete(invitationId);
      return ok(copyMember(membership));
    },

    removeUser: async (userId: string, username: string): Promise<RemoveUserOutcome> => {
      const handedOver: string[] = [];
      const dissolved: string[] = [];
      const mine = circlesOfUser(userId);
      for (const circleId of mine) {
        const here = members.get(circleId) as Map<string, Membership>;
        const me = here.get(userId) as Membership;
        if (me.role === 'owner' && owners(circleId) === 1) {
          const heirs = [...here.values()].filter((m) => m.userId !== userId).sort((a, b) => RANK[a.role] - RANK[b.role] || a.joinedAt - b.joinedAt || (a.userId < b.userId ? -1 : 1));
          const heir = heirs[0];
          if (heir === undefined) {
            dropCircle(circleId);
            dissolved.push(circleId);
            continue;
          }
          here.set(heir.userId, { ...heir, role: 'owner' });
          handedOver.push(circleId);
        }
        here.delete(userId);
      }
      const name = username.toLowerCase();
      let removed = 0;
      for (const [id, i] of invitations) {
        if (i.username === name || i.invitedBy === userId) {
          invitations.delete(id);
          removed++;
        }
      }
      return { left: mine.length, handedOver, dissolved, invitationsRemoved: removed };
    },
    purgeExpired: async (now) => {
      let removed = 0;
      for (const [id, i] of invitations) {
        if (!isOpen(i, now)) {
          invitations.delete(id);
          removed++;
        }
      }
      return removed;
    },
  };
}
