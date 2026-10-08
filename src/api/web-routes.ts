import { documentResponse, type DocumentKind, type Route } from './router.js';

/** One file of the web app, already read: where it is served, what kind it is, and its text. */
export interface WebFile {
  /** `/` for the page, otherwise one segment such as `/app.js`: lower-case letters, digits, `.`, `_` and `-`. */
  readonly path: string;
  readonly kind: DocumentKind;
  readonly text: string;
}

export interface WebRoutesOptions {
  readonly files: readonly WebFile[];
}

/**
 * The policy every page and asset of the web app is sent with (R-005 WA-NFR-01): scripts and styles from the
 * same address only, no inline code, connections to the same address only, no framing, no forms posted
 * anywhere, no base tag. Anything not named is refused (`default-src 'none'`).
 */
export const WEB_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const WEB_KINDS = ['html', 'js', 'css', 'text'] as const;
const WEB_PATH = /^\/(?:[a-z0-9][a-z0-9._-]{0,63})?$/;
const MAX_FILE_CHARS = 512 * 1024;

/**
 * The web app as routes: one GET route per listed file and nothing else, so there is no path to walk and
 * no directory to list. The files are given, not looked up: the list is the whole of what can be served.
 * A mistake in the list (a repeated or odd path, a kind that is not a page, script or style sheet, an
 * oversized file) is a `TypeError` when the routes are made.
 */
export function createWebRoutes(options: WebRoutesOptions): readonly Route[] {
  const seen = new Set<string>();
  const routes: Route[] = [];
  for (const file of options.files) {
    if (typeof file.path !== 'string' || !WEB_PATH.test(file.path) || file.path.includes('..') || file.path.endsWith('.') || /^\/\./.test(file.path)) throw new TypeError(`createWebRoutes: bad path ${JSON.stringify(file.path)}`);
    if (seen.has(file.path)) throw new TypeError(`createWebRoutes: ${file.path} is listed twice`);
    seen.add(file.path);
    if (!(WEB_KINDS as readonly string[]).includes(file.kind)) throw new TypeError(`createWebRoutes: ${file.path} must be html, js, css or text`);
    if (typeof file.text !== 'string' || file.text.length > MAX_FILE_CHARS) throw new TypeError(`createWebRoutes: ${file.path} must be text of at most ${MAX_FILE_CHARS} characters`);
    if ((file.path === '/') !== (file.kind === 'html')) throw new TypeError(`createWebRoutes: the page (/) must be html, and html must be the page`);
    const response = documentResponse({ kind: file.kind, text: file.text, policy: WEB_POLICY });
    routes.push({ method: 'GET', path: file.path, handler: () => response });
  }
  if (!seen.has('/')) throw new TypeError('createWebRoutes: there is no page (/)');
  return routes;
}
