// Agent access (R-022): a person's own agent reads their brains through a personal access token. The agent surface is the
// same CaCi controller the app uses, over a token-based user lookup and a resolver limited to the token's scopes, and read only.

export { createAgentView } from './view.js';
export type { AgentReadApi, AgentView, AgentViewInit } from './view.js';
export { createAgentTools, MAX_TOOL_RESULT_CHARS } from './tools.js';
export type { AgentToolInfo, AgentToolOutcome, AgentToolResult, AgentTools } from './tools.js';
