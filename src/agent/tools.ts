import type { CaciError } from '../caci/index.js';
import type { Result } from '../graph_store/index.js';
import type { Provenance, Scope } from '../scopes/index.js';
import type { AgentView } from './view.js';

/**
 * What an agent can ask of the brains (R-022 D9), written once and independent of any transport. Every tool reads, except the three verb tools
 * (R-025 D13), which only a token made with the resolve flag is offered: they write the person's own resolution record (and delete a fact in the
 * person's own brain for `clear`), never a circle's notes.
 */
export interface AgentToolInfo {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** A JSON Schema for the arguments. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** What a tool call gives back: structured data and the same as text, or a plain statement of what was wrong. Never a stack, an id or a path. */
export interface AgentToolResult {
  readonly isError: boolean;
  readonly data: unknown;
  readonly text: string;
}

export type AgentToolOutcome = { readonly kind: 'unauthenticated' } | { readonly kind: 'unknown-tool' } | { readonly kind: 'result'; readonly result: AgentToolResult };

export interface AgentTools {
  /** The tools this token may call, or `undefined` when it is not a live token. */
  list(bearer: unknown): Promise<readonly AgentToolInfo[] | undefined>;
  call(bearer: unknown, name: unknown, args: unknown): Promise<AgentToolOutcome>;
}

/** A result is never larger than this many characters of JSON. A bigger one is refused with advice to ask for less. */
export const MAX_TOOL_RESULT_CHARS = 100_000;

const SCOPE_TEXT = /^circle:(c[a-z0-9]{16})$/;
const scopeSchema = { type: 'string', description: "Which brain: 'personal' for the person's own notes, or 'circle:<id>' for a circle they are in (see list_brains)." } as const;
const limitSchema = (max: number, dflt: number) => ({ type: 'integer', minimum: 1, maximum: max, description: `How many to return, at most ${max}. Default ${dflt}.` }) as const;

const TOOLS: readonly AgentToolInfo[] = Object.freeze([
  { name: 'list_brains', title: 'List brains', description: "The brains this access covers: the person's own notes and the circles they share, each with the person's role. Start here to learn the values for 'scope'.", inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'search_facts', title: 'Search facts', description: 'Find the facts in one brain that share words with some text, most relevant first, each with when and (in a circle) who entered it.', inputSchema: { type: 'object', properties: { scope: scopeSchema, text: { type: 'string', maxLength: 500, description: 'The words to look for.' }, limit: limitSchema(50, 20) }, required: ['scope', 'text'], additionalProperties: false } },
  { name: 'get_fact', title: 'Get a fact', description: 'One fact by id: what it says, the categories it is filed under, and where it came from (who entered it, when, and the words as typed where still kept). Also works for a fact that was replaced later.', inputSchema: { type: 'object', properties: { scope: scopeSchema, id: { type: 'string', maxLength: 256, description: 'The fact id from another tool.' } }, required: ['scope', 'id'], additionalProperties: false } },
  { name: 'browse', title: 'Browse a brain', description: "Without 'category', the brain's categories with how many facts each holds; with it, the facts in that category. Paged: pass next_cursor back to continue.", inputSchema: { type: 'object', properties: { scope: scopeSchema, category: { type: 'string', maxLength: 256, description: 'A category id from an earlier browse.' }, limit: limitSchema(100, 50), cursor: { type: 'string', maxLength: 1000, description: 'next_cursor from the previous answer.' } }, required: ['scope'], additionalProperties: false } },
  { name: 'changes', title: 'Changes since a time', description: 'What changed in one brain after a time, newest first: facts added, replaced or removed, and the words typed. A pull: nothing is sent to you. The change log is kept for a limited time.', inputSchema: { type: 'object', properties: { scope: scopeSchema, since: { type: 'string', maxLength: 40, description: 'An ISO 8601 date or date and time, for example 2026-11-01T09:00:00Z. Only strictly newer changes come back.' }, limit: limitSchema(100, 50), cursor: { type: 'string', maxLength: 1000, description: 'next_cursor from the previous answer.' } }, required: ['scope', 'since'], additionalProperties: false } },
]);
const PULSE: AgentToolInfo = Object.freeze({ name: 'pulse', title: 'Attention check', description: "Ask CaCi's own model for a short, focused check: what needs attention this week ('pulse'), this month ('coming-up') or this year ('long-range'). Silent when nothing does. This spends CaCi's model and counts against the person's hourly allowance.", inputSchema: { type: 'object', properties: { check: { type: 'string', enum: ['pulse', 'coming-up', 'long-range'] }, scope: { type: 'string', description: "Optional: 'personal' or 'circle:<id>'. Left out, every brain this access covers is read." }, time_zone: { type: 'string', maxLength: 64, description: "The person's IANA time zone, for example Europe/London. Default UTC." } }, required: ['check'], additionalProperties: false } });

const RESOLVE_TOOLS: readonly AgentToolInfo[] = Object.freeze([
  { name: 'resolve_fact', title: 'Mark a fact as dealt with', description: "Apply a verb to one fact for the person, by its exact id (from pulse, get_fact or search_facts): 'clear' means they have dealt with it, 'pay' means they say they paid it outside CaCi (CaCi pays nothing). In a circle this hides the fact from this person's own checks only; others still see it and nothing in the circle changes. In the person's own notes 'clear' deletes the fact. An agent cannot use 'remove'.", inputSchema: { type: 'object', properties: { scope: scopeSchema, id: { type: 'string', maxLength: 256, description: 'The fact id.' }, verb: { type: 'string', maxLength: 20, description: "'clear' (they have dealt with it) or 'pay' (they say they paid it). 'remove' is not available to an agent." } }, required: ['scope', 'id', 'verb'], additionalProperties: false } },
  { name: 'unresolve_fact', title: 'Take back a resolution', description: "Take back the person's own resolution of a fact, so it appears in their checks again. Harmless when there was none.", inputSchema: { type: 'object', properties: { scope: scopeSchema, id: { type: 'string', maxLength: 256, description: 'The fact id.' } }, required: ['scope', 'id'], additionalProperties: false } },
  { name: 'resolutions', title: 'List resolutions', description: "The facts the person has dealt with, with the verb and when: ids only, never the facts' words. A 'pay' here is the person's own statement that they paid. Paged: pass next back as after_scope and after_id.", inputSchema: { type: 'object', properties: { limit: limitSchema(100, 50), after_scope: scopeSchema, after_id: { type: 'string', maxLength: 256, description: 'With after_scope: continue after this fact (the next of the previous answer).' } }, additionalProperties: false } },
]);

const keyOf = (p: Provenance | undefined): string => (p === undefined || p.kind === 'personal' ? 'personal' : `circle:${p.circleId}`);
const brainOf = (p: Provenance | undefined) => ({ scope: keyOf(p), name: p === undefined || p.kind === 'personal' ? 'Your own notes' : p.circleName });
const iso = (ms: unknown): string | undefined => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};
const person = (by: { username: string; displayName: string } | undefined) => (by === undefined ? undefined : { username: by.username, display_name: by.displayName });
const compact = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
/** The facts' data, without the stamps that name a person by their internal id: who entered a fact is given as a name instead. */
const cleanData = (data: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'contributedBy' && k !== 'contributedAt'));

const FIXED_FAILURE = 'the service could not complete the request';
function failure(error: CaciError): string {
  if (error.source === 'caci') {
    const own = error.error;
    return own.code === 'UNAUTHENTICATED' ? 'not signed in' : own.message;
  }
  return FIXED_FAILURE; // a store or a model failing: nothing of it is repeated
}

type Args = Record<string, unknown>;
class ArgProblem extends Error {}
function argsOf(raw: unknown, allowed: readonly string[]): Args {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ArgProblem('the arguments must be an object');
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new ArgProblem(`${key.slice(0, 40)} is not an argument of this tool`);
  return raw as Args;
}
function scopeArg(value: unknown, required: boolean): Scope | undefined {
  if (value === undefined) {
    if (required) throw new ArgProblem("scope is required: use list_brains to see the choices ('personal' or 'circle:<id>')");
    return undefined;
  }
  if (value === 'personal') return { kind: 'personal' };
  const m = typeof value === 'string' ? SCOPE_TEXT.exec(value) : null;
  if (m === null) throw new ArgProblem("scope must be 'personal' or 'circle:<id>'");
  return { kind: 'circle', circleId: m[1] as string };
}
function textArg(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ArgProblem(`${name} must be some text`);
  if ([...value].length > max) throw new ArgProblem(`${name} must be at most ${max} characters`);
  return value;
}
function limitArg(value: unknown, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new ArgProblem(`limit must be a whole number from 1 to ${max}`);
  return value;
}
function cursorArg(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > 1000) throw new ArgProblem('cursor must be the next_cursor of the previous answer');
  return value;
}

/** The tools over an agent view. `pulse` is offered only to a token made with the checks flag, the three verb tools only to one made with the resolve flag. */
export function createAgentTools(view: AgentView): AgentTools {
  const done = (data: unknown, isError = false): AgentToolResult => {
    const text = JSON.stringify(data);
    if (text.length > MAX_TOOL_RESULT_CHARS) return { isError: true, data: { error: 'the result is too large: ask for fewer, for example with a smaller limit' }, text: JSON.stringify({ error: 'the result is too large: ask for fewer, for example with a smaller limit' }) };
    return { isError, data, text };
  };
  const fail = (message: string): AgentToolResult => done({ error: message }, true);
  const unwrap = <T>(r: Result<T, CaciError>): { ok: true; value: T } | { ok: false; result: AgentToolResult } => (r.ok ? { ok: true, value: r.value } : { ok: false, result: fail(failure(r.error)) });

  const run: Record<string, (bearer: string, raw: unknown) => Promise<AgentToolResult>> = {
    async list_brains(bearer, raw) {
      argsOf(raw, []);
      const r = unwrap(await view.read.brainScopes(bearer));
      if (!r.ok) return r.result;
      return done({ brains: r.value.items.map((b) => compact({ ...brainOf(b.scope), role: b.role })) });
    },

    async search_facts(bearer, raw) {
      const a = argsOf(raw, ['scope', 'text', 'limit']);
      const scope = scopeArg(a.scope, true);
      const limit = limitArg(a.limit, 50);
      const r = unwrap(await view.read.searchFacts(bearer, { text: textArg(a.text, 'text', 500), scope, ...(limit === undefined ? {} : { limit }) }));
      if (!r.ok) return r.result;
      return done({ brain: brainOf(r.value.scope), facts: r.value.items.map((h) => compact({ id: h.id, title: h.title, summary: h.summary, key: h.key, entered_at: iso(h.at), entered_by: person(h.by) })) });
    },

    async get_fact(bearer, raw) {
      const a = argsOf(raw, ['scope', 'id']);
      const scope = scopeArg(a.scope, true);
      const id = textArg(a.id, 'id', 256);
      const item = await view.read.item(bearer, id, scope);
      const source = await view.read.source(bearer, { scope, id });
      if (!item.ok && !source.ok) return fail(failure(item.error));
      const sourceData = source.ok
        ? compact({ entered_by: person(source.value.enteredBy), entered_at: iso(source.value.at), words: source.value.words, words_kept: source.value.recorded, replaced_later: source.value.replacedLater, note: source.value.note })
        : undefined;
      if (item.ok) {
        const d = item.value;
        return done({ brain: brainOf(d.scope), fact: compact({ id: d.item.id, data: cleanData(d.item.data), data_truncated: d.item.dataTruncated, filed_under: d.categories.map((c) => compact({ id: c.id, name: c.name, weight: c.weight })), more_categories: d.moreCategories }), current: true, source: sourceData });
      }
      if (!source.ok) return fail(failure(item.error));
      return done({ brain: brainOf(source.value.scope), fact: compact({ id, title: source.value.fact.title, summary: source.value.fact.summary }), current: false, source: sourceData });
    },

    async browse(bearer, raw) {
      const a = argsOf(raw, ['scope', 'category', 'limit', 'cursor']);
      const scope = scopeArg(a.scope, true);
      const limit = limitArg(a.limit, 100);
      const cursor = cursorArg(a.cursor);
      const page = { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) };
      if (a.category === undefined) {
        const r = unwrap(await view.read.categories(bearer, page, scope));
        if (!r.ok) return r.result;
        return done({ brain: brainOf(r.value.scope), categories: r.value.items.map((c) => compact({ id: c.id, name: c.name, fact_count: c.itemCount, count_is_lower_bound: c.itemCountCapped })), next_cursor: r.value.nextCursor });
      }
      const r = unwrap(await view.read.categoryItems(bearer, textArg(a.category, 'category', 256), page, scope));
      if (!r.ok) return r.result;
      return done({ brain: brainOf(r.value.scope), category: compact({ id: r.value.category.id, name: r.value.category.name }), facts: r.value.items.map((f) => compact({ id: f.id, data: cleanData(f.data), data_truncated: f.dataTruncated })), next_cursor: r.value.nextCursor });
    },

    async changes(bearer, raw) {
      const a = argsOf(raw, ['scope', 'since', 'limit', 'cursor']);
      const scope = scopeArg(a.scope, true);
      const since = textArg(a.since, 'since', 40);
      const limit = limitArg(a.limit, 100);
      const cursor = cursorArg(a.cursor);
      const r = unwrap(await view.read.changes(bearer, { scope, since, ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) }));
      if (!r.ok) return r.result;
      return done({ brain: brainOf(r.value.scope), since: iso(r.value.since), changes: r.value.items.map((e) => compact({ at: iso(e.at), action: e.action, kind: e.kind === 'input' ? 'words typed' : e.kind === 'item' ? 'fact' : 'category', id: e.subject, title: e.title, summary: e.summary, words: e.text, by: person(e.by) })), next_cursor: r.value.nextCursor });
    },

    async resolve_fact(bearer, raw) {
      const a = argsOf(raw, ['scope', 'id', 'verb']);
      const scope = scopeArg(a.scope, true);
      const r = unwrap(await view.resolve.resolveFact(bearer, { scope, id: textArg(a.id, 'id', 256), verb: textArg(a.verb, 'verb', 20) }));
      if (!r.ok) return r.result;
      return done({ scope: r.value.fact.scope.kind === 'personal' ? 'personal' : `circle:${r.value.fact.scope.circleId}`, id: r.value.fact.id, verb: r.value.verb, result: r.value.result === 'deleted' ? 'the fact was deleted from the notes' : 'hidden from the person\'s own checks' });
    },

    async unresolve_fact(bearer, raw) {
      const a = argsOf(raw, ['scope', 'id']);
      const scope = scopeArg(a.scope, true);
      const r = unwrap(await view.resolve.unresolveFact(bearer, { scope, id: textArg(a.id, 'id', 256) }));
      if (!r.ok) return r.result;
      return done({ id: r.value.fact.id, resolved: false });
    },

    async resolutions(bearer, raw) {
      const a = argsOf(raw, ['limit', 'after_scope', 'after_id']);
      const limit = limitArg(a.limit, 100);
      if ((a.after_scope === undefined) !== (a.after_id === undefined)) throw new ArgProblem('give after_scope and after_id together');
      const after = a.after_scope === undefined ? undefined : { scope: scopeArg(a.after_scope, true), id: textArg(a.after_id, 'after_id', 256) };
      const r = unwrap(await view.resolve.resolutions(bearer, { ...(limit === undefined ? {} : { limit }), ...(after === undefined ? {} : { after }) }));
      if (!r.ok) return r.result;
      const keyFor = (f: { scope: { kind: 'personal' } | { kind: 'circle'; circleId: string } }): string => (f.scope.kind === 'personal' ? 'personal' : `circle:${f.scope.circleId}`);
      return done({ resolutions: r.value.items.map((i) => compact({ scope: keyFor(i.fact), id: i.fact.id, verb: i.verb, at: iso(i.at) })), next: r.value.next === null ? undefined : { after_scope: keyFor(r.value.next), after_id: r.value.next.id } });
    },

    async pulse(bearer, raw) {
      const a = argsOf(raw, ['check', 'scope', 'time_zone']);
      if (a.check !== 'pulse' && a.check !== 'coming-up' && a.check !== 'long-range') throw new ArgProblem("check must be 'pulse', 'coming-up' or 'long-range'");
      const scope = scopeArg(a.scope, false);
      if (a.time_zone !== undefined && (typeof a.time_zone !== 'string' || a.time_zone.length > 64)) throw new ArgProblem('time_zone must be an IANA time zone name');
      const r = unwrap(await view.read.status(bearer, { check: a.check, ...(scope === undefined ? {} : { scope }), ...(a.time_zone === undefined ? {} : { timeZone: a.time_zone }) }));
      if (!r.ok) return r.result;
      const v = r.value;
      return done({ headline: v.headline, nothing: v.nothing, points: v.points.map((p) => ({ text: p.text, from: p.sources.map(brainOf), facts: p.facts.map((f) => ({ brain: brainOf(f.scope), id: f.id })) })), generated_at: iso(v.generatedAt), notes_read: v.entriesUsed, notes_left_out: v.entriesLeftOut, notes_resolved: v.entriesResolved });
    },
  };

  const tools: AgentTools = {
    async list(bearer: unknown): Promise<readonly AgentToolInfo[] | undefined> {
      const access = await view.access(bearer);
      if (access === undefined) return undefined;
      return Object.freeze([...TOOLS, ...(access.checks ? [PULSE] : []), ...(access.resolve ? RESOLVE_TOOLS : [])]);
    },
    async call(bearer: unknown, name: unknown, args: unknown): Promise<AgentToolOutcome> {
      const access = await view.access(bearer);
      if (access === undefined) return { kind: 'unauthenticated' };
      if (typeof name !== 'string' || !Object.hasOwn(run, name) || (name === 'pulse' && !access.checks) || (RESOLVE_TOOLS.some((t) => t.name === name) && !access.resolve)) return { kind: 'unknown-tool' };
      try {
        return { kind: 'result', result: await (run[name] as (b: string, r: unknown) => Promise<AgentToolResult>)(bearer as string, args) };
      } catch (cause) {
        if (cause instanceof ArgProblem) return { kind: 'result', result: fail(cause.message) };
        return { kind: 'result', result: fail(FIXED_FAILURE) }; // never the text of whatever failed
      }
    },
  };
  return Object.freeze(tools);
}
