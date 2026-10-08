import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A stand-in for the page, made from the real index.html, shared by the tests that run the page's script.

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

/** A page made from the real index.html: an element for each id in it, starting hidden if the HTML says so. */
export function fakePage() {
  const elements = new Map();
  let focused;
  for (const tag of HTML.matchAll(/<[a-z0-9]+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const attrs = new Map();
    const listeners = new Map();
    const el = {
      id: tag[1],
      hidden: /\bhidden\b/.test(tag[0]),
      textContent: '',
      value: '',
      disabled: false,
      setAttribute: (k, v) => void attrs.set(k, String(v)),
      removeAttribute: (k) => void attrs.delete(k),
      getAttribute: (k) => attrs.get(k) ?? null,
      addEventListener: (type, fn) => void listeners.set(type, fn),
      focus: () => void (focused = el),
      fire: (type) => listeners.get(type)?.({ preventDefault: () => (el.prevented = true) }),
      prevented: false,
    };
    elements.set(tag[1], el);
  }
  return { document: { getElementById: (id) => elements.get(id) ?? null }, el: (id) => elements.get(id), focused: () => focused, ids: [...elements.keys()] };
}


export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
export async function settle() {
  for (let i = 0; i < 6; i++) await tick();
}
export const visibleScreens = (page) => ['loading', 'unreachable', 'signed-out', 'signed-in'].filter((s) => !page.el(`screen-${s}`).hidden);
export const fill = (page, form, values) => {
  for (const [field, value] of Object.entries(values)) page.el(`${form}-${field}`).value = value;
};


/** Waits (for real network answers) until the condition holds, or fails after a couple of seconds. */
export async function waitFor(condition, what = 'the page to change') {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}
