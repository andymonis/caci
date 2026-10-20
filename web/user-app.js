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
    onHashChange: (listener) => window.addEventListener('hashchange', listener),
  },
  (context) => userHooks(document, fetchFn, context),
);
