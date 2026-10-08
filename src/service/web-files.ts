import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentKind, WebFile } from '../api/index.js';

/** One file the web app is made of: where it is served, the file it comes from, and its kind. */
export interface WebFileSpec {
  readonly path: string;
  /** A plain file name inside the web folder: no folder, no `..`. */
  readonly file: string;
  readonly kind: DocumentKind;
}

const PLAIN_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_BYTES = 512 * 1024;

/**
 * Reads the web app's files from `dir`, once, at start. Only the names in `specs` are ever read, each
 * a plain name inside the folder (never a path), and each must be an ordinary file (not a link, not a
 * folder) of at most 512 KB. A missing or odd file stops the start and the message names it. Whatever
 * is in the folder besides these files is never read or served.
 */
export function loadWebFiles(dir: string, specs: readonly WebFileSpec[]): WebFile[] {
  return specs.map((spec) => {
    if (!PLAIN_NAME.test(spec.file) || spec.file.includes('..')) throw new TypeError(`web file name ${JSON.stringify(spec.file)} is not a plain file name`);
    const path = join(dir, spec.file);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      throw new Error(`the web app is missing its file "${spec.file}" in ${dir}`);
    }
    if (!stat.isFile()) throw new Error(`the web app's "${spec.file}" in ${dir} is not an ordinary file`);
    if (stat.size > MAX_BYTES) throw new Error(`the web app's "${spec.file}" in ${dir} is larger than ${MAX_BYTES} bytes`);
    return { path: spec.path, kind: spec.kind, text: readFileSync(path, 'utf8') };
  });
}
