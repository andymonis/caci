import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The security reviews in the specs say which test covers each threat and each acceptance
// criterion. This keeps those references honest: every named test file must exist and still
// contain the test the review points at, so renaming or deleting a test breaks the build until
// the review is brought up to date. One block per spec.

const root = new URL('../../', import.meta.url);
const REFERENCE = /`((?:src|web)\/[\w/.-]+\.(?:ts|mjs))` — "([^"]+)"/g;

const SPECS = [
  { name: 'R-002', file: 'specs/R-002-user-accounts.md', minReferences: 45, minThreats: 14, criteria: 12, prefix: 'UA-AC-', criteriaHeading: '### Where each criterion is checked', minRisks: 8 },
  { name: 'R-003', file: 'specs/R-003-caci-controller.md', minReferences: 30, minThreats: 10, criteria: 10, prefix: 'CC-AC-', criteriaHeading: '### Where each criterion is checked', minRisks: 7 },
  { name: 'R-004', file: 'specs/R-004-circles.md', minReferences: 45, minThreats: 11, criteria: 12, prefix: 'CR-AC-', criteriaHeading: '### Where each criterion is checked', minRisks: 9 },
  { name: 'R-005', file: 'specs/R-005-web-app.md', minReferences: 35, minThreats: 9, criteria: 10, prefix: 'WA-AC-', criteriaHeading: '### Where each criterion is checked', minRisks: 8 },
  { name: 'R-006', file: 'specs/R-006-web-circles.md', minReferences: 60, minThreats: 9, criteria: 12, prefix: 'WC-AC-', criteriaHeading: '### Where each criterion is checked', minRisks: 8 },
] as const;

for (const info of SPECS) {
  const spec = readFileSync(new URL(info.file, root), 'utf8');
  const references = [...spec.matchAll(REFERENCE)].map((m) => ({ file: m[1] as string, fragment: m[2] as string }));

  const rows = (heading: string): string[] => {
    const start = spec.indexOf(heading);
    expect(start, heading).toBeGreaterThanOrEqual(0);
    const next = spec.indexOf('\n## ', start + 3);
    const nextSub = spec.indexOf('\n### ', start + 3);
    const end = [next, nextSub].filter((n) => n > 0).sort((a, b) => a - b)[0] ?? spec.length;
    return spec
      .slice(start, end)
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| Threat') && !line.startsWith('| ID') && !line.startsWith('|---') && !line.startsWith('|--'));
  };

  describe(`the security review in the ${info.name} spec`, () => {
    it('points at a good number of tests', () => {
      expect(references.length).toBeGreaterThanOrEqual(info.minReferences);
    });

    it.each(references.map((r) => [r.file, r.fragment] as const))('%s still has a test called "%s"', (file, fragment) => {
      expect(existsSync(new URL(file, root)), `${file} does not exist`).toBe(true);
      expect(readFileSync(new URL(file, root), 'utf8'), `${file} no longer has "${fragment}"`).toContain(fragment);
    });

    it('every threat row names at least one covering test', () => {
      const threats = rows('## Threats and controls');
      expect(threats.length).toBeGreaterThanOrEqual(info.minThreats);
      for (const row of threats) expect([...row.matchAll(REFERENCE)].length, row.slice(0, 60)).toBeGreaterThanOrEqual(1);
    });

    it(`every acceptance criterion names at least one covering test, and all ${info.criteria} are there`, () => {
      const criteria = rows(info.criteriaHeading);
      expect(criteria.map((r) => r.split('|')[1]?.trim())).toEqual(Array.from({ length: info.criteria }, (_, i) => `${info.prefix}${String(i + 1).padStart(2, '0')}`));
      for (const row of criteria) expect([...row.matchAll(REFERENCE)].length, row.slice(0, 20)).toBeGreaterThanOrEqual(1);
    });

    it('lists its residual risks, so what is not covered is stated', () => {
      expect(spec).toContain('### Residual risks (not covered, with the reason)');
      expect(spec.match(/^\d\. \*\*/gm)?.length).toBeGreaterThanOrEqual(info.minRisks);
    });
  });
}
