// The user controller's building blocks (R-002): accounts, passwords, sessions, throttling and the
// controller itself arrive task by task. It uses the graph store only through its public entry
// point, and the shared SQLite wrapper.

export { USERS_ERROR_CODES, usersError } from './errors.js';
export type { UsersError, UsersErrorCode } from './errors.js';
export { ROLES } from './types.js';
export type { Role, User } from './types.js';
export { isUserId, newUserId, USER_ID_PATTERN, userGraphId } from './ids.js';
export { COMMON_PASSWORDS, DISPLAY_NAME_MAX, EMAIL_MAX, parseDisplayName, parseEmail, parsePassword, parseUsername, PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN } from './validate.js';
export { createPasswordHasher, DEFAULT_SCRYPT } from './password.js';
export type { Derive, PasswordHasher, PasswordHasherOptions, ScryptParams } from './password.js';
export { createMemoryUserStore } from './memory-store.js';
export type { Credential, CreateOptions, GuardOptions, UserList, UserPage, UserPatch, UserRecord, UserStore } from './store.js';
export { createMemorySessionStore } from './memory-session-store.js';
export { DEFAULT_SESSION_OPTIONS, resolveSessionOptions } from './session-store.js';
export type { ResolvedSessionOptions, SessionOptions, SessionStore } from './session-store.js';
export { hashToken, isWellFormedToken, newSessionToken } from './tokens.js';
export type { RandomBytes } from './tokens.js';
export { createLoginThrottle, createRegistrationThrottle, DEFAULT_CLIENT_RULE, DEFAULT_USERNAME_RULE, throttledError } from './throttle.js';
export type { LockRule, LoginThrottle, LoginThrottleOptions, RegistrationThrottle, RegistrationThrottleOptions, Verdict } from './throttle.js';
export { createUserController } from './controller.js';
export type { Authenticated, LoggedIn, LoginInput, RegisterInput, RequestContext, UserController, UserControllerConfig, UserControllerInit } from './controller.js';
