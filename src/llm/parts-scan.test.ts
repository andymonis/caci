import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTROL_FILES } from './controls/controls.js';
import { shippedFiles } from './testing/shipped-controls.test-util.js';

// R-012 CL-AC-08: nothing is sent to a model that is not the request, the context or the controls. A source scan,
// so a new call site or a sentence slipped back into code fails the build.

const srcRoot = fileURLToPath(new URL('../', import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const isProduction = (file: string): boolean => /\.ts$/.test(file) && !/\.test\.ts$/.test(file) && !/\.test-util\.ts$/.test(file);
const production = walk(srcRoot).filter(isProduction).map((f) => ({ file: relative(srcRoot, f), source: readFileSync(f, 'utf8') }));
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the only places that ask a model', () => {
  it('are the two capabilities: no other production file calls a model client', () => {
    // the contract suite in llm/testing exercises clients directly; it sends fixed test text, never a person's or a brain's
    const callers = production.filter(({ file, source }) => !file.startsWith('llm/testing/') && /\.complete\(/.test(withoutComments(source))).map((p) => p.file);
    expect(callers.sort()).toEqual(['llm/capabilities/categorise/categorise.ts', 'llm/capabilities/status/status.ts']);
  });

  it('none of the application, the controllers, the API or the service talks to a model client', () => {
    const offenders = production.filter(({ file, source }) => /^(?:app|caci|api|service|scopes|sharing|circles|users)\//.test(file) && /\.complete\(/.test(withoutComments(source)));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it.each(['llm/capabilities/categorise/categorise.ts', 'llm/capabilities/status/status.ts'])('%s sends only the built system message and the built messages (with the repair turn)', (file) => {
    const source = withoutComments(production.find((p) => p.file === file)?.source ?? '');
    expect(source.match(/\.complete\(/g)).toHaveLength(1);
    expect(source).toContain('system: prompt.value.system,');
    expect(source).toMatch(/\n\s+messages,\n/); // the list given to the attempt: the built messages, or those plus the repair turn
    expect(source).toContain('const first = await attempt(prompt.value.messages);');
    expect(source).toMatch(/\[\.\.\.prompt\.value\.messages, \{ role: 'assistant', content: describeReply\(first\.value\.response\.output\) \}, \{ role: 'user', content: feedback \}\]|\.\.\.prompt\.value\.messages,\n\s+\{ role: 'assistant', content: describeReply\(first\.value\.response\.output\) \},\n\s+\{ role: 'user', content: feedback \},/);
    expect(source).toContain('const feedback = `${cut(rejectionError(first.value.verdict.error).message)}\\nReply again with the corrected JSON object only.`;');
  });
});

describe('no wording from the controls is hidden in code', () => {
  const lines = (name: string): string[] =>
    (shippedFiles()[name] as string)
      .split('\n')
      .map((l) => l.replace(/\{\{[A-Za-z0-9]+\}\}/g, '').trim())
      .filter((l) => l.length >= 25);

  it('there are enough lines to check', () => {
    expect(CONTROL_FILES.filter((n) => n.endsWith('.txt')).flatMap(lines).length).toBeGreaterThan(20);
  });

  it.each(CONTROL_FILES.filter((n) => n.endsWith('.txt')))('no line of %s appears in any production source file', (name) => {
    for (const line of lines(name)) {
      const text = line.replace(/^\d+\.\s*/, '').replace(/^- /, '').slice(0, 40);
      const found = production.filter(({ source }) => source.includes(text)).map((p) => p.file);
      expect(found, `"${text}" is in code`).toEqual([]);
    }
  });

  it('the scan can see a sentence in code (so a pass means something)', () => {
    const probe = 'Reply again with the corrected JSON object only.';
    expect(production.some(({ source }) => source.includes(probe))).toBe(true);
  });
});
