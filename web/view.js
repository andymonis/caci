// What the page shows, worked out from the session state and from the result of a form (R-005).
// Pure functions: no page access, so they can be tested exactly. `mount.js` only applies the answers.

export const FORMS = Object.freeze({
  signin: Object.freeze(['username', 'password']),
  register: Object.freeze(['username', 'displayName', 'email', 'password']),
});

/** Which screen, and the text for the signed-in screen, from a session snapshot. */
export function viewOf(state) {
  const user = state.user;
  return Object.freeze({
    screen: state.screen,
    userName: user ? user.displayName : '',
    userHandle: user ? user.username : '',
    notice: typeof state.notice === 'string' ? state.notice : '',
    busy: state.busy === true,
  });
}

const NONE = Object.freeze({ fieldErrors: Object.freeze({}), general: null, focus: null, clearPassword: false, switchTo: null });

/**
 * What a form shows after it was sent (or refused before sending):
 * - `fieldErrors`: a message next to each field the problem is about;
 * - `general`: one message at the top of the form, for everything else;
 * - `focus`: the field (or `'general'`) to move the keyboard to, the first problem first;
 * - `clearPassword`: whether to empty the password field now;
 * - `switchTo`: the form to show instead, if the person should go there.
 */
export function formFeedback(result, form) {
  const order = FORMS[form];
  if (!order || !result || typeof result !== 'object') return NONE;
  if (result.ok) return Object.freeze({ ...NONE, clearPassword: true });
  if (result.kind === 'busy') return NONE;
  const errors = result.errors && typeof result.errors === 'object' ? Object.fromEntries(Object.entries(result.errors).filter(([field]) => order.includes(field))) : {};
  const firstField = order.find((field) => errors[field] !== undefined);
  if (firstField !== undefined) {
    // problems with fields: shown beside the fields, nothing at the top, the first one gets the focus
    return Object.freeze({ ...NONE, fieldErrors: Object.freeze(errors), focus: firstField });
  }
  const message = typeof result.message === 'string' && result.message !== '' ? result.message : 'Something went wrong. Try again.';
  const base = { ...NONE, general: message, focus: 'general' };
  if (result.kind === 'credentials') return Object.freeze({ ...base, clearPassword: true });
  if (result.kind === 'closed') return Object.freeze({ ...base, switchTo: 'signin' });
  if (result.kind === 'signin-after-register') return Object.freeze({ ...base, clearPassword: true, switchTo: 'signin' });
  return Object.freeze(base);
}
