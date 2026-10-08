// Puts the session on the page (R-005). Everything it does to the page is setting text, `hidden`,
// `disabled`, values, a few ARIA attributes and moving the focus: it never builds elements and never
// treats text from the service as anything but text. `document` and `fetchFn` are given, so the whole
// thing runs against a stand-in page in tests.

import { createApiClient } from './api-client.js';
import { createSession } from './session.js';
import { FORMS, formFeedback, viewOf } from './view.js';

const SCREENS = ['loading', 'unreachable', 'signed-out', 'signed-in'];

export function mount(document, fetchFn) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const session = createSession({ api: createApiClient({ fetchFn }) });

  const screens = Object.fromEntries(SCREENS.map((name) => [name, $(`screen-${name}`)]));
  const forms = Object.fromEntries(
    Object.keys(FORMS).map((form) => [
      form,
      {
        element: $(`${form}-form`),
        section: $(`${form}-section`),
        general: $(`${form}-error`),
        submit: $(`${form}-submit`),
        fields: Object.fromEntries(FORMS[form].map((field) => [field, { input: $(`${form}-${field}`), error: $(`${form}-${field}-error`) }])),
      },
    ]),
  );
  const unreachableMessage = $('unreachable-message');
  const retry = $('retry');
  const userName = $('user-display-name');
  const userHandle = $('user-username');
  const signOut = $('signout');
  const signedInNotice = $('signed-in-notice');
  const showRegister = $('show-register');
  const showSignin = $('show-signin');

  function showForm(which) {
    for (const [form, parts] of Object.entries(forms)) parts.section.hidden = form !== which;
  }

  function clearFeedback(form) {
    const parts = forms[form];
    parts.general.textContent = '';
    parts.general.hidden = true;
    for (const { input, error } of Object.values(parts.fields)) {
      error.textContent = '';
      error.hidden = true;
      input.removeAttribute('aria-invalid');
    }
  }

  function render(state) {
    const view = viewOf(state);
    for (const name of SCREENS) screens[name].hidden = name !== view.screen;
    unreachableMessage.textContent = view.screen === 'unreachable' ? view.notice : '';
    userName.textContent = view.userName;
    userHandle.textContent = view.userHandle;
    signedInNotice.textContent = view.screen === 'signed-in' ? view.notice : '';
    signedInNotice.hidden = !(view.screen === 'signed-in' && view.notice !== '');
    for (const control of [...Object.values(forms).map((f) => f.submit), signOut, retry, showRegister, showSignin]) control.disabled = view.busy;
    for (const parts of Object.values(forms)) parts.element.setAttribute('aria-busy', view.busy ? 'true' : 'false');
    if (view.screen === 'signed-in') {
      // the person is in: nothing typed stays on the page
      for (const parts of Object.values(forms)) for (const { input } of Object.values(parts.fields)) input.value = '';
    }
  }

  function show(form, feedback) {
    const parts = forms[form];
    clearFeedback(form);
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

  function values(form) {
    return Object.fromEntries(FORMS[form].map((field) => [field, forms[form].fields[field].input.value]));
  }

  async function submit(form, event) {
    event.preventDefault();
    clearFeedback(form);
    const result = await (form === 'register' ? session.register(values(form)) : session.signIn(values(form)));
    show(form, formFeedback(result, form));
  }

  forms.signin.element.addEventListener('submit', (event) => submit('signin', event));
  forms.register.element.addEventListener('submit', (event) => submit('register', event));
  showRegister.addEventListener('click', () => {
    clearFeedback('signin');
    showForm('register');
    forms.register.fields.username.input.focus();
  });
  showSignin.addEventListener('click', () => {
    clearFeedback('register');
    showForm('signin');
    forms.signin.fields.username.input.focus();
  });
  retry.addEventListener('click', () => void session.start());
  signOut.addEventListener('click', () => void session.signOut());

  session.subscribe(render);
  render(session.getState());
  showForm('signin');
  void session.start();
  return { session };
}
