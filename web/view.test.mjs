import { describe, expect, it } from 'vitest';
import { formFeedback, FORMS, viewOf } from './view.js';

describe('viewOf', () => {
  it('names the screen and gives the signed-in person\'s text', () => {
    expect(viewOf({ screen: 'signed-in', user: { id: 'u1', username: 'ann', displayName: 'Ann A' }, busy: false, notice: null })).toEqual({ screen: 'signed-in', userName: 'Ann A', userHandle: 'ann', notice: '', busy: false });
    expect(viewOf({ screen: 'signed-out', user: null, busy: true, notice: 'hello' })).toEqual({ screen: 'signed-out', userName: '', userHandle: '', notice: 'hello', busy: true });
  });

  it('copes with a notice that is not text and a busy that is not a boolean', () => {
    expect(viewOf({ screen: 'loading', user: null, busy: 'yes', notice: 5 })).toMatchObject({ notice: '', busy: false });
  });

  it('is frozen and passes markup through as the text it is', () => {
    const v = viewOf({ screen: 'signed-in', user: { displayName: '<img src=x onerror=alert(1)>', username: 'x' }, busy: false, notice: null });
    expect(Object.isFrozen(v)).toBe(true);
    expect(v.userName).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('formFeedback', () => {
  it('lists the fields of each form in the order they are on the page', () => {
    expect(FORMS.signin).toEqual(['username', 'password']);
    expect(FORMS.register).toEqual(['username', 'displayName', 'email', 'password']);
  });

  it('success empties the password and shows nothing', () => {
    expect(formFeedback({ ok: true }, 'signin')).toEqual({ fieldErrors: {}, general: null, focus: null, clearPassword: true, switchTo: null });
  });

  it('problems with fields are shown beside the fields and the first one in page order gets the focus', () => {
    const r = formFeedback({ ok: false, kind: 'invalid', errors: { password: 'p', email: 'e', username: 'u' } }, 'register');
    expect(r).toMatchObject({ fieldErrors: { password: 'p', email: 'e', username: 'u' }, general: null, focus: 'username', clearPassword: false, switchTo: null });
    expect(formFeedback({ ok: false, kind: 'invalid', errors: { password: 'p', email: 'e' } }, 'register').focus).toBe('email');
    expect(formFeedback({ ok: false, kind: 'invalid', errors: { password: 'p' } }, 'signin').focus).toBe('password');
  });

  it('errors for fields the form does not have are ignored', () => {
    const r = formFeedback({ ok: false, kind: 'invalid', errors: { displayName: 'x' }, message: 'm' }, 'signin');
    expect(r.fieldErrors).toEqual({});
    expect(r.general).toBe('m');
    expect(r.focus).toBe('general');
  });

  it('fields the form does not have are left out even when the form\'s own fields are wrong too', () => {
    const r = formFeedback({ ok: false, kind: 'invalid', errors: { username: 'u', displayName: 'x', email: 'e' } }, 'signin');
    expect(r.fieldErrors).toEqual({ username: 'u' });
  });

  it('a taken username is beside the username and keeps the password the person typed', () => {
    const r = formFeedback({ ok: false, kind: 'taken', errors: { username: 'taken' }, message: 'taken' }, 'register');
    expect(r).toMatchObject({ fieldErrors: { username: 'taken' }, general: null, focus: 'username', clearPassword: false });
  });

  it('a wrong sign-in is one message at the top, empties the password and moves the focus there', () => {
    expect(formFeedback({ ok: false, kind: 'credentials', message: 'wrong username or password' }, 'signin')).toMatchObject({ fieldErrors: {}, general: 'wrong username or password', focus: 'general', clearPassword: true, switchTo: null });
  });

  it('closed registration says so and shows the sign-in form', () => {
    expect(formFeedback({ ok: false, kind: 'closed', message: 'Registration is closed on this service.' }, 'register')).toMatchObject({ general: 'Registration is closed on this service.', switchTo: 'signin', clearPassword: false });
  });

  it('an account made but not signed in empties the password and shows the sign-in form', () => {
    expect(formFeedback({ ok: false, kind: 'signin-after-register', accountCreated: true, message: 'made, try signing in' }, 'register')).toMatchObject({ general: 'made, try signing in', switchTo: 'signin', clearPassword: true });
  });

  it('a wait, a failure of the service and no connection are one message at the top, keeping what was typed', () => {
    for (const kind of ['throttled', 'server', 'network', 'forbidden']) {
      expect(formFeedback({ ok: false, kind, message: `m-${kind}` }, 'signin'), kind).toMatchObject({ general: `m-${kind}`, focus: 'general', clearPassword: false, switchTo: null });
    }
  });

  it('a result with no message still says something', () => {
    expect(formFeedback({ ok: false, kind: 'server' }, 'signin').general).toBe('Something went wrong. Try again.');
    expect(formFeedback({ ok: false, kind: 'server', message: '' }, 'signin').general).toBe('Something went wrong. Try again.');
  });

  it('busy changes nothing', () => {
    expect(formFeedback({ ok: false, kind: 'busy', message: 'wait' }, 'signin')).toEqual({ fieldErrors: {}, general: null, focus: null, clearPassword: false, switchTo: null });
  });

  it('copes with anything', () => {
    for (const bad of [undefined, null, 5, 'x']) expect(formFeedback(bad, 'signin').general).toBeNull();
    expect(formFeedback({ ok: true }, 'nonsense').clearPassword).toBe(false);
  });

  it('answers are frozen', () => {
    expect(Object.isFrozen(formFeedback({ ok: false, kind: 'credentials', message: 'm' }, 'signin'))).toBe(true);
    expect(Object.isFrozen(formFeedback({ ok: false, kind: 'invalid', errors: { username: 'u' } }, 'signin').fieldErrors)).toBe(true);
  });
});
