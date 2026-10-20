// Puts the everyday app (R-016) on its page: sign in or create an account, then Home (the chat) and Settings. Like the back office
// it only sets text, `hidden`, `disabled`, values, a few ARIA attributes and the focus: it never builds elements and never treats
// anything the service sent as anything but text. `document` and `fetchFn` are given, so it runs against a stand-in page in tests.

import { createApiClient } from './api-client.js';
import { createSettingsSession } from './settings-session.js';
import { createSession } from './session.js';
import { isCircleId } from './circles-client.js';
import { FORMS, formFeedback } from './view.js';

const SCREENS = ['loading', 'unreachable', 'signed-out', 'signed-in'];
const NO_ENV = Object.freeze({ getHash: () => '', setHash: () => {}, onHashChange: () => {} });
const TITLES = Object.freeze({ home: 'CaCi', settings: 'Settings – CaCi' });
const SETTINGS_FORMS = Object.freeze({ profile: Object.freeze(['displayName', 'email']), password: Object.freeze(['currentPassword', 'newPassword']) });

/** The circle an address names (`#/circle/<id>`, the id in its exact shape), else `undefined`. Never decoded. */
export const circleIdOf = (hash) => {
  if (typeof hash !== 'string' || !hash.startsWith('#/circle/')) return undefined;
  const id = hash.slice('#/circle/'.length);
  return isCircleId(id) ? id : undefined;
};
/** The address names Settings or a circle only exactly; anything else is Home. Never decoded. */
export const routeOf = (hash) => (hash === '#/settings' ? 'settings' : circleIdOf(hash) !== undefined ? 'circle' : 'home');

export function mountUser(document, fetchFn, env = NO_ENV, hooksOrFactory = {}) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const api = createApiClient({ fetchFn });
  const session = createSession({ api });
  const settings = createSettingsSession({
    api,
    onSignedOut: recheck,
    onUser: (user) => {
      userName.textContent = user.displayName;
    },
  });

  let hooks = {};
  let rechecked = false;
  /** A request says the session ended: ask the service once who is signed in, so a service that contradicts itself cannot make a loop. */
  function recheck() {
    if (rechecked) return;
    rechecked = true;
    void session.start();
  }

  const screens = Object.fromEntries(SCREENS.map((name) => [name, $(`screen-${name}`)]));
  const forms = Object.fromEntries(
    Object.keys(FORMS).map((form) => [
      form,
      { element: $(`${form}-form`), section: $(`${form}-section`), general: $(`${form}-error`), submit: $(`${form}-submit`), fields: Object.fromEntries(FORMS[form].map((field) => [field, { input: $(`${form}-${field}`), error: $(`${form}-${field}-error`) }])) },
    ]),
  );
  const settingsForms = Object.fromEntries(
    Object.entries(SETTINGS_FORMS).map(([form, list]) => [
      form,
      { element: $(`${form}-form`), general: $(`${form}-error`), notice: $(`${form}-notice`), submit: $(`${form}-submit`), fields: Object.fromEntries(list.map((field) => [field, { input: $(`${form}-${field}`), error: $(`${form}-${field}-error`) }])) },
    ]),
  );
  const unreachableMessage = $('unreachable-message');
  const retry = $('retry');
  const userName = $('user-display-name');
  const signOut = $('signout');
  const removeEmail = $('remove-email');
  const signedInNotice = $('signed-in-notice');
  const showRegister = $('show-register');
  const showSignin = $('show-signin');
  const views = { home: $('view-home'), circle: $('view-circle'), settings: $('view-settings') };
  const navLinks = { home: $('nav-home'), settings: $('nav-settings') };
  const headings = { home: $('home-heading'), settings: $('settings-heading') };

  let shown = null; // the screen of the signed-in frame being shown

  function showForm(which) {
    for (const [form, parts] of Object.entries(forms)) parts.section.hidden = form !== which;
  }
  function clearFeedback(parts) {
    parts.general.textContent = '';
    parts.general.hidden = true;
    for (const { input, error } of Object.values(parts.fields)) {
      error.textContent = '';
      error.hidden = true;
      input.removeAttribute('aria-invalid');
    }
  }

  function render(state) {
    for (const name of SCREENS) screens[name].hidden = name !== state.screen;
    unreachableMessage.textContent = state.screen === 'unreachable' && typeof state.notice === 'string' ? state.notice : '';
    userName.textContent = state.user ? state.user.displayName : '';
    const notice = state.screen === 'signed-in' && typeof state.notice === 'string' ? state.notice : '';
    signedInNotice.textContent = notice;
    signedInNotice.hidden = notice === '';
    const busy = state.busy === true;
    for (const control of [...Object.values(forms).map((f) => f.submit), signOut, retry, showRegister, showSignin]) control.disabled = busy;
    for (const parts of Object.values(forms)) parts.element.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (state.screen === 'signed-in') for (const parts of Object.values(forms)) for (const { input } of Object.values(parts.fields)) input.value = '';
    if (state.screen === 'signed-out') rechecked = false;
    renderRoute(state.screen === 'signed-in', state);
  }

  function renderRoute(signedIn, state) {
    if (!signedIn) {
      if (shown !== null) {
        settings.reset();
        hooks.reset?.();
        for (const parts of Object.values(settingsForms)) for (const { input } of Object.values(parts.fields)) input.value = '';
      }
      shown = null;
      document.title = 'CaCi';
      return;
    }
    const route = routeOf(env.getHash());
    const param = circleIdOf(env.getHash());
    for (const name of Object.keys(views)) views[name].hidden = name !== route;
    for (const name of Object.keys(navLinks)) {
      if (name === route) navLinks[name].setAttribute('aria-current', 'page');
      else navLinks[name].removeAttribute('aria-current');
    }
    const key = `${route}:${param ?? ''}`;
    if (shown === key) return;
    shown = key;
    if (route === 'settings') {
      for (const parts of Object.values(settingsForms)) {
        clearFeedback(parts);
        parts.notice.hidden = true;
        parts.notice.textContent = '';
      }
      settingsForms.profile.fields.displayName.input.value = state.user ? state.user.displayName : '';
      settings.reset();
    } else {
      for (const parts of Object.values(settingsForms)) for (const { input } of Object.values(parts.fields)) input.value = '';
    }
    hooks.route?.(route, param);
    if (route === 'circle') return; // the circle screen sets its own title and takes the focus once it knows the circle's name
    document.title = TITLES[route];
    headings[route].focus();
  }

  function show(form, feedback) {
    const parts = forms[form];
    clearFeedback(parts);
    for (const [field, message] of Object.entries(feedback.fieldErrors)) {
      const target = parts.fields[field];
      if (!target) continue;
      target.error.textContent = message;
      target.error.hidden = false;
      target.input.setAttribute('aria-invalid', 'true');
    }
    if (feedback.general !== null) {
      parts.general.textContent = feedback.general;
      parts.general.hidden = false;
    }
    if (feedback.clearPassword) parts.fields.password.input.value = '';
    if (feedback.switchTo !== null) showForm(feedback.switchTo);
    if (feedback.focus === 'general') parts.general.focus();
    else if (feedback.focus !== null) parts.fields[feedback.focus]?.input.focus();
  }
  const values = (form) => Object.fromEntries(FORMS[form].map((field) => [field, forms[form].fields[field].input.value]));

  async function submit(form, event) {
    event.preventDefault();
    clearFeedback(forms[form]);
    const result = await (form === 'register' ? session.register(values(form)) : session.signIn(values(form)));
    show(form, formFeedback(result, form));
  }

  // Settings: a message beside the field it is about, the first one gets the focus; anything else at the top of the form.
  function showSettings(form, result, clearOnSuccess) {
    const parts = settingsForms[form];
    clearFeedback(parts);
    parts.notice.hidden = true;
    parts.notice.textContent = '';
    if (result.kind === 'busy' || result.kind === 'signed-out') return;
    if (result.ok) {
      for (const name of clearOnSuccess) parts.fields[name].input.value = '';
      parts.notice.textContent = settings.getState().notice;
      parts.notice.hidden = false;
      parts.notice.focus();
      return;
    }
    const errors = result.errors && typeof result.errors === 'object' ? result.errors : {};
    const order = SETTINGS_FORMS[form];
    const first = order.find((field) => typeof errors[field] === 'string');
    if (first !== undefined) {
      for (const field of order) {
        if (typeof errors[field] !== 'string') continue;
        parts.fields[field].error.textContent = errors[field];
        parts.fields[field].error.hidden = false;
        parts.fields[field].input.setAttribute('aria-invalid', 'true');
      }
      parts.fields[first].input.focus();
      return;
    }
    const wait = Number.isSafeInteger(result.retryAfterSeconds) && result.retryAfterSeconds > 0 ? ` Try again in ${result.retryAfterSeconds} ${result.retryAfterSeconds === 1 ? 'second' : 'seconds'}.` : '';
    parts.general.textContent = `${typeof result.message === 'string' && result.message !== '' ? result.message : 'Something went wrong. Try again.'}${wait}`;
    parts.general.hidden = false;
    parts.general.focus();
  }

  forms.signin.element.addEventListener('submit', (event) => submit('signin', event));
  forms.register.element.addEventListener('submit', (event) => submit('register', event));
  showRegister.addEventListener('click', () => {
    clearFeedback(forms.signin);
    showForm('register');
    forms.register.fields.username.input.focus();
  });
  showSignin.addEventListener('click', () => {
    clearFeedback(forms.register);
    showForm('signin');
    forms.signin.fields.username.input.focus();
  });
  retry.addEventListener('click', () => void session.start());
  signOut.addEventListener('click', () => void session.signOut());

  settingsForms.profile.element.addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = settingsForms.profile.fields;
    const current = session.getState().user;
    const name = f.displayName.input.value;
    // the name is prefilled; sending it unchanged is not a change
    const result = await settings.saveProfile({ displayName: current && name.trim() === current.displayName ? '' : name, email: f.email.input.value });
    showSettings('profile', result, ['email']);
  });
  removeEmail.addEventListener('click', async () => {
    showSettings('profile', await settings.removeEmail(), []);
  });
  settingsForms.password.element.addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = settingsForms.password.fields;
    const result = await settings.changePassword({ currentPassword: f.currentPassword.input.value, newPassword: f.newPassword.input.value });
    showSettings('password', result, ['currentPassword', 'newPassword']);
  });
  settings.subscribe((s) => {
    for (const control of [settingsForms.profile.submit, settingsForms.password.submit, removeEmail]) control.disabled = s.busy;
    for (const parts of Object.values(settingsForms)) parts.element.setAttribute('aria-busy', s.busy ? 'true' : 'false');
  });

  // the hooks may be given ready, or built from what only this module can offer (the one-time re-check of a ended session)
  hooks = typeof hooksOrFactory === 'function' ? hooksOrFactory({ recheck, go: (hash) => env.setHash(hash) }) : hooksOrFactory;
  session.subscribe(render);
  env.onHashChange(() => renderRoute(session.getState().screen === 'signed-in', session.getState()));
  render(session.getState());
  showForm('signin');
  void session.start();
  return { session, settings };
}
