import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guards on the files themselves (R-005 WA-NFR-02 to 04, 08): the page carries no inline code, nothing
// from another address, no way to turn text into markup and no browser storage. They read the real
// files, so a careless edit breaks the build.

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => !f.endsWith('.test.mjs'));
const read = (name) => readFileSync(join(dir, name), 'utf8');
const scripts = files.filter((f) => f.endsWith('.js'));
const html = read('index.html');
const css = read('style.css');

/** Source with comments removed, so a sentence in a comment is not mistaken for code. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\w"'`/])\/\/.*$/gm, '$1');
}

describe('the files', () => {
  it('are exactly these, which the service will list', () => {
    expect(files.sort()).toEqual(['api-client.js', 'app.js', 'forms.js', 'index.html', 'mount.js', 'session.js', 'style.css', 'view.js']);
  });

  it('all the scripts import only each other, by name, from the same folder', () => {
    for (const name of scripts) {
      for (const m of code(read(name)).matchAll(/\bimport\b[^'"]*['"]([^'"]+)['"]/g)) {
        expect(m[1], `${name} imports ${m[1]}`).toMatch(/^\.\/[a-z-]+\.js$/);
        expect(scripts, `${name} imports ${m[1]}`).toContain(m[1].slice(2));
      }
      expect(code(read(name)), name).not.toMatch(/\bimport\s*\(/); // no dynamic imports
    }
  });
});

describe('no way to turn text into markup or code', () => {
  const FORBIDDEN = [
    ['innerHTML', /\binnerHTML\b/],
    ['outerHTML', /\bouterHTML\b/],
    ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
    ['document.write', /\bdocument\s*\.\s*write(ln)?\b/],
    ['DOMParser', /\bDOMParser\b/],
    ['createContextualFragment', /\bcreateContextualFragment\b/],
    ['srcdoc', /\bsrcdoc\b/],
    ['eval', /\beval\s*\(/],
    ['new Function', /\bnew\s+Function\b/],
    ['Function(', /(^|[^.\w])Function\s*\(/],
    ['setTimeout with a string', /\bset(Timeout|Interval)\s*\(\s*['"`]/],
    ['createElement', /\bcreateElement(NS)?\b/],
    ['appendChild', /\b(appendChild|append|prepend|replaceWith|insertBefore)\s*\(/],
    ['javascript: URL', /javascript:/i],
  ];
  it.each(FORBIDDEN)('no script uses %s', (_name, pattern) => {
    for (const name of scripts) expect(code(read(name)), name).not.toMatch(pattern);
  });
});

describe('nothing is kept in the browser and nothing is sent anywhere else', () => {
  const FORBIDDEN = [
    ['localStorage', /\blocalStorage\b/],
    ['sessionStorage', /\bsessionStorage\b/],
    ['indexedDB', /\bindexedDB\b/],
    ['caches', /\bcaches\b/],
    ['cookieStore', /\bcookieStore\b/],
    ['document.cookie', /\bdocument\s*\.\s*cookie\b/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['WebSocket', /\bWebSocket\b/],
    ['EventSource', /\bEventSource\b/],
    ['sendBeacon', /\bsendBeacon\b/],
    ['serviceWorker', /\bserviceWorker\b/],
    ['window.open', /\bwindow\s*\.\s*open\b/],
    ['location assignment', /\blocation\s*(\.\s*(href|assign|replace)\s*)?=[^=]/],
    ['console', /\bconsole\s*\./],
    ['an absolute URL', /['"`]\s*(https?:)?\/\/[a-z0-9]/i],
    ['a URL with a scheme', /['"`](https?|wss?|ftp|data|blob):/i],
  ];
  it.each(FORBIDDEN)('no script uses %s', (_name, pattern) => {
    for (const name of scripts) {
      if (name === 'api-client.js' && _name === 'a URL with a scheme') continue;
      expect(code(read(name)), name).not.toMatch(pattern);
    }
  });

  it('the only requests are to the four account routes, by path', () => {
    const paths = new Set();
    for (const name of scripts) for (const m of code(read(name)).matchAll(/['"`](\/[^'"`\s]*)['"`]/g)) paths.add(m[1]);
    expect([...paths].sort()).toEqual(['/api/login', '/api/logout', '/api/me', '/api/register']);
  });
});

describe('the page', () => {
  const tags = [...html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)].map((m) => ({ name: m[1].toLowerCase(), attrs: m[2], text: m[0] }));
  const attr = (tag, name) => new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag.attrs)?.[1];

  it('is a complete, labelled document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/<html lang="[a-z-]+">/);
    expect(html).toMatch(/<meta charset="utf-8">/);
    expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1">/);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toMatch(/<noscript>[\s\S]*needs JavaScript[\s\S]*<\/noscript>/);
    expect(html).toMatch(/<h1>/);
    expect(html).toMatch(/<main>/);
  });

  it('has one script, a module, from the same address, and no inline code', () => {
    const scriptTags = tags.filter((t) => t.name === 'script');
    expect(scriptTags).toHaveLength(1);
    expect(attr(scriptTags[0], 'src')).toBe('/app.js');
    expect(attr(scriptTags[0], 'type')).toBe('module');
    expect(html).toMatch(/<script type="module" src="\/app\.js"><\/script>/);
    expect(html).not.toMatch(/<script[^>]*>\s*[^<\s]/); // nothing between the tags
  });

  it('has no inline style, no style element, and no event-handler attribute', () => {
    expect(tags.filter((t) => t.name === 'style')).toEqual([]);
    for (const t of tags) {
      expect(t.attrs, t.text).not.toMatch(/\sstyle\s*=/i);
      expect(t.attrs, t.text).not.toMatch(/\son[a-z]+\s*=/i);
    }
  });

  it('refers to nothing but files of the app by absolute path, plus the empty icon', () => {
    const served = new Set(['/app.js', '/style.css']);
    for (const t of tags) {
      for (const name of ['src', 'href', 'action', 'formaction', 'poster', 'data', 'srcset', 'ping', 'cite', 'longdesc']) {
        const value = attr(t, name);
        if (value === undefined) continue;
        expect(served.has(value) || value === 'data:,', `${t.name} ${name}="${value}"`).toBe(true);
      }
    }
    expect(tags.filter((t) => ['iframe', 'frame', 'object', 'embed', 'base', 'applet', 'meta'].includes(t.name) && t.name !== 'meta')).toEqual([]);
    expect(html).not.toMatch(/http-equiv/i);
  });

  it('every form is a post with browser validation off, so a failed script can never put a password in an address', () => {
    const forms = tags.filter((t) => t.name === 'form');
    expect(forms).toHaveLength(2);
    for (const f of forms) {
      expect(attr(f, 'method')).toBe('post');
      expect(f.attrs).toMatch(/\bnovalidate\b/);
      expect(attr(f, 'action')).toBeUndefined();
    }
  });

  it('starts with every screen hidden, so nothing shows without the script', () => {
    for (const id of ['screen-loading', 'screen-unreachable', 'screen-signed-out', 'screen-signed-in', 'signin-section', 'register-section']) {
      const tag = tags.find((t) => attr(t, 'id') === id);
      expect(tag, id).toBeDefined();
      expect(tag.attrs, id).toMatch(/\bhidden\b/);
    }
  });

  it('has unique ids, and every id and every aria-describedby reference points at something', () => {
    const ids = tags.map((t) => attr(t, 'id')).filter((id) => id !== undefined);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of tags) {
      for (const ref of (attr(t, 'aria-describedby') ?? '').split(/\s+/).filter(Boolean)) expect(ids, `${t.text} -> ${ref}`).toContain(ref);
      const forId = attr(t, 'for');
      if (forId !== undefined) expect(ids, `label for ${forId}`).toContain(forId);
    }
  });

  it('gives every field a visible label, a name and the right autocomplete value', () => {
    const labels = new Set(tags.filter((t) => t.name === 'label').map((t) => attr(t, 'for')));
    const inputs = tags.filter((t) => t.name === 'input');
    expect(inputs).toHaveLength(6);
    const expected = {
      'signin-username': ['text', 'username'],
      'signin-password': ['password', 'current-password'],
      'register-username': ['text', 'username'],
      'register-displayName': ['text', 'name'],
      'register-email': ['email', 'email'],
      'register-password': ['password', 'new-password'],
    };
    for (const input of inputs) {
      const id = attr(input, 'id');
      expect(labels.has(id), `${id} has a label`).toBe(true);
      expect(attr(input, 'name'), id).toBeTruthy();
      expect([attr(input, 'type'), attr(input, 'autocomplete')], id).toEqual(expected[id]);
    }
  });

  it('marks the places that report problems so they are announced, and lets the top message take the focus', () => {
    for (const id of ['signin-error', 'register-error']) {
      const tag = tags.find((t) => attr(t, 'id') === id);
      expect(attr(tag, 'role')).toBe('alert');
      expect(attr(tag, 'tabindex')).toBe('-1');
      expect(tag.attrs).toMatch(/\bhidden\b/);
    }
    for (const t of tags.filter((x) => /-(username|displayName|email|password)-error$/.test(attr(x, 'id') ?? ''))) expect(t.attrs, t.text).toMatch(/\bhidden\b/);
  });

  it('tells the person the first account becomes the administrator, and that the email is never mailed', () => {
    expect(html).toContain('The first account created on a new installation becomes the administrator.');
    expect(html).toContain('Nothing is ever sent to it.');
  });

  it('says the home page is temporary', () => {
    expect(html).toContain('This is a temporary home page.');
  });

  it('every button says whether it submits', () => {
    for (const b of tags.filter((t) => t.name === 'button')) expect(['button', 'submit'], b.text).toContain(attr(b, 'type'));
  });
});

describe('the style sheet', () => {
  it('imports nothing and loads nothing from anywhere', () => {
    const text = code(css);
    expect(text).not.toMatch(/@import/i);
    expect(text).not.toMatch(/url\s*\(/i);
    expect(text).not.toMatch(/@font-face/i);
    expect(text).not.toMatch(/https?:/i);
    expect(text).not.toMatch(/expression\s*\(|(^|[\s;{])behavior\s*:|-moz-binding/i);
  });

  it('follows the system theme, shows keyboard focus, respects reduced motion, and copes with a narrow window', () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/@media \(max-width: 20rem\)/);
    expect(css).toMatch(/\binput \{[^}]*min-height: 2\.75rem/); // a comfortable touch target
    expect(css).toMatch(/\bbutton \{[^}]*min-height: 2\.75rem/);
    expect(css).toMatch(/\[hidden\][^{]*\{[^}]*display: none !important/); // hidden really hides, whatever else sets display
  });

  it('says problems in words, not only in colour', () => {
    expect(css).toMatch(/\.error::before \{ content: "Problem: "/);
  });
});
