import { circlesError, type CirclesError } from '../errors.js';
import { pageOf } from '../cursor.js';
import { err, ok, type Result } from '../result.js';
import type { AcceptLimits, CirclePage, CircleStore, Invitation, InvitationRecord, InviteLimits, Listing, Membership, RemoveUserOutcome } from '../store.js';
import type { Circle, CircleRole } from '../types.js';

/**
 * A small, plain circle store with one defect that can be switched on, so the conformance suite can
 * be shown to catch each one. With no defect it is correct (and must pass the suite).
 */
export const DEFECTS = [
  'no-last-owner-on-role',
  'no-last-owner-on-remove',
  'racy-remove',
  'racy-role',
  'racy-accept',
  'accept-keeps-invitation',
  'accept-ignores-username',
  'accept-ignores-expiry',
  'accept-ignores-member-cap',
  'accept-ignores-circle-cap',
  'accept-overwrites-role',
  'create-ignores-circle-cap',
  'invitation-username-case',
  'repeat-new-id',
  'repeat-uses-a-place',
  'expired-use-a-place',
  'unsorted-listing',
  'cursor-at-exact-fill',
  'delete-keeps-members',
  'delete-keeps-invitations',
  'remove-user-no-handover',
  'remove-user-wrong-heir',
  'remove-user-keeps-invitations',
  'shared-state',
  'no-copies',
  'lists-expired',
  'revoke-ignores-circle',
  'decline-any-name',
  'update-forgets-description',
  'accept-wrong-error',
  'bad-cursor-accepted',
  'purge-miscounts',
  'invitation-id-conflict-ignored',
] as const;
export type Defect = (typeof DEFECTS)[number];

const RANK: Readonly<Record<CircleRole, number>> = { owner: 0, manager: 1, member: 2, observer: 3 };
const SHARED = { circles: new Map<string, Circle>(), members: new Map<string, Map<string, Membership>>(), invitations: new Map<string, Invitation>() };
const nf = (what: string): CirclesError => circlesError('NOT_FOUND', `no such ${what}`);

export function createNaiveCircleStore(defect?: Defect): CircleStore {
  const d = (name: Defect): boolean => defect === name;
  const circles = d('shared-state') ? SHARED.circles : new Map<string, Circle>();
  const members = d('shared-state') ? SHARED.members : new Map<string, Map<string, Membership>>();
  const invitations = d('shared-state') ? SHARED.invitations : new Map<string, Invitation>();
  const out = <T extends object>(v: T): T => (d('no-copies') ? v : { ...v });
  const open = (i: Invitation, now: number): boolean => d('lists-expired') || now < i.expiresAt;
  const owners = (id: string): number => [...(members.get(id)?.values() ?? [])].filter((m) => m.role === 'owner').length;
  const circlesOf = (u: string): string[] => [...members.entries()].filter(([, m]) => m.has(u)).map(([id]) => id).sort();
  const drop = (id: string): void => {
    circles.delete(id);
    if (!d('delete-keeps-members')) members.delete(id);
    if (!d('delete-keeps-invitations')) for (const [k, i] of invitations) if (i.circleId === id) invitations.delete(k);
  };
  const page = <T>(rows: readonly T[], key: (r: T) => string, p: CirclePage): Listing<T> => {
    const sorted = d('unsorted-listing') ? [...rows].reverse() : rows;
    if (d('bad-cursor-accepted') && p.cursor !== null && p.cursor !== undefined && !p.cursor.startsWith('k')) return { items: [], nextCursor: null };
    const result = pageOf(sorted, key, p);
    if (d('cursor-at-exact-fill') && result.items.length === p.limit && result.nextCursor === null) return { items: result.items, nextCursor: pageOf(sorted, key, { limit: Math.max(1, p.limit - 1), cursor: null }).nextCursor ?? result.nextCursor };
    return result;
  };
  const lc = (u: string): string => (d('invitation-username-case') ? u : u.toLowerCase());

  return {
    createCircle: async (record, ownerId, limits): Promise<Result<Circle, CirclesError>> => {
      if (circles.has(record.id)) return err(circlesError('CONFLICT', 'exists'));
      if (!d('create-ignores-circle-cap') && circlesOf(ownerId).length >= limits.maxCirclesPerUser) return err(circlesError('LIMIT_REACHED', 'too many circles'));
      const circle: Circle = { id: record.id, name: record.name, ...(record.description === undefined ? {} : { description: record.description }), createdAt: record.createdAt, updatedAt: record.createdAt };
      circles.set(circle.id, circle);
      members.set(circle.id, new Map([[ownerId, { circleId: circle.id, userId: ownerId, role: 'owner', joinedAt: record.createdAt }]]));
      return ok(out(circle));
    },
    getCircle: async (id) => {
      const c = circles.get(id);
      return c === undefined ? undefined : out(c);
    },
    updateCircle: async (id, patch): Promise<Result<Circle, CirclesError>> => {
      const c = circles.get(id);
      if (c === undefined) return err(nf('circle'));
      const description = patch.description === undefined ? (d('update-forgets-description') ? undefined : c.description) : patch.description === null ? undefined : patch.description;
      const next: Circle = { id: c.id, name: patch.name ?? c.name, ...(description === undefined ? {} : { description }), createdAt: c.createdAt, updatedAt: patch.updatedAt };
      circles.set(id, next);
      return ok(out(next));
    },
    deleteCircle: async (id) => {
      if (!circles.has(id)) return false;
      drop(id);
      return true;
    },
    membershipOf: async (c, u) => {
      const m = members.get(c)?.get(u);
      return m === undefined ? undefined : out(m);
    },
    listCirclesOf: async (u, p) => page(circlesOf(u).map((id) => ({ circle: out(circles.get(id) as Circle), role: (members.get(id)?.get(u) as Membership).role, joinedAt: (members.get(id)?.get(u) as Membership).joinedAt, memberCount: members.get(id)?.size ?? 0 })), (r) => r.circle.id, p),
    listMembers: async (c, p) => page([...(members.get(c)?.values() ?? [])].sort((a, b) => (a.userId < b.userId ? -1 : 1)).map(out), (r) => r.userId, p),

    changeRole: async (c, u, role): Promise<Result<Membership, CirclesError>> => {
      const m = members.get(c)?.get(u);
      if (m === undefined) return err(nf('member'));
      const guard = !d('no-last-owner-on-role') && m.role === 'owner' && role !== 'owner';
      const only = owners(c) === 1;
      if (d('racy-role')) await Promise.resolve();
      if (guard && (d('racy-role') ? only : owners(c) === 1)) return err(circlesError('LAST_OWNER', 'owner'));
      const next = { ...m, role };
      members.get(c)?.set(u, next);
      return ok(out(next));
    },
    removeMember: async (c, u): Promise<Result<boolean, CirclesError>> => {
      const m = members.get(c)?.get(u);
      if (m === undefined) return ok(false);
      const only = owners(c) === 1;
      if (d('racy-remove')) await Promise.resolve();
      if (!d('no-last-owner-on-remove') && m.role === 'owner' && (d('racy-remove') ? only : owners(c) === 1)) return err(circlesError('LAST_OWNER', 'owner'));
      members.get(c)?.delete(u);
      return ok(true);
    },

    createInvitation: async (record: InvitationRecord, limits: InviteLimits, now: number): Promise<Result<Invitation, CirclesError>> => {
      if (!circles.has(record.circleId)) return err(nf('circle'));
      const name = lc(record.username);
      const same = [...invitations.values()].find((i) => i.circleId === record.circleId && i.username === name);
      const counted = [...invitations.values()].filter((i) => i.circleId === record.circleId && (d('expired-use-a-place') || now < i.expiresAt)).length;
      if (same !== undefined && !d('repeat-new-id')) {
        if (d('repeat-uses-a-place') && counted >= limits.maxOpenInvitationsPerCircle) return err(circlesError('LIMIT_REACHED', 'full'));
        const next = { ...same, role: record.role, invitedBy: record.invitedBy, expiresAt: record.expiresAt };
        invitations.set(same.id, next);
        return ok(out(next));
      }
      if (same === undefined && counted >= limits.maxOpenInvitationsPerCircle) return err(circlesError('LIMIT_REACHED', 'full'));
      if (invitations.has(record.id) && !d('invitation-id-conflict-ignored')) return err(circlesError('CONFLICT', 'exists'));
      const inv = { ...record, username: name };
      invitations.set(inv.id, inv);
      return ok(out(inv));
    },
    getInvitation: async (id) => {
      const i = invitations.get(id);
      return i === undefined ? undefined : out(i);
    },
    listInvitationsOfCircle: async (c, now, p) => page([...invitations.values()].filter((i) => i.circleId === c && open(i, now)).sort((a, b) => (a.id < b.id ? -1 : 1)).map(out), (r) => r.id, p),
    listInvitationsFor: async (u, now, p) => page([...invitations.values()].filter((i) => i.username === lc(u) && open(i, now)).sort((a, b) => (a.id < b.id ? -1 : 1)).map(out), (r) => r.id, p),
    revokeInvitation: async (id, c, now) => {
      const i = invitations.get(id);
      if (i === undefined || (!d('revoke-ignores-circle') && i.circleId !== c)) return false;
      invitations.delete(id);
      return now < i.expiresAt;
    },
    declineInvitation: async (id, username, now) => {
      const i = invitations.get(id);
      if (i === undefined || (!d('decline-any-name') && i.username !== username.toLowerCase())) return false;
      invitations.delete(id);
      return now < i.expiresAt;
    },
    acceptInvitation: async (id: string, userId: string, username: string, now: number, limits: AcceptLimits): Promise<Result<Membership, CirclesError>> => {
      const i = invitations.get(id);
      if (i === undefined || (!d('accept-ignores-username') && i.username !== username.toLowerCase())) return err(d('accept-wrong-error') ? circlesError('FORBIDDEN', 'not yours') : nf('invitation'));
      if ((!d('accept-ignores-expiry') && now >= i.expiresAt) || !circles.has(i.circleId)) {
        invitations.delete(id);
        return err(nf('invitation'));
      }
      const here = members.get(i.circleId) as Map<string, Membership>;
      const existing = here.get(userId);
      if (existing !== undefined) {
        invitations.delete(id);
        if (d('accept-overwrites-role')) {
          const next = { ...existing, role: i.role };
          here.set(userId, next);
          return ok(out(next));
        }
        return ok(out(existing));
      }
      const full = here.size >= limits.maxMembersPerCircle;
      const crowded = circlesOf(userId).length >= limits.maxCirclesPerUser;
      if (d('racy-accept')) await Promise.resolve();
      if (full && !d('accept-ignores-member-cap')) return err(circlesError('LIMIT_REACHED', 'full'));
      if (crowded && !d('accept-ignores-circle-cap')) return err(circlesError('LIMIT_REACHED', 'busy'));
      const m: Membership = { circleId: i.circleId, userId, role: i.role, joinedAt: now };
      here.set(userId, m);
      if (!d('accept-keeps-invitation')) invitations.delete(id);
      return ok(out(m));
    },

    removeUser: async (userId, username): Promise<RemoveUserOutcome> => {
      const handedOver: string[] = [];
      const dissolved: string[] = [];
      const mine = circlesOf(userId);
      for (const c of mine) {
        const here = members.get(c) as Map<string, Membership>;
        if ((here.get(userId) as Membership).role === 'owner' && owners(c) === 1 && !d('remove-user-no-handover')) {
          const heirs = [...here.values()].filter((m) => m.userId !== userId).sort((a, b) => (d('remove-user-wrong-heir') ? RANK[b.role] - RANK[a.role] : RANK[a.role] - RANK[b.role]) || a.joinedAt - b.joinedAt || (a.userId < b.userId ? -1 : 1));
          const heir = heirs[0];
          if (heir === undefined) {
            drop(c);
            dissolved.push(c);
            continue;
          }
          here.set(heir.userId, { ...heir, role: 'owner' });
          handedOver.push(c);
        }
        here.delete(userId);
      }
      let removed = 0;
      if (!d('remove-user-keeps-invitations')) {
        for (const [k, i] of invitations) {
          if (i.username === username.toLowerCase() || i.invitedBy === userId) {
            invitations.delete(k);
            removed++;
          }
        }
      }
      return { left: mine.length, handedOver, dissolved, invitationsRemoved: removed };
    },
    purgeExpired: async (now) => {
      let n = 0;
      for (const [k, i] of invitations) {
        if (now >= i.expiresAt) {
          invitations.delete(k);
          n++;
        }
      }
      return d('purge-miscounts') ? n + 1 : n;
    },
  };
}
