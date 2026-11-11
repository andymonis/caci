// Puts the everyday app's own screens together: the Home chat, the circle links and screens. `user-mount.js` calls the
// returned hooks when the screen changes (`route(name, param)`) and on sign-out (`reset()`).

import { createAgentTokensClient } from './agent-tokens-client.js';
import { mountAgentAccess } from './agent-access-page.js';
import { mountChatPage } from './chat-page.js';
import { createJoinClient } from './join-client.js';
import { createLedgerClient } from './ledger-client.js';
import { createNotesClient } from './notes-client.js';
import { mountUserCircles } from './user-circles.js';
import { mountUserJoin } from './user-join.js';

export function userHooks(document, fetchFn, { recheck, go, replace }) {
  const notes = createNotesClient({ fetchFn });
  const ledger = createLedgerClient({ fetchFn });
  const chat = mountChatPage(document, notes, recheck, ledger);
  const circles = mountUserCircles(document, notes, { go, recheck }, ledger);
  const join = mountUserJoin(document, createJoinClient({ fetchFn }), { go, recheck, replace: replace ?? go });
  const agentAccess = mountAgentAccess(document, { client: createAgentTokensClient({ fetchFn }), circles: () => circles.list(), onSignedOut: recheck });
  return Object.freeze({
    route(name, param) {
      chat.route(name);
      const read = circles.route(name, param);
      agentAccess.route(name, read);
      join.route(name, param);
    },
    reset() {
      chat.reset();
      circles.reset();
      agentAccess.reset();
      join.reset();
    },
  });
}
