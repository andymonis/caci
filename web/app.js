// The entry point: start the page. Everything else is in the modules it imports.
import { mount } from './mount.js';

mount(document, (...args) => window.fetch(...args));
