import { describe, expect, it } from 'vitest';
import { checkRoutes, matchRoute, segmentsOf, type Route } from './router.js';

const ok = () => ({ status: 200 });
const routes: readonly Route[] = [
  { method: 'GET', path: '/api/me', handler: ok },
  { method: 'PATCH', path: '/api/me', handler: ok },
  { method: 'POST', path: '/api/login', handler: ok },
  { method: 'GET', path: '/api/users', handler: ok },
  { method: 'GET', path: '/api/users/:id', handler: ok },
  { method: 'DELETE', path: '/api/users/:id', handler: ok },
  { method: 'POST', path: '/api/users/:id/password', handler: ok },
];

describe('matchRoute', () => {
  it('finds the route and its parameters', () => {
    const m = matchRoute(routes, 'GET', '/api/users/u123');
    expect(m.kind).toBe('match');
    if (m.kind === 'match') {
      expect(m.route.path).toBe('/api/users/:id');
      expect({ ...m.params }).toEqual({ id: 'u123' });
      expect(Object.getPrototypeOf(m.params)).toBeNull();
    }
    const deep = matchRoute(routes, 'POST', '/api/users/u1/password');
    expect(deep.kind === 'match' && deep.params.id).toBe('u1');
  });

  it('says which methods would have worked when the method is wrong (405)', () => {
    expect(matchRoute(routes, 'POST', '/api/me')).toEqual({ kind: 'method', allow: ['GET', 'PATCH'] });
    expect(matchRoute(routes, 'PUT', '/api/users/u1')).toEqual({ kind: 'method', allow: ['GET', 'DELETE'] });
    expect(matchRoute(routes, 'GET', '/api/login')).toEqual({ kind: 'method', allow: ['POST'] });
    for (const odd of ['HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'get', '']) expect(matchRoute(routes, odd, '/api/me').kind).toBe('method');
  });

  it('finds nothing for an unknown path (404)', () => {
    for (const path of ['/', '/api', '/api/nothing', '/api/users/u1/extra', '/api/me/more', '/other']) expect(matchRoute(routes, 'GET', path), path).toEqual({ kind: 'none' });
  });

  it('is exact: case matters, a trailing slash is another path, and a prefix is not a match', () => {
    for (const path of ['/API/me', '/api/Me', '/api/me/', '/api/m', '/api/users/']) expect(matchRoute(routes, 'GET', path).kind, path).toBe('none');
  });

  it('refuses path tricks outright, so they are 404 and never reach a handler', () => {
    const tricks = [
      '/api/../api/me',
      '/api/./me',
      '/api//me',
      '/api/users/..',
      '/api/users/.',
      '/api/users/%2e%2e',
      '/api/users/%2F',
      '/api/users/u1%00',
      '/api/users/u1\u0000',
      '/api\\me',
      '/api/users/u 1',
      '/api/users/u1;x',
      '/api/users/u1?x=1',
      '/api/users/u1#frag',
      '/api/users/é',
      '//api/me',
      'api/me',
      '',
      '/api/users/' + 'a'.repeat(129),
      '/' + 'a/'.repeat(9) + 'a',
      '/api/' + 'x'.repeat(2000),
    ];
    for (const path of tricks) expect(matchRoute(routes, 'GET', path), JSON.stringify(path).slice(0, 60)).toEqual({ kind: 'none' });
  });

  it('a parameter never matches an inherited property name as a route would', () => {
    const m = matchRoute(routes, 'GET', '/api/users/__proto__');
    expect(m.kind).toBe('match');
    expect(m.kind === 'match' && Object.getPrototypeOf(m.params)).toBeNull();
    expect(matchRoute(routes, 'GET', '/api/constructor').kind).toBe('none');
    expect(matchRoute(routes, 'GET', '/api/toString').kind).toBe('none');
  });

  it('a literal segment is preferred in the order the routes are given', () => {
    const mixed: readonly Route[] = [
      { method: 'GET', path: '/api/users/me', handler: ok },
      { method: 'GET', path: '/api/users/:id', handler: ok },
    ];
    const m = matchRoute(mixed, 'GET', '/api/users/me');
    expect(m.kind === 'match' && m.route.path).toBe('/api/users/me');
  });
});

describe('segmentsOf', () => {
  it('splits a good path and refuses a bad one', () => {
    expect(segmentsOf('/api/me')).toEqual(['api', 'me']);
    expect(segmentsOf('/a.b/c-d/e_f/g~h')).toEqual(['a.b', 'c-d', 'e_f', 'g~h']);
    expect(segmentsOf('/')).toEqual([]); // the root, and only the root, has no segments
    expect(segmentsOf('//')).toBeUndefined();
    expect(segmentsOf(5 as never)).toBeUndefined();
    expect(segmentsOf('/' + Array.from({ length: 8 }, () => 'a').join('/'))).toHaveLength(8);
    expect(segmentsOf('/' + Array.from({ length: 9 }, () => 'a').join('/'))).toBeUndefined();
  });
});

describe('checkRoutes', () => {
  it('accepts a good set', () => {
    expect(() => checkRoutes(routes)).not.toThrow();
  });

  it('refuses a bad path, a bad parameter name, a repeated parameter and two routes for one shape', () => {
    const bad = (r: Partial<Route>[]) => () => checkRoutes(r.map((x) => ({ method: 'GET', path: '/x', handler: ok, ...x })) as Route[]);
    expect(bad([{ path: 'x' }])).toThrow(TypeError);
    expect(bad([{ path: '/a//b' }])).toThrow(TypeError);
    expect(bad([{ path: '/a b' }])).toThrow(TypeError);
    expect(bad([{ path: '/a/:1x' }])).toThrow(TypeError);
    expect(bad([{ path: '/a/:id/:id' }])).toThrow(TypeError);
    expect(bad([{ path: '/a/' }])).toThrow(TypeError);
    expect(bad([{ path: '/a/../b' }])).toThrow(TypeError);
    expect(bad([{ path: '/./b' }])).toThrow(TypeError);
    expect(bad([{ path: '/a/:id.js' }])).toThrow(TypeError);
    expect(bad([{ path: '/' }, { path: '/app.js' }, { path: '/style.v2.css' }])).not.toThrow();
    expect(bad([{ path: '/a/:id' }, { path: '/a/:other' }])).toThrow(/two routes/);
    expect(bad([{ path: '/a/:id' }, { path: '/a/:id', method: 'POST' }])).not.toThrow();
  });
});
