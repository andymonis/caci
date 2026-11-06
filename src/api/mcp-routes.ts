import type { AgentTools } from '../agent/index.js';
import type { JsonValue } from '../graph_store/index.js';
import { createRegistrationThrottle } from '../users/index.js';
import type { ApiResponse, Route } from './router.js';

export interface McpRoutesOptions {
  /** What an agent may call. The same tools whatever the transport. */
  readonly tools: AgentTools;
  /** Milliseconds since 1970, for the throttle. Default the system clock. */
  readonly clock?: () => number;
  /** How many requests with a bad token one client may make an hour before it is turned away. Default 30. */
  readonly badTokensPerHour?: number;
}

/** The protocol versions this server speaks, newest first. A client asking for another is told the newest. */
export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_INFO = Object.freeze({ name: 'caci', title: 'CaCi brain', version: '1.0.0' });
const MAX_ID_CHARS = 128;

const rpcError = (id: JsonValue, code: number, message: string): ApiResponse => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });
const unauthorised = (): ApiResponse => ({ status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'not signed in' } } });

/**
 * The MCP server (R-022 D12): one `POST /mcp` carrying JSON-RPC 2.0, answered in JSON (no streaming, no server messages; `GET` is a
 * 405). It is the only route that reads a Bearer token (`bearer: true`), and every request needs a live one: a missing, malformed,
 * unknown, revoked or expired token is the same plain 401, and misses are counted per client so guessing is slow. It speaks only
 * `initialize`, `ping`, notifications, `tools/list` and `tools/call`, and every protocol error is a fixed sentence.
 */
export function createMcpRoutes(options: McpRoutesOptions): readonly Route[] {
  const { tools } = options;
  const clock = options.clock ?? Date.now;
  const misses = createRegistrationThrottle({ max: options.badTokensPerHour ?? 30 });

  const handle = async (bearer: string | undefined, clientKey: string, body: Readonly<Record<string, JsonValue>> | undefined): Promise<ApiResponse> => {
    const now = clock();
    const verdict = misses.check(clientKey, now);
    if (!verdict.allowed) return { status: 429, body: { error: { code: 'THROTTLED', message: 'too many requests with a bad token: wait and try again' } }, retryAfterSeconds: verdict.retryAfterMs / 1000 };
    const infos = bearer === undefined ? undefined : await tools.list(bearer);
    if (infos === undefined) {
      misses.record(clientKey, now);
      return unauthorised();
    }
    if (body === undefined || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } } };
    const hasId = Object.hasOwn(body, 'id');
    const id = body.id as JsonValue;
    if (hasId && ((typeof id !== 'string' && typeof id !== 'number') || (typeof id === 'string' && (id === '' || id.length > MAX_ID_CHARS)))) return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } } };
    if (!hasId) return { status: 202 }; // a notification: nothing to say back
    const params = body.params;
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) return rpcError(id, -32602, 'invalid params');
    const p = (params ?? {}) as Record<string, JsonValue>;

    switch (body.method) {
      case 'initialize': {
        const asked = p.protocolVersion;
        const version = typeof asked === 'string' && MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : (MCP_PROTOCOL_VERSIONS[0] as string);
        return { status: 200, body: { jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO } } };
      }
      case 'ping':
        return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
      case 'tools/list':
        return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: infos.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema as JsonValue, annotations: { readOnlyHint: true, openWorldHint: false } })) } } };
      case 'tools/call': {
        if (typeof p.name !== 'string' || p.name.length > 64) return rpcError(id, -32602, 'invalid params');
        if (p.arguments !== undefined && (typeof p.arguments !== 'object' || p.arguments === null || Array.isArray(p.arguments))) return rpcError(id, -32602, 'invalid params');
        const outcome = await tools.call(bearer, p.name, p.arguments);
        if (outcome.kind === 'unauthenticated') {
          misses.record(clientKey, now);
          return unauthorised();
        }
        if (outcome.kind === 'unknown-tool') return rpcError(id, -32602, 'unknown tool');
        const r = outcome.result;
        return { status: 200, body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], ...(r.isError ? {} : { structuredContent: r.data as JsonValue }), isError: r.isError } } };
      }
      default:
        return rpcError(id, -32601, 'method not found');
    }
  };

  return [
    {
      method: 'POST',
      path: '/mcp',
      bearer: true,
      handler: async (ctx) => {
        try {
          return await handle(ctx.bearer, ctx.clientKey, ctx.body);
        } catch {
          return { status: 500, body: { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } } };
        }
      },
    },
  ];
}
