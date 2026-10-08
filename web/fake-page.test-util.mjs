import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A stand-in for the page, made from the real index.html, shared by the tests that run the page's script.

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

/** A page made from the real index.html: an element for each id in it, starting hidden if the HTML says so; the templates can be cloned. */
export function fakePage() {
  const elements = new Map();
  const state = { focused: undefined };

  function makeElement(tag, attributes, hidden) {
    const attrs = new Map(attributes);
    const listeners = new Map();
    const el = {
      tagName: tag,
      hidden,
      textContent: '',
      value: '',
      disabled: false,
      children: [],
      template: undefined,
      setAttribute: (k, v) => void attrs.set(k, String(v)),
      removeAttribute: (k) => void attrs.delete(k),
      getAttribute: (k) => attrs.get(k) ?? null,
      addEventListener: (type, fn) => void listeners.set(type, fn),
      focus: () => void (state.focused = el),
      fire: (type) => listeners.get(type)?.({ preventDefault: () => (el.prevented = true) }),
      prevented: false,
      replaceChildren: (...nodes) => void (el.children = nodes),
      querySelector(selector) {
        const m = /^\[data-slot="([^"]+)"\]$/.exec(selector);
        if (!m) throw new Error(`the stand-in page only supports [data-slot="..."], not ${selector}`);
        const find = (node) => {
          for (const child of node.children) {
            if (child.getAttribute('data-slot') === m[1]) return child;
            const inner = find(child);
            if (inner) return inner;
          }
          return null;
        };
        return find(el);
      },
      cloneNode() {
        const copy = makeElement(tag, attrs, el.hidden);
        copy.textContent = el.textContent;
        copy.children = el.children.map((child) => child.cloneNode(true));
        return copy;
      },
    };
    return el;
  }

  // <template id="x">...</template>: parse the simple markup inside into elements
  let outside = HTML;
  for (const tpl of HTML.matchAll(/<template\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/template>/g)) {
    outside = outside.replace(tpl[0], '');
    const root = makeElement('template', [], false);
    const stack = [root];
    for (const token of tpl[2].matchAll(/<(\/?)([a-z0-9]+)\b([^>]*)>|([^<]+)/g)) {
      if (token[4] !== undefined) {
        const text = token[4].trim();
        if (text !== '') stack.at(-1).textContent = text;
      } else if (token[1] === '/') {
        stack.pop();
      } else {
        const attributes = [...token[3].matchAll(/([a-z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]);
        const node = makeElement(token[2], attributes, /\bhidden\b/.test(token[3]));
        stack.at(-1).children.push(node);
        stack.push(node);
      }
    }
    const holder = elements.get(tpl[1]) ?? makeElement('template', [], false);
    holder.content = { firstElementChild: root.children[0] };
    elements.set(tpl[1], holder);
  }

  for (const tag of outside.matchAll(/<([a-z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const attributes = [...tag[2].matchAll(/([a-z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]);
    const el = makeElement(tag[1], attributes, /\bhidden\b/.test(tag[2]));
    el.id = tag[3];
    elements.set(tag[3], el);
  }
  const document = { title: '', getElementById: (id) => elements.get(id) ?? null };
  return { document, el: (id) => elements.get(id), focused: () => state.focused, ids: [...elements.keys()] };
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
