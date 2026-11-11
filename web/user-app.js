// The everyday app's entry point: start the page. Everything else is in the modules it imports.
import { mountUser } from './user-mount.js';
import { userHooks } from './user-hooks.js';

const fetchFn = (...args) => window.fetch(...args);

mountUser(
  document,
  fetchFn,
  {
    getHash: () => window.location.hash,
    setHash: (hash) => {
      window.location.hash = hash;
    },
    // the join link's token is read once and then taken out of the address (without adding a history entry)
    replaceHash: (hash) => window.history.replaceState(null, '', hash),
    onHashChange: (listener) => window.addEventListener('hashchange', listener),
  },
  (context) => userHooks(document, fetchFn, context),
);
