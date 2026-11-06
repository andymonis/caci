import { describe, expect, it } from 'vitest';
import { AGENT_TOKEN_PREFIX, hashAgentToken, isAgentTokenId, isWellFormedAgentToken, newAgentToken, newAgentTokenId } from './agent-tokens.js';
import { createMemoryAgentTokenStore } from './memory-agent-token-store.js';
import { runAgentTokenStoreConformance } from './testing/index.js';
import { hashToken } from './tokens.js';

runAgentTokenStoreConformance(() => createMemoryAgentTokenStore(), { describe, it });

describe('agent tokens', () => {
  it('are cpat_ and 256 random bits as 43 characters, from the random source given', () => {
    expect(newAgentToken(() => new Uint8Array(32).fill(255))).toBe(AGENT_TOKEN_PREFIX + '_'.repeat(42) + '8');
    expect(newAgentToken(() => new Uint8Array(32))).toBe(AGENT_TOKEN_PREFIX + 'A'.repeat(43));
    expect(() => newAgentToken(() => new Uint8Array(16))).toThrow();
  });

  it('are well formed only with the prefix and a canonical 43 characters', () => {
    const token = newAgentToken();
    expect(isWellFormedAgentToken(token)).toBe(true);
    for (const bad of [token.slice(5), token.slice(0, -1), token + 'A', 'CPAT_' + token.slice(5), 'cpat-' + token.slice(5), token.slice(0, -1) + '+', 5, null, undefined]) expect(isWellFormedAgentToken(bad)).toBe(false);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    expect(isWellFormedAgentToken(token.slice(0, -1) + (alphabet[alphabet.indexOf(token.at(-1) as string) ^ 1] as string))).toBe(false);
  });

  it('hash like any other token, so the stored form is the SHA-256 of the whole text', () => {
    const token = newAgentToken();
    expect(hashAgentToken(token)).toBe(hashToken(token));
    expect(hashAgentToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAgentToken(token)).not.toContain(token);
  });

  it('record ids are t and 16 lowercase letters or digits, unbiased (bytes of 252 and above skipped)', () => {
    const id = newAgentTokenId(() => new Uint8Array(32).fill(35));
    expect(id).toBe('t' + 'z'.repeat(16));
    expect(isAgentTokenId(id)).toBe(true);
    let calls = 0;
    const skipping = newAgentTokenId((n) => new Uint8Array(n).fill(calls++ === 0 ? 255 : 0));
    expect(skipping).toBe('t' + '0'.repeat(16));
    for (const bad of ['', 't', 'T0000000000000000', 'u0000000000000000', 't000000000000000', 't00000000000000000', 5]) expect(isAgentTokenId(bad)).toBe(false);
  });

  it('the memory store uses the random source it is given', async () => {
    const store = createMemoryAgentTokenStore({ randomBytes: (n) => new Uint8Array(n).fill(7) });
    const r = await store.create({ userId: 'u1', name: 'x', scopes: ['personal'], checks: false, expiresAt: 1000 }, 0);
    expect(r.ok && r.value.token).toBe(AGENT_TOKEN_PREFIX + Buffer.alloc(32, 7).toString('base64url'));
  });
});
