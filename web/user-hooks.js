// Puts the everyday app's own screens together: the Home chat, the circle links and screens. `user-mount.js` calls the
// returned hooks when the screen changes (`route(name, param)`) and on sign-out (`reset()`).

import { createAgentTokensClient } from './agent-tokens-client.js';
import { mountAgentAccess } from './agent-access-page.js';
import { mountChatPage } from './chat-page.js';
import { createFactsClient } from './facts-client.js';
import { createJoinClient } from './join-client.js';
import { createLedgerClient } from './ledger-client.js';
import { createNotesClient } from './notes-client.js';
import { mountUserCircles } from './user-circles.js';
import { mountUserJoin } from './user-join.js';

export function userHooks(document, fetchFn, { recheck, go, replace }) {
  const notes = createNotesClient({ fetchFn });
  const ledger = createLedgerClient({ fetchFn });
  const facts = createFactsClient({ fetchFn });
  let circles; // made below: the Home chat asks it which circles you own, so it can offer 'remove' only where you may
  const chat = mountChatPage(document, notes, recheck, ledger, facts, (circleId) => (circles?.list() ?? []).some((c) => c.circleId === circleId && c.role === 'owner'));
  circles = mountUserCircles(document, notes, { go, recheck }, ledger, facts);
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
