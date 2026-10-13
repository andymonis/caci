import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Writes the six controls files (or any subset) into a folder, making the two sub folders. */
export function writeControls(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name.split('/')[0] as string), { recursive: true });
    writeFileSync(join(dir, ...name.split('/')), text);
  }
}
