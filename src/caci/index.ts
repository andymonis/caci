// The CaCi controller (R-003): the layer a front end calls. It binds capture and browsing to the signed-in
// person: the graph always comes from the session, a proposal belongs to the account that made it, and one
// account cannot use up the shared capacity or the model bill. It uses the user controller, the capture
// controller, the LLM component and the graph store only through their public entry points.

export { CACI_ERROR_CODES, caciError } from './errors.js';
export type { CaciError, CaciErrorCode, CaciOwnError } from './errors.js';
export { createCaciController, MAX_NOTE_CHARS, viewOf } from './controller.js';
export type { CaciControllerInit, CaciController, CaciLimits, ProposalView } from './controller.js';
