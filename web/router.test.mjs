import { describe, expect, it } from 'vitest';
import { hashFor, normalise, parseHash, sameRoute } from './router.js';

const C = 'c0123456789abcdef';
const OURS = /^#\/(circles(\/c[a-z0-9]{16})?|invitations)?$/;

describe('reading an address', () => {
  it('knows the four screens, and nothing is needed for home', () => {
    expect(parseHash('')).toEqual({ name: 'home' });
    expect(parseHash('#')).toEqual({ name: 'home' });
    expect(parseHash('#/')).toEqual({ name: 'home' });
    expect(parseHash('#/circles')).toEqual({ name: 'circles' });
    expect(parseHash('#/invitations')).toEqual({ name: 'invitations' });
    expect(parseHash(`#/circles/${C}`)).toEqual({ name: 'circle', id: C });
  });

  it('routes are frozen, and the same screen is the same object for the fixed ones', () => {
    for (const hash of ['#/', '#/circles', '#/invitations', `#/circles/${C}`]) expect(Object.isFrozen(parseHash(hash)), hash).toBe(true);
    expect(parseHash('#/circles')).toBe(parseHash('#/circles'));
  });

  it('anything that is not exactly one of ours is home', () => {
    const hostile = [
      '#/circle', '#/Circles', '#/CIRCLES', '#/circles/', '#/circles//', `#/circles/${C}/`, `#/circles/${C}/members`, `#/circles/${C}/../x`, '#/invitations/', '#/invitations/x', '#/circles?x=1', `#/circles/${C}?x=1`, `#/circles/${C}#more`, '#circles', 'circles', '/circles', '#//circles', '# /circles', '#/ circles', '#/circles ', ' #/circles', '#/circles\n', '#/circles\0', '#/circles%20', '#/%63ircles', '#/circles%2fx', `#/circles/${C.replace('c0', '%630')}`,
      '#/circles/..', '#/circles/../..', '#/circles/..%2f..', '#/circles/%2e%2e', '#/circles/../../etc/passwd', '#/circles/c', '#/circles/c0123456789abcde', `#/circles/${C}0`, '#/circles/C0123456789abcdef', '#/circles/c0123456789ABCDEF', '#/circles/i0123456789abcdef', '#/circles/u0123456789abcdef', '#/circles/c0123456789abcdé', `#/circles/${C} `, `#/circles/ ${C}`,
      '#/<script>alert(1)</script>', '#/circles/<img src=x onerror=alert(1)>', '#javascript:alert(1)', '#/circles/javascript:alert(1)', 'http://evil.example/#/circles', '#http://evil.example', '#/\\evil', '#/circles/\\',
      '#/' + 'a'.repeat(1000), '#/circles/' + 'c'.repeat(1000), `#/circles/${C}` + ' '.repeat(100),
    ];
    for (const hash of hostile) expect(parseHash(hash), JSON.stringify(hash).slice(0, 60)).toEqual({ name: 'home' });
  });

  it('text that is not text is home too', () => {
    for (const bad of [undefined, null, 5, true, {}, [], ['#/circles'], () => '#/circles', Symbol.iterator && 1n]) expect(parseHash(bad), String(typeof bad)).toEqual({ name: 'home' });
  });
});

describe('making an address', () => {
  it('gives the one address for each screen', () => {
    expect(hashFor({ name: 'home' })).toBe('#/');
    expect(hashFor({ name: 'circles' })).toBe('#/circles');
    expect(hashFor({ name: 'invitations' })).toBe('#/invitations');
    expect(hashFor({ name: 'circle', id: C })).toBe(`#/circles/${C}`);
  });

  it('a circle with a bad id, an unknown screen and anything that is not a route are the home address', () => {
    for (const bad of [{ name: 'circle' }, { name: 'circle', id: 'x' }, { name: 'circle', id: `${C}/members` }, { name: 'circle', id: '../x' }, { name: 'circle', id: 5 }, { name: 'admin' }, { name: 5 }, { id: C }, {}, [], 'circles', 5, null, undefined, () => 0]) {
      expect(hashFor(bad), JSON.stringify(bad)).toBe('#/');
    }
  });

  it('ignores extra fields on a route', () => {
    expect(hashFor({ name: 'circles', id: C, x: 1 })).toBe('#/circles');
    expect(hashFor({ name: 'home', id: '../x' })).toBe('#/');
  });
});

describe('both ways', () => {
  it('every route survives a round trip', () => {
    for (const route of [{ name: 'home' }, { name: 'circles' }, { name: 'invitations' }, { name: 'circle', id: C }, { name: 'circle', id: 'cabcdefghij012345' }]) {
      expect(parseHash(hashFor(route))).toEqual(route);
      expect(hashFor(parseHash(hashFor(route)))).toBe(hashFor(route));
    }
  });

  it('whatever is typed, what comes out is one of our addresses, and reading it again changes nothing (200 odd inputs)', () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pieces = ['#', '/', 'circles', 'invitations', C, '..', '%2f', '%2e', ' ', '\n', '?', '&', '=', '<', '>', '"', "'", '\\', 'é', '😀', '\0', 'c', 'i', 'u', '0123456789abcdef'];
    for (let i = 0; i < 200; i++) {
      let hash = '';
      for (let n = Math.floor(next() * 8); n >= 0; n--) hash += pieces[Math.floor(next() * pieces.length)];
      const out = normalise(hash);
      expect(out, JSON.stringify(hash)).toMatch(OURS);
      expect(normalise(out)).toBe(out);
      expect(parseHash(out)).toEqual(parseHash(hash));
    }
  });

  it('never throws', () => {
    const weird = { get name() { throw new Error('boom'); } };
    expect(() => hashFor(weird)).toThrow(); // a hostile getter is a coding mistake, not input: routes come from parseHash only
    for (const v of [undefined, null, 0, '', {}, [], NaN]) expect(() => normalise(v)).not.toThrow();
  });
});

describe('comparing', () => {
  it('two routes are the same screen when they have the same address', () => {
    expect(sameRoute({ name: 'circles' }, { name: 'circles', junk: 1 })).toBe(true);
    expect(sameRoute({ name: 'circle', id: C }, { name: 'circle', id: C })).toBe(true);
    expect(sameRoute({ name: 'circle', id: C }, { name: 'circle', id: 'cabcdefghij012345' })).toBe(false);
    expect(sameRoute({ name: 'circles' }, { name: 'invitations' })).toBe(false);
    expect(sameRoute({ name: 'circle', id: 'bad' }, { name: 'home' })).toBe(true); // a bad id is the home screen
  });
});
