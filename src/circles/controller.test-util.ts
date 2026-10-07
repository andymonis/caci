import { ok, err, type Result } from './result.js';
import { circlesError } from './errors.js';
import { createCircleController, type CircleController, type CircleControllerInit } from './controller.js';
import { createMemoryCircleStore } from './memory-store.js';
import type { CircleStore } from './store.js';

export const T0 = 1_700_000_000_000;

/** The people the fixtures know: token `tok-<name>` signs in as `name`. */
export interface Person {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
}

export interface World {
  controller: CircleController;
  store: CircleStore;
  now: { value: number };
  /** Token for a person. */
  token(name: string): string;
  /** A person's user id. */
  id(name: string): string;
  /** Removes a person's account (their session stops working and the directory forgets them). */
  forget(name: string): void;
  /** Every token the controller was asked to resolve (for "was the session even looked at"). */
  resolved: unknown[];
  /** Every user id the controller looked up in the directory. */
  lookups: string[];
}

const NAMES = ['ann', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus', 'hal', 'ivy', 'jon'];

export function world(extra: { store?: CircleStore; limits?: CircleControllerInit['limits']; newCircleId?: () => string; newInvitationId?: () => string; people?: readonly string[] } = {}): World {
  const store = extra.store ?? createMemoryCircleStore();
  const now = { value: T0 };
  const people = new Map<string, Person>();
  for (const [index, name] of (extra.people ?? NAMES).entries()) people.set(name, { id: `u${String(index + 1).padStart(16, '0')}`, username: name, displayName: `Display ${name}`.toUpperCase() });
  const resolved: unknown[] = [];
  const lookups: string[] = [];
  const controller = createCircleController({
    users: {
      resolve: async (token: unknown): Promise<Result<never, never>> => {
        resolved.push(token);
        const name = typeof token === 'string' && token.startsWith('tok-') ? token.slice(4) : undefined;
        const person = name === undefined ? undefined : people.get(name);
        if (person === undefined) return err(circlesError('UNAUTHENTICATED', 'not signed in') as never);
        // the real user controller's answer has a `user` and a `graphId`; the circle controller must use only the user's id
        return ok({ user: { ...person, email: `${person.username}@example.com`, role: 'user', createdAt: 1, updatedAt: 1 }, graphId: `user-${person.id}` } as never);
      },
    },
    directory: {
      get: async (id: string) => {
        lookups.push(id);
        const person = [...people.values()].find((p) => p.id === id);
        return person === undefined ? undefined : ({ ...person, email: `${person.username}@example.com`, role: 'user', createdAt: 1, updatedAt: 1 } as never);
      },
    },
    store,
    ...(extra.limits === undefined ? {} : { limits: extra.limits }),
    clock: () => now.value,
    ...(extra.newCircleId === undefined ? {} : { newCircleId: extra.newCircleId }),
    ...(extra.newInvitationId === undefined ? {} : { newInvitationId: extra.newInvitationId }),
  });
  return {
    controller,
    store,
    now,
    token: (name) => `tok-${name}`,
    id: (name) => (people.get(name) as Person).id,
    forget: (name) => void people.delete(name),
    resolved,
    lookups,
  };
}

export const must = async <T>(promise: Promise<{ ok: boolean; value?: T; error?: unknown }>): Promise<T> => {
  const r = await promise;
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
export const code = async (promise: Promise<{ ok: boolean; error?: { code: string } }>): Promise<string | undefined> => {
  const r = await promise;
  return r.ok ? undefined : r.error?.code;
};

let invitationCounter = 0;
/** Puts a person into a circle with a role, through the store (the invitation routes are a later piece). */
export async function addMember(w: World, circleId: string, name: string, role: 'owner' | 'manager' | 'member' | 'observer', at = T0 + 1): Promise<void> {
  const id = `i${String(++invitationCounter).padStart(16, '0')}`;
  const limits = { maxCirclesPerUser: 1000, maxMembersPerCircle: 1000, maxOpenInvitationsPerCircle: 1000 };
  const made = await w.store.createInvitation({ id, circleId, username: name, role, invitedBy: w.id(name), createdAt: at, expiresAt: at + 1_000_000 }, limits, at);
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  const joined = await w.store.acceptInvitation(id, w.id(name), name, at, limits);
  if (!joined.ok) throw new Error(JSON.stringify(joined.error));
}
