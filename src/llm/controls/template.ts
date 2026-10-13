// The text templates of the controls (R-012). Named `{{slots}}` only: no logic, no loops, no includes. Pure.

/** A parsed template: the text with its slots located, so rendering is one pass and never re-reads a value. */
export interface Template {
  /** The text, a final line break removed. */
  readonly text: string;
  /** Alternating literal and slot name: `parts[0]` is literal, `parts[1]` a slot name, `parts[2]` literal... */
  readonly parts: readonly string[];
  /** The distinct slot names used, in order of first use. */
  readonly slots: readonly string[];
}

export interface TemplateRules {
  /** The slots this file may use. */
  readonly allowed: readonly string[];
  /** Slots that must appear at least once. */
  readonly required?: readonly string[];
  /** Slots that must appear exactly once (implies required). */
  readonly once?: readonly string[];
}

export const MAX_TEMPLATE_CHARS = 16_000;

const SLOT = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;
const FORBIDDEN_CONTROL = /[^\P{Cc}\n\t]/u;

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;
/** At most 20 characters of a token, for a message. */
const quote = (token: string): string => JSON.stringify(token.length > 20 ? `${token.slice(0, 19)}…` : token);

/**
 * Parses one template file. Every problem is reported, each starting with the file name (and the line where there
 * is one). Never throws.
 */
export function parseTemplate(file: string, source: unknown, rules: TemplateRules): { readonly ok: true; readonly value: Template } | { readonly ok: false; readonly problems: readonly string[] } {
  if (typeof source !== 'string') return { ok: false, problems: [`${file}: must be text`] };
  const text = source.replace(/\n+$/, '');
  const problems: string[] = [];
  if (text.trim() === '') return { ok: false, problems: [`${file}: is empty`] };
  if (text.length > MAX_TEMPLATE_CHARS) return { ok: false, problems: [`${file}: ${text.length} characters, over the limit of ${MAX_TEMPLATE_CHARS}`] };
  const control = FORBIDDEN_CONTROL.exec(text);
  if (control !== null) problems.push(`${file}: line ${lineOf(text, control.index)}: contains a control character (only line breaks and tabs are allowed)`);

  const parts: string[] = [];
  const counts = new Map<string, number>();
  let last = 0;
  for (const m of text.matchAll(SLOT)) {
    const name = m[1] as string;
    const at = m.index ?? 0;
    parts.push(text.slice(last, at), name);
    last = at + m[0].length;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (!rules.allowed.includes(name)) problems.push(`${file}: line ${lineOf(text, at)}: unknown slot ${quote(name)} (this file may use: ${rules.allowed.join(', ')})`);
  }
  parts.push(text.slice(last));
  // anything left that looks like a brace pair is a mistake, not text
  const inSlot = (index: number): boolean => [...text.matchAll(SLOT)].some((m) => index >= (m.index ?? 0) && index < (m.index ?? 0) + m[0].length);
  for (const stray of text.matchAll(/\{\{|\}\}/g)) {
    const at = stray.index ?? 0;
    if (inSlot(at) || inSlot(at + 1)) continue;
    problems.push(`${file}: line ${lineOf(text, at)}: stray ${quote(stray[0])} (a slot is written {{name}} with a letter first and letters or digits after)`);
    break;
  }
  for (const name of [...(rules.required ?? []), ...(rules.once ?? [])]) if (!counts.has(name)) problems.push(`${file}: the required slot {{${name}}} is missing`);
  for (const name of rules.once ?? []) if ((counts.get(name) ?? 0) > 1) problems.push(`${file}: the slot {{${name}}} must appear exactly once, not ${counts.get(name)} times`);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: Object.freeze({ text, parts: Object.freeze(parts), slots: Object.freeze([...counts.keys()]) }) };
}

/**
 * Fills the slots. **A value is inserted as it is and never searched for slots**, so text that looks like a slot
 * stays text. A slot with no value is a coding mistake and throws.
 */
export function renderTemplate(template: Template, values: Readonly<Record<string, string>>): string {
  let out = '';
  for (let i = 0; i < template.parts.length; i++) {
    const piece = template.parts[i] as string;
    if (i % 2 === 0) out += piece;
    else {
      const value = Object.hasOwn(values, piece) ? values[piece] : undefined;
      if (typeof value !== 'string') throw new TypeError(`renderTemplate: no value for the slot {{${piece}}}`);
      out += value;
    }
  }
  return out;
}
