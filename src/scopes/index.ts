// Scopes (R-009): whose brain a request is about (the caller's own or one circle's), who may read or capture
// there, and keeping circle records and circle graphs in step. It joins the user controller (the session), the
// circle store (current role) and the graph store; `src/circles/` still cannot read a graph and the graph store
// learns nothing about circles or users.

export { circleGraphId, circleIdOfGraph, parseScope, PERSONAL } from './scope.js';
export type { Provenance, Scope } from './scope.js';
export { SCOPES_ERROR_CODES, scopesError } from './errors.js';
export type { ScopesError, ScopesErrorCode, ScopesResult } from './errors.js';
export { authoriseBrain } from './policy.js';
export type { BrainAction } from './policy.js';
export { createScopeResolver } from './resolver.js';
export type { ResolvedScope, ScopeResolver, ScopeResolverInit } from './resolver.js';
