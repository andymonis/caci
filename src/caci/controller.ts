import type { Controller, PendingProposal, ProposalSummary } from '../app/index.js';
import { err, ok, type JsonValue, type Result } from '../graph_store/index.js';
import { createRegistrationThrottle as createWindowLimiter, type Authenticated, type UserController } from '../users/index.js';
import { caciError, type CaciError } from './errors.js';

/** The longest note accepted: the categoriser's own limit, so a refusal here is clear and costs no model call. */
export const MAX_NOTE_CHARS = 8000;
const HOUR_MS = 60 * 60_000;

export interface CaciLimits {
  /** Proposals one account may have waiting at once. Default 10. */
  readonly maxPendingPerUser?: number;
  /** New proposals one account may start in an hour (each costs a model call). Default 30. */
  readonly proposalsPerHour?: number;
}

export interface CaciControllerInit {
  /** Only `resolve` is used: a session token becomes a user and their graph. */
  readonly users: Pick<UserController, 'resolve'>;
  /** The capture controller (`src/app/`), unchanged: it reads context, asks the model, holds the preview, and writes on approval. */
  readonly capture: Controller;
  /** Which model answers, for the person to see: `demo` or `anthropic`. Default `demo`. */
  readonly mode?: 'demo' | 'anthropic';
  /** The clock in milliseconds. Use the capture controller's clock too, so expiry agrees. */
  readonly clock?: () => number;
  readonly limits?: CaciLimits;
}

/** A proposal as a person is allowed to see it: the preview and what they would be approving, and nothing about the plumbing. */
export interface ProposalView {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly mode: 'demo' | 'anthropic';
  /** The preview in plain words. */
  readonly text: string;
  readonly summary: ProposalSummary;
  /** The operations that approving would write. */
  readonly operations: readonly JsonValue[];
  /** The model's short reason, when it gave one. */
  readonly rationale?: string;
}

export interface CaciController {
  /**
   * Asks the model how to file a note, for the person the session belongs to, in **their** graph (taken
   * from the session: there is no way to name another). Holds the answer as a pending proposal owned by
   * them. Writes nothing.
   */
  propose(token: unknown, input: { readonly text: unknown }): Promise<Result<ProposalView, CaciError>>;
}

interface Held {
  readonly userId: string;
  /** `Infinity` while the model is still being asked: the place is reserved before the call, not after it. */
  expiresAt: number;
}

const whole = (value: number | undefined, fallback: number, name: string): number => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError(`createCaciController: ${name} must be a positive whole number`);
  return n;
};

/** How a pending proposal is shown: no prompt, no raw model output, no usage, no model name, no graph id. */
export function viewOf(proposal: PendingProposal, mode: 'demo' | 'anthropic'): ProposalView {
  return Object.freeze({
    id: proposal.id,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    mode,
    text: proposal.text,
    summary: proposal.summary,
    operations: proposal.mutation.ops as unknown as readonly JsonValue[],
    ...(proposal.rationale === undefined ? {} : { rationale: proposal.rationale }),
  });
}

export function createCaciController(init: CaciControllerInit): CaciController {
  const { users, capture } = init;
  if (users === undefined || capture === undefined) throw new TypeError('createCaciController needs users and capture');
  const mode = init.mode ?? 'demo';
  if (mode !== 'demo' && mode !== 'anthropic') throw new TypeError('createCaciController: mode must be demo or anthropic');
  const clock = init.clock ?? Date.now;
  const maxPending = whole(init.limits?.maxPendingPerUser, 10, 'maxPendingPerUser');
  const perHour = whole(init.limits?.proposalsPerHour, 30, 'proposalsPerHour');
  const hourly = createWindowLimiter({ max: perHour, windowMs: HOUR_MS });
  /** Every proposal (and every place reserved for one) with its owner. */
  const held = new Map<string, Held>();
  let reservations = 0;

  const sweep = (now: number): void => {
    for (const [id, h] of [...held]) if (h.expiresAt <= now) held.delete(id);
  };
  const pendingOf = (userId: string): Held[] => [...held.values()].filter((h) => h.userId === userId);

  async function whoIs(token: unknown): Promise<Result<Authenticated, CaciError>> {
    const me = await users.resolve(token);
    return me.ok ? ok(me.value) : err(caciError('UNAUTHENTICATED', 'not signed in'));
  }

  return {
    async propose(token, input) {
      const me = await whoIs(token);
      if (!me.ok) return me;
      const userId = me.value.user.id;

      for (const key of Object.keys(input ?? {})) {
        if (key !== 'text') return err(caciError('INVALID_INPUT', `${key} is not accepted here`, { field: key }));
      }
      const text = input?.text;
      if (typeof text !== 'string') return err(caciError('INVALID_INPUT', 'text must be text', { field: 'text' }));
      if (text.trim() === '') return err(caciError('INVALID_INPUT', 'text must not be empty', { field: 'text' }));
      if (text.length > MAX_NOTE_CHARS) return err(caciError('INVALID_INPUT', `text is over the limit of ${MAX_NOTE_CHARS} characters`, { field: 'text' }));

      const now = clock();
      sweep(now);
      const mine = pendingOf(userId);
      if (mine.length >= maxPending) {
        const soonest = Math.min(...mine.map((h) => h.expiresAt));
        return err(caciError('TOO_MANY_PENDING', `you already have ${maxPending} proposals waiting: approve or reject one first`, Number.isFinite(soonest) ? { retryAfterMs: Math.max(1, soonest - now) } : {}));
      }
      const wait = hourly.check(userId, now);
      if (!wait.allowed) return err(caciError('THROTTLED', `you have made the most proposals allowed in an hour (${perHour})`, { retryAfterMs: wait.retryAfterMs }));

      // from here the model will be asked: count it, and keep a place before the first await so that simultaneous requests cannot slip past the limit
      hourly.record(userId, now);
      const reservation = `reservation-${++reservations}`; // proposal ids start with prop-, so the two kinds of key never meet
      held.set(reservation, { userId, expiresAt: Number.POSITIVE_INFINITY });
      try {
        const made = await capture.propose(me.value.graphId, { kind: 'text', text });
        held.delete(reservation);
        if (!made.ok) return made;
        held.set(made.value.id, { userId, expiresAt: made.value.expiresAt });
        return ok(viewOf(made.value, mode));
      } catch (cause) {
        held.delete(reservation);
        throw cause;
      }
    },
  };
}
