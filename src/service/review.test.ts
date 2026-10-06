import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The security review in specs/R-002-user-accounts.md says which test covers each threat and each
// acceptance criterion. This keeps those references honest: every named test file must exist and
// still contain the test the review points at, so renaming or deleting a test breaks the build
// until the review is brought up to date.

const spec = readFileSync(new URL('../../specs/R-002-user-accounts.md', import.meta.url), 'utf8');
const root = new URL('../../', import.meta.url);

const REFERENCE = /`(src\/[\w/.-]+\.ts)` — "([^"]+)"/g;
const references = [...spec.matchAll(REFERENCE)].map((m) => ({ file: m[1] as string, fragment: m[2] as string }));

function rows(heading: string): string[] {
  const start = spec.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const next = spec.indexOf('\n## ', start + 3);
  const nextSub = spec.indexOf('\n### ', start + 3);
  const end = [next, nextSub].filter((n) => n > 0).sort((a, b) => a - b)[0] ?? spec.length;
  return spec
    .slice(start, end)
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Threat') && !line.startsWith('| ID') && !line.startsWith('|---') && !line.startsWith('|--'));
}

describe('the security review in the R-002 spec', () => {
  it('points at a good number of tests', () => {
    expect(references.length).toBeGreaterThanOrEqual(45);
  });

  it.each(references.map((r) => [r.file, r.fragment] as const))('%s still has a test called "%s"', (file, fragment) => {
    expect(existsSync(new URL(file, root)), `${file} does not exist`).toBe(true);
    expect(readFileSync(new URL(file, root), 'utf8'), `${file} no longer has "${fragment}"`).toContain(fragment);
  });

  it('every threat row names at least one covering test', () => {
    const threats = rows('## Threats and controls');
    expect(threats.length).toBeGreaterThanOrEqual(14);
    for (const row of threats) expect([...row.matchAll(REFERENCE)].length, row.slice(0, 60)).toBeGreaterThanOrEqual(1);
  });

  it('every acceptance criterion names at least one covering test, and all twelve are there', () => {
    const criteria = rows('### Where each criterion is checked');
    expect(criteria.map((r) => r.split('|')[1]?.trim())).toEqual(Array.from({ length: 12 }, (_, i) => `UA-AC-${String(i + 1).padStart(2, '0')}`));
    for (const row of criteria) expect([...row.matchAll(REFERENCE)].length, row.slice(0, 20)).toBeGreaterThanOrEqual(1);
  });

  it('lists its residual risks, so what is not covered is stated', () => {
    expect(spec).toContain('### Residual risks (not covered, with the reason)');
    expect(spec.match(/^\d\. \*\*/gm)?.length).toBeGreaterThanOrEqual(8);
  });
});
