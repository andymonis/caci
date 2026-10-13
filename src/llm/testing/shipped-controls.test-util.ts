import { readFileSync } from 'node:fs';
import { CONTROL_FILES, parseControls, type Controls } from '../controls/controls.js';

/** The shipped `controls/` folder, read and checked, for tests (the service and the dev tools have their own loaders). */
function load(): Controls {
  const files: Record<string, string> = {};
  for (const name of CONTROL_FILES) files[name] = readFileSync(new URL(`../../../controls/${name}`, import.meta.url), 'utf8');
  const parsed = parseControls(files);
  if (!parsed.ok) throw new Error(`the shipped controls are not valid: ${parsed.error.join('; ')}`);
  return parsed.value;
}

export const SHIPPED_CONTROLS: Controls = load();
/** The raw text of the shipped files, for tests that change one of them. */
export function shippedFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of CONTROL_FILES) files[name] = readFileSync(new URL(`../../../controls/${name}`, import.meta.url), 'utf8');
  return files;
}
