import { randomBytes } from 'node:crypto';
import type { Result } from '../graph_store/index.js';
import { err, ok } from '../graph_store/index.js';
import { usersError, type UsersError } from './errors.js';
import { hashToken, isWellFormedToken, TOKEN_BYTES, type RandomBytes } from './tokens.js';

/**
 * Personal access tokens for a person's own agent (R-022). Like a session token, one is given out once, by
 * `create`, and only its SHA-256 is ever stored. Unlike a session it is read-only, is limited to brains it
 * names, always expires, and is accepted in one place only (`/mcp`).
 */
export const AGENT_TOKEN_PREFIX = 'cpat_';
/** At most this many live (unexpired) tokens per person. */
export const MAX_AGENT_TOKENS_PER_USER = 10;
/** The most scopes one token may list. */
export const MAX_AGENT_TOKEN_SCOPES = 20;
export const MAX_AGENT_TOKEN_NAME = 60;
/** A token lives at most this long (365 days), whatever the caller asks. */
export const MAX_AGENT_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60_000;
/** A use renews `lastUsedAt` at most this often, so reading does not write every time. */
export const AGENT_TOKEN_RENEW_MS = 60_000;

const SCOPE_PATTERN = /^(personal|circle:c[a-z0-9]{16})$/;
const ID_PATTERN = /^t[a-z0-9]{16}$/;

export interface AgentTokenInput {
  readonly userId: string;
  /** What the person calls it (1 to 60 characters, no control characters). */
  readonly name: string;
  /** `personal` and `circle:<circle id>`; 1 to 20 distinct ones. */
  readonly scopes: readonly string[];
  /** May the agent also call the tools that spend CaCi's model (R-022 D10)? */
  readonly checks: boolean;
  /** Milliseconds since 1970: later than now, and at most 365 days on. */
  readonly expiresAt: number;
}

/** What a list shows. Never the token. */
export interface AgentTokenInfo {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly checks: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastUsedAt: number | null;
}

/** What a live token stands for when it is presented. */
export interface AgentTokenAccess {
  readonly tokenId: string;
  readonly userId: string;
  readonly scopes: readonly string[];
  readonly checks: boolean;
}

export interface AgentTokenCreated {
  /** Shown once: it is not stored and cannot be recovered. */
  readonly token: string;
  readonly info: AgentTokenInfo;
}

export interface AgentTokenStore {
  /** Makes a token. `CONFLICT` when the person already has the most live tokens; `INVALID_INPUT` (with the field) for a bad name, scopes or expiry. */
  create(input: AgentTokenInput, now: number): Promise<Result<AgentTokenCreated, UsersError>>;
  /** The access for a live token, or `undefined` for a malformed, unknown, revoked or expired one (an expired one is removed). */
  resolve(token: string, now: number): Promise<AgentTokenAccess | undefined>;
  /** A person's live tokens, newest first. */
  list(userId: string, now: number): Promise<readonly AgentTokenInfo[]>;
  /** Ends one of the person's tokens by id. `false` if there is no such live token of theirs. */
  revoke(userId: string, id: string): Promise<boolean>;
  /** Ends every token of a person and says how many. */
  revokeAllFor(userId: string): Promise<number>;
  /** Removes every token that has expired by `now`, and says how many. */
  purgeExpired(now: number): Promise<number>;
}

export interface AgentTokenOptions {
  /** Secure random bytes. Tests replace it. */
  readonly randomBytes?: RandomBytes;
}

/** A token is `cpat_` and 43 base64url characters (256 random bits), in their one canonical spelling. Anything else is turned away before a store is touched. */
export const isWellFormedAgentToken = (value: unknown): value is string => typeof value === 'string' && value.startsWith(AGENT_TOKEN_PREFIX) && isWellFormedToken(value.slice(AGENT_TOKEN_PREFIX.length));

export function newAgentToken(random: RandomBytes = (n) => randomBytes(n)): string {
  const bytes = random(TOKEN_BYTES);
  if (bytes.length !== TOKEN_BYTES) throw new Error('the random source gave the wrong number of bytes');
  return AGENT_TOKEN_PREFIX + Buffer.from(bytes).toString('base64url');
}

/** What a store keeps instead of the token. */
export const hashAgentToken = (token: string): string => hashToken(token);

/** The id of a token record: `t` and 16 random lowercase letters or digits. Not a secret and not a credential. */
export function newAgentTokenId(random: RandomBytes = (n) => randomBytes(n)): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let id = 't';
  while (id.length < 17) for (const byte of random(32)) if (byte < 252 && id.length < 17) id += alphabet[byte % 36];
  return id;
}

export const isAgentTokenId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);

const CONTROL = new RegExp(String.raw`[\p{Cc}` + String.fromCharCode(0x2028, 0x2029, 0xfeff) + ']', 'u');

/** The one check of what a token may be made with; both stores use it, so they cannot disagree. */
export function checkAgentTokenInput(input: AgentTokenInput, now: number): Result<AgentTokenInput, UsersError> {
  const bad = (field: string, message: string): Result<AgentTokenInput, UsersError> => err(usersError('INVALID_INPUT', message, { field }));
  if (typeof input !== 'object' || input === null) return bad('token', 'a token needs a name, scopes and an expiry');
  if (typeof input.userId !== 'string' || input.userId === '' || input.userId.length > 128) return bad('userId', 'a token belongs to a person');
  if (typeof input.name !== 'string') return bad('name', 'the name must be text');
  const name = input.name.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_AGENT_TOKEN_NAME) return bad('name', `the name must be 1 to ${MAX_AGENT_TOKEN_NAME} characters`);
  if (CONTROL.test(name)) return bad('name', 'the name must not contain control characters');
  if (!Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.length > MAX_AGENT_TOKEN_SCOPES) return bad('scopes', `a token needs 1 to ${MAX_AGENT_TOKEN_SCOPES} scopes`);
  const seen = new Set<string>();
  for (const scope of input.scopes as unknown[]) {
    if (typeof scope !== 'string' || !SCOPE_PATTERN.test(scope)) return bad('scopes', 'each scope must be personal or circle:<circle id>');
    if (seen.has(scope)) return bad('scopes', 'a scope is listed twice');
    seen.add(scope);
  }
  if (typeof input.checks !== 'boolean') return bad('checks', 'checks must be true or false');
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) return bad('expiresAt', 'the token must expire in the future');
  if (input.expiresAt - now > MAX_AGENT_TOKEN_LIFETIME_MS) return bad('expiresAt', 'a token may last at most 365 days');
  return ok(Object.freeze({ userId: input.userId, name, scopes: Object.freeze([...input.scopes]), checks: input.checks, expiresAt: input.expiresAt }));
}

export function tooManyAgentTokens(): UsersError {
  return usersError('CONFLICT', `you already have the most agent tokens allowed (${MAX_AGENT_TOKENS_PER_USER}): revoke one first`);
}
