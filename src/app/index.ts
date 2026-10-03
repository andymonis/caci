// The application layer: the controller that connects input, the LLM component and the graph
// store. It reaches both only through their public entry points.

export { APP_ERROR_CODES, appError } from './errors.js';
export type { AppError, AppErrorCode } from './errors.js';
export { createItemIdGenerator } from './ids.js';
export type { ItemIdGenerator, ItemIdOptions } from './ids.js';
export { INPUT_KINDS, parseInput } from './input.js';
export type { AudioInput, ImageInput, Input, InputKind, TextInput } from './input.js';
export { normaliseInput, normaliseText } from './normalise.js';
export type { InputNormaliser, Normalisers } from './normalise.js';
export { describeSummary, summarise } from './summary.js';
export type { ExistingNodes, Link, ProposalSummary } from './summary.js';
export { createController, DEFAULT_CONTROLLER_OPTIONS } from './controller.js';
export type { Approved, Controller, ControllerError, ControllerInit, ProposeOptions } from './controller.js';
export type { PendingProposal } from './pending.js';
