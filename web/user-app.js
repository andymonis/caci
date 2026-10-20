// The everyday app's entry point: start the page. Everything else is in the modules it imports.
import { mountUser } from './user-mount.js';

mountUser(document, (...args) => window.fetch(...args), {
  getHash: () => window.location.hash,
  setHash: (hash) => {
    window.location.hash = hash;
  },
  onHashChange: (listener) => window.addEventListener('hashchange', listener),
});
