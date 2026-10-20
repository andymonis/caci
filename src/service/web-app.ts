import { fileURLToPath } from 'node:url';
import type { WebFileSpec } from './web-files.js';

/**
 * The web app's files and where each is served (R-005 D5): this list, written here, is the whole of what the
 * service will ever send from the `web/` folder. A file added to the folder is not served until it is listed
 * (and the test that compares the folder with this list says so).
 */
export const WEB_FILE_SPECS: readonly WebFileSpec[] = Object.freeze([
  { path: '/', file: 'user.html', kind: 'html' }, // the everyday app (R-016)
  { path: '/admin', file: 'index.html', kind: 'html' }, // the back office: the whole of the app, unchanged
  { path: '/app.js', file: 'app.js', kind: 'js' },
  { path: '/mount.js', file: 'mount.js', kind: 'js' },
  { path: '/view.js', file: 'view.js', kind: 'js' },
  { path: '/session.js', file: 'session.js', kind: 'js' },
  { path: '/forms.js', file: 'forms.js', kind: 'js' },
  { path: '/api-client.js', file: 'api-client.js', kind: 'js' },
  { path: '/circles-client.js', file: 'circles-client.js', kind: 'js' },
  { path: '/router.js', file: 'router.js', kind: 'js' },
  { path: '/notes-client.js', file: 'notes-client.js', kind: 'js' },
  { path: '/sharing-client.js', file: 'sharing-client.js', kind: 'js' },
  { path: '/grants-session.js', file: 'grants-session.js', kind: 'js' },
  { path: '/share-page.js', file: 'share-page.js', kind: 'js' },
  { path: '/shared-page.js', file: 'shared-page.js', kind: 'js' },
  { path: '/shared-session.js', file: 'shared-session.js', kind: 'js' },
  { path: '/status-session.js', file: 'status-session.js', kind: 'js' },
  { path: '/status-page.js', file: 'status-page.js', kind: 'js' },
  { path: '/status-view.js', file: 'status-view.js', kind: 'js' },
  { path: '/permissions.js', file: 'permissions.js', kind: 'js' },
  { path: '/brain-page.js', file: 'brain-page.js', kind: 'js' },
  { path: '/brain-session.js', file: 'brain-session.js', kind: 'js' },
  { path: '/ledger-client.js', file: 'ledger-client.js', kind: 'js' },
  { path: '/ledger-page.js', file: 'ledger-page.js', kind: 'js' },
  { path: '/ledger-view.js', file: 'ledger-view.js', kind: 'js' },
  { path: '/ledger-session.js', file: 'ledger-session.js', kind: 'js' },
  { path: '/chat-session.js', file: 'chat-session.js', kind: 'js' },
  { path: '/chat-page.js', file: 'chat-page.js', kind: 'js' },
  { path: '/chat-view.js', file: 'chat-view.js', kind: 'js' },
  { path: '/settings-session.js', file: 'settings-session.js', kind: 'js' },
  { path: '/scope-session.js', file: 'scope-session.js', kind: 'js' },
  { path: '/brain-view.js', file: 'brain-view.js', kind: 'js' },
  { path: '/capture-page.js', file: 'capture-page.js', kind: 'js' },
  { path: '/capture-session.js', file: 'capture-session.js', kind: 'js' },
  { path: '/capture-view.js', file: 'capture-view.js', kind: 'js' },
  { path: '/circle-page.js', file: 'circle-page.js', kind: 'js' },
  { path: '/circles-pages.js', file: 'circles-pages.js', kind: 'js' },
  { path: '/circles-view.js', file: 'circles-view.js', kind: 'js' },
  { path: '/circle-session.js', file: 'circle-session.js', kind: 'js' },
  { path: '/circles-session.js', file: 'circles-session.js', kind: 'js' },
  { path: '/style.css', file: 'style.css', kind: 'css' },
  { path: '/user-app.js', file: 'user-app.js', kind: 'js' },
  { path: '/user-mount.js', file: 'user-mount.js', kind: 'js' },
  { path: '/user-circles.js', file: 'user-circles.js', kind: 'js' },
  { path: '/circle-chat-page.js', file: 'circle-chat-page.js', kind: 'js' },
  { path: '/thread-view.js', file: 'thread-view.js', kind: 'js' },
  { path: '/user-hooks.js', file: 'user-hooks.js', kind: 'js' },
  { path: '/user-style.css', file: 'user-style.css', kind: 'css' },
] as const);

/**
 * The `web/` folder beside `src/` (when run from source) or `dist/` (when built): both are two folders below
 * the project root, so the same relative path finds it.
 */
export function defaultWebDir(): string {
  return fileURLToPath(new URL('../../web/', import.meta.url));
}
