import { fileURLToPath } from 'node:url';
import type { WebFileSpec } from './web-files.js';

/**
 * The web app's files and where each is served (R-005 D5): this list, written here, is the whole of what the
 * service will ever send from the `web/` folder. A file added to the folder is not served until it is listed
 * (and the test that compares the folder with this list says so).
 */
export const WEB_FILE_SPECS: readonly WebFileSpec[] = Object.freeze([
  { path: '/', file: 'index.html', kind: 'html' },
  { path: '/app.js', file: 'app.js', kind: 'js' },
  { path: '/mount.js', file: 'mount.js', kind: 'js' },
  { path: '/view.js', file: 'view.js', kind: 'js' },
  { path: '/session.js', file: 'session.js', kind: 'js' },
  { path: '/forms.js', file: 'forms.js', kind: 'js' },
  { path: '/api-client.js', file: 'api-client.js', kind: 'js' },
  { path: '/style.css', file: 'style.css', kind: 'css' },
] as const);

/**
 * The `web/` folder beside `src/` (when run from source) or `dist/` (when built): both are two folders below
 * the project root, so the same relative path finds it.
 */
export function defaultWebDir(): string {
  return fileURLToPath(new URL('../../web/', import.meta.url));
}
