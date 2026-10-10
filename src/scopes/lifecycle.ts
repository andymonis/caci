import { circlesError, type CircleController } from '../circles/index.js';
import { createGraph, dropGraph, type StorageAdapter } from '../graph_store/index.js';
import type { UserController } from '../users/index.js';
import { circleGraphId } from './scope.js';

// Keeping a circle and its graph together when one is made or deleted (R-009 SC-FR-01). The circle record
// lives in `users.db` and the graph in `graphs.db`, so there is no single transaction: the order is chosen so
// that the dangerous state (a graph that holds data with no circle to answer for it) is never entered and the
// harmless one (a circle record with no graph, or a graph with no record that nobody can reach) is repaired by
// the reconcile. Failures are one fixed message; nothing a store said is repeated.

const FAILED = 'the circle service could not complete the request';
const GRAPH_LEFT = 'the circle was deleted, but its notes could not be removed yet; they will be removed at the next clean-up';

/**
 * A circle controller that also gives each new circle its graph and drops the graph of a deleted circle; every
 * other method is the given controller's own.
 *
 * - **Create**: the circle record first (so a graph never exists without its record), then the graph. If the graph
 *   cannot be made the record is deleted again, so a success never leaves only one of the two; if even that fails
 *   the reconcile will make the missing graph, and the answer is the fixed failure either way.
 * - **Delete**: the record first (the controller checks the caller is an owner), then the graph, tried twice. The
 *   circle is gone for everyone the moment the record is, so a graph that is left is unreachable and the reconcile
 *   removes it; the answer then says so, in fixed words.
 */
export function withCircleGraphs(circles: CircleController, graphAdapter: StorageAdapter): CircleController {
  if (circles === undefined || typeof circles.create !== 'function' || typeof circles.delete !== 'function' || graphAdapter === undefined) {
    throw new TypeError('withCircleGraphs needs a circle controller and a graph adapter');
  }
  const makeGraph = async (id: string): Promise<boolean> => {
    try {
      const r = await createGraph(graphAdapter, circleGraphId(id));
      return r.ok || r.error.code === 'CONFLICT';
    } catch {
      return false;
    }
  };
  const dropOnce = async (id: string): Promise<boolean> => {
    try {
      const r = await dropGraph(graphAdapter, circleGraphId(id));
      return r.ok || r.error.code === 'GRAPH_NOT_FOUND';
    } catch {
      return false;
    }
  };
  return Object.freeze({
    ...circles,
    create: async (token: unknown, input: unknown) => {
      const made = await circles.create(token, input);
      if (!made.ok) return made;
      if (await makeGraph(made.value.id)) return made;
      try {
        await circles.delete(token, made.value.id); // undo; if this fails too, the reconcile makes the graph
      } catch {
        // the fixed failure below is the answer either way
      }
      return { ok: false as const, error: circlesError('STORAGE_ERROR', FAILED) };
    },
    delete: async (token: unknown, circleId: unknown) => {
      const gone = await circles.delete(token, circleId);
      if (!gone.ok) return gone;
      if ((await dropOnce(circleId as string)) || (await dropOnce(circleId as string))) return gone;
      return { ok: false as const, error: circlesError('STORAGE_ERROR', GRAPH_LEFT) };
    },
  });
}

/**
 * A user controller that runs `after` once an account has been deleted (by its owner or by an admin). Deleting
 * an account can dissolve a circle the person alone belonged to, in the database, which leaves that circle's
 * graph behind; `after` is where the reconcile is run. A failure of `after` never changes the answer.
 */
export function afterAccountDeletion(users: UserController, after: () => Promise<unknown>): UserController {
  if (users === undefined || typeof users.deleteMe !== 'function' || typeof users.deleteUser !== 'function' || typeof after !== 'function') {
    throw new TypeError('afterAccountDeletion needs a user controller and a function');
  }
  const run = async (): Promise<void> => {
    try {
      await after();
    } catch {
      // the next run repairs it
    }
  };
  return Object.freeze({
    ...users,
    deleteMe: async (...args: Parameters<UserController['deleteMe']>) => {
      const r = await users.deleteMe(...args);
      if (r.ok) await run();
      return r;
    },
    deleteUser: async (...args: Parameters<UserController['deleteUser']>) => {
      const r = await users.deleteUser(...args);
      if (r.ok) await run();
      return r;
    },
  });
}
