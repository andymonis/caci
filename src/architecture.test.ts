import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The container diagram says where each piece lives. This keeps it honest: every `Code: src/...`
// it names must be a real folder, except for pieces the diagram itself marks as planned, and every
// container must be connected to something.

const diagram = readFileSync(new URL('../architecture/container.mmd', import.meta.url), 'utf8');
const root = new URL('../', import.meta.url);

const containers = [...diagram.matchAll(/^\s*Container(?:Db)?\((\w+),\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)"\)/gm)].map((m) => ({ id: m[1] as string, name: m[2] as string, text: m[4] as string }));

describe('the container diagram', () => {
  it('names a good number of containers', () => {
    expect(containers.length).toBeGreaterThanOrEqual(10);
  });

  it.each(containers.map((c) => [c.name, c] as const))('%s: its code folder exists, unless it is marked planned', (_name, c) => {
    const folders = [...c.text.matchAll(/Code: (src\/[\w/.-]+?)\.(?:\s|$)/g)].map((m) => m[1] as string);
    if (/\bPlanned\b/.test(c.text)) return;
    for (const folder of folders) expect(existsSync(new URL(folder, root)), `${folder} does not exist`).toBe(true);
  });

  it.each(containers.map((c) => [c.name, c.id] as const))('%s is connected to something', (_name, id) => {
    expect(new RegExp(`Rel\\((?:${id}),|Rel\\(\\w+, (?:${id}),`).test(diagram), `${id} has no relationship`).toBe(true);
  });

  it('shows a generic person, not a customer of any one business', () => {
    expect(diagram).not.toMatch(/bank|customer/i);
  });
});
