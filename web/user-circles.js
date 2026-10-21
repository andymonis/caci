// The circles of the everyday app (R-016 D17): one link per circle the person belongs to at the top of the navigation, and
// one Circle screen for each (`#/circle/<id>`). The list comes from `GET /api/brain/scopes` and is read again whenever a screen is
// shown, so a circle joined or left appears or disappears; there is no polling. Like the other pages it only sets text, `hidden`,
// `disabled`, values, a few ARIA attributes and the focus, and builds rows from `<template>` elements. Returns the hooks
// `user-mount.js` calls: `route(name, param)` and `reset()`.

import { mountCircleChat } from './circle-chat-page.js';

export function mountUserCircles(document, notes, { go, recheck }, ledger) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const navCircles = $('nav-circles');
  const navTemplate = $('nav-circle-template');
  const notice = $('circle-notice');
  const view = $('view-circle');
  const heading = $('circle-heading');
  const chat = mountCircleChat(document, notes, recheck, ledger);

  let epoch = 0; // each screen change takes a number; only the latest one is allowed to draw
  let circles = []; // [{ circleId, circleName, role, canCapture }] as the service last said
  let current; // the circle shown
  let keepNotice = false;

  const setNotice = (text) => {
    notice.textContent = text;
    notice.hidden = text === '';
  };

  function drawNav(activeId) {
    navCircles.replaceChildren(
      ...circles.map((c) => {
        const row = navTemplate.content.firstElementChild.cloneNode(true);
        const link = row.querySelector('[data-slot="link"]');
        if (!link) throw new Error('the navigation template has no slot "link"');
        link.textContent = c.circleName;
        link.setAttribute('href', `#/circle/${c.circleId}`);
        if (c.circleId === activeId) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
        return row;
      }),
    );
    navCircles.hidden = circles.length === 0;
  }

  /** Asks the service which circles the person is in. A failure keeps what was known (the screens still work). */
  async function refresh() {
    const r = await notes.scopes();
    if (!r.ok) return false;
    circles = r.value.items.filter((s) => s.scope.kind === 'circle').map((s) => Object.freeze({ circleId: s.scope.circleId, circleName: s.scope.circleName, role: s.role, canCapture: s.canCapture }));
    return true;
  }

  return Object.freeze({
    /** The circles as last read. */
    list: () => circles,
    async route(name, param) {
      const mine = ++epoch;
      if (!keepNotice) setNotice('');
      keepNotice = false;
      await refresh();
      if (mine !== epoch) return;
      const wanted = name === 'circle' ? param : undefined;
      const found = wanted === undefined ? undefined : circles.find((c) => c.circleId === wanted);
      if (name === 'circle' && found === undefined) {
        // a circle the person is not in (or has left): the one set of words, and back to Home
        drawNav(undefined);
        chat.hide();
        current = undefined;
        keepNotice = true;
        setNotice('No such circle, or you are not in it.');
        go('#/');
        return;
      }
      drawNav(found?.circleId);
      current = found;
      if (found === undefined) chat.hide();
      else {
        heading.textContent = found.circleName;
        document.title = `${found.circleName} – CaCi`;
        chat.show(found);
        heading.focus();
      }
    },
    /** Sign-out: forget the list, the screen and everything on it. */
    reset() {
      epoch += 1;
      chat.reset();
      circles = [];
      current = undefined;
      navCircles.replaceChildren();
      navCircles.hidden = true;
      heading.textContent = '';
      setNotice('');
      view.hidden = true;
    },
    current: () => current,
  });
}
