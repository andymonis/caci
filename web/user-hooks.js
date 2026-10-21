// Puts the everyday app's own screens together: the Home chat, the circle links and screens. `user-mount.js` calls the
// returned hooks when the screen changes (`route(name, param)`) and on sign-out (`reset()`).

import { mountChatPage } from './chat-page.js';
import { createLedgerClient } from './ledger-client.js';
import { createNotesClient } from './notes-client.js';
import { mountUserCircles } from './user-circles.js';

export function userHooks(document, fetchFn, { recheck, go }) {
  const notes = createNotesClient({ fetchFn });
  const ledger = createLedgerClient({ fetchFn });
  const chat = mountChatPage(document, notes, recheck, ledger);
  const circles = mountUserCircles(document, notes, { go, recheck }, ledger);
  return Object.freeze({
    route(name, param) {
      chat.route(name);
      void circles.route(name, param);
    },
    reset() {
      chat.reset();
      circles.reset();
    },
  });
}
