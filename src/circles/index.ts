// The circle controller's building blocks (R-004): roles, ids, input checks and the permission
// table arrive first; the stores and the controller follow task by task. The component uses the
// users component only through its public entry point and has no way to read a graph.

export { CIRCLES_ERROR_CODES, circlesError } from './errors.js';
export type { CirclesError, CirclesErrorCode } from './errors.js';
export { CIRCLE_DESCRIPTION_MAX, CIRCLE_NAME_MAX, CIRCLE_ROLES, isCircleRole } from './types.js';
export type { Circle, CircleRole } from './types.js';
export { CIRCLE_ID_PATTERN, INVITATION_ID_PATTERN, isCircleId, isInvitationId, newCircleId, newInvitationId } from './ids.js';
export { parseCircleDescription, parseCircleName, parseCreateCircle, parseInvite, parseRole, parseRoleChange, parseUpdateCircle } from './validate.js';
export type { CreateCircleInput, InviteInput, UpdateCircleInput } from './validate.js';
export { authorise, CIRCLE_ACTIONS } from './authorise.js';
export type { AuthoriseContext, CircleAction } from './authorise.js';
