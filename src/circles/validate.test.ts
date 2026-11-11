import { describe, expect, it } from 'vitest';
import { circlesError, CIRCLES_ERROR_CODES } from './errors.js';
import { isCircleId, isInvitationId, isJoinLinkId, isJoinRequestId, isWellFormedJoinToken, newCircleId, newInvitationId, newJoinLinkId, newJoinRequestId, newJoinToken } from './ids.js';
import { isCircleRole, CIRCLE_ROLES } from './types.js';
import { parseCircleDescription, parseCircleName, parseCreateCircle, parseCreateJoinLink, parseInvite, parseJoinToken, parseRole, parseRoleChange, parseUpdateCircle } from './validate.js';

const bad = (r: { ok: boolean; error?: unknown }): { code: string; field?: string; message: string } => {
  expect(r.ok).toBe(false);
  return r.error as { code: string; field?: string; message: string };
};
const good = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok).toBe(true);
  return r.value as T;
};
const chr = String.fromCharCode;

describe('errors', () => {
  it('are a closed set with the codes of the spec', () => {
    expect([...CIRCLES_ERROR_CODES].sort()).toEqual(['CONFLICT', 'FORBIDDEN', 'INVALID_INPUT', 'LAST_OWNER', 'LIMIT_REACHED', 'NOT_FOUND', 'STORAGE_ERROR', 'THROTTLED', 'UNAUTHENTICATED']);
  });
  it('are frozen and carry a field or a wait only when given', () => {
    const plain = circlesError('NOT_FOUND', 'x');
    expect(Object.isFrozen(plain)).toBe(true);
    expect(Object.keys(plain)).toEqual(['code', 'message']);
    expect(circlesError('INVALID_INPUT', 'x', { field: 'name' })).toEqual({ code: 'INVALID_INPUT', message: 'x', field: 'name' });
    expect(circlesError('THROTTLED', 'x', { retryAfterMs: 5 })).toEqual({ code: 'THROTTLED', message: 'x', retryAfterMs: 5 });
  });
});

describe('roles', () => {
  it('are exactly the four, with names that say nothing about any setting', () => {
    expect([...CIRCLE_ROLES]).toEqual(['owner', 'manager', 'member', 'observer']);
    expect(CIRCLE_ROLES.join(' ')).not.toMatch(/carer|patient|family|teacher|student|admin/i);
  });
  it('are recognised only when they are exactly one of them', () => {
    for (const r of CIRCLE_ROLES) expect(isCircleRole(r)).toBe(true);
    for (const r of ['Owner', 'owner ', 'admin', '', 'toString', '__proto__', 5, null, undefined, {}, ['owner']]) expect(isCircleRole(r), String(r)).toBe(false);
    expect(parseRole('owner')).toEqual({ ok: true, value: 'owner' });
    expect(bad(parseRole('boss'))).toMatchObject({ code: 'INVALID_INPUT', field: 'role' });
    expect(bad(parseRole('boss', 'other'))).toMatchObject({ field: 'other' });
  });
});

describe('ids', () => {
  it('a circle id is c and 16, an invitation id is i and 16, and each is only its own kind', () => {
    const c = newCircleId();
    const i = newInvitationId();
    expect(c).toMatch(/^c[a-z0-9]{16}$/);
    expect(i).toMatch(/^i[a-z0-9]{16}$/);
    expect(isCircleId(c) && !isInvitationId(c)).toBe(true);
    expect(isInvitationId(i) && !isCircleId(i)).toBe(true);
    expect(isCircleId('u3k9d2x7q0m5a1bz7')).toBe(false);
  });
  it('are unbiased and take the random source given', () => {
    expect(newCircleId(() => new Uint8Array(32).fill(1))).toBe('c' + '1'.repeat(16));
    expect(newInvitationId(() => new Uint8Array(32).fill(10))).toBe('i' + 'a'.repeat(16));
    expect(new Set(Array.from({ length: 200 }, () => newCircleId())).size).toBe(200);
  });
  it('are recognised strictly', () => {
    for (const v of ['', 'c', 'cABCDEFGHIJKLMNOP', 'c' + 'a'.repeat(15), 'c' + 'a'.repeat(17), ' c' + 'a'.repeat(16), 'c' + 'a'.repeat(16) + '\n', 5, null, undefined]) expect(isCircleId(v), String(v)).toBe(false);
    expect(isCircleId('c' + 'a'.repeat(16))).toBe(true);
    expect(isInvitationId('i' + '0'.repeat(16))).toBe(true);
  });
});

describe('circle name and description', () => {
  it('a name is 1 to 80 characters once trimmed', () => {
    expect(good(parseCircleName('  Book club  '))).toBe('Book club');
    expect(good(parseCircleName('x'.repeat(80)))).toHaveLength(80);
    expect(bad(parseCircleName('x'.repeat(81))).field).toBe('name');
    for (const v of ['', '   ', 5, null, undefined, {}]) expect(bad(parseCircleName(v)).field, String(v)).toBe('name');
  });
  it('counts characters, not UTF-16 units', () => {
    expect(good(parseCircleName('😀'.repeat(80)))).toHaveLength(160);
    expect(bad(parseCircleName('😀'.repeat(81))).field).toBe('name');
  });
  it('refuses control characters, separators and the byte order mark in a name', () => {
    for (const code of [0, 9, 10, 13, 0x1f, 0x7f, 0x85, 0x9f, 0x2028, 0x2029, 0xfeff]) expect(bad(parseCircleName(`a${chr(code)}b`)).field, String(code)).toBe('name');
  });
  it('a description is optional, trimmed, at most 500, and may hold new lines and tabs', () => {
    expect(good(parseCircleDescription(undefined))).toBeUndefined();
    expect(good(parseCircleDescription('  hello  '))).toBe('hello');
    expect(good(parseCircleDescription('   '))).toBeUndefined();
    expect(good(parseCircleDescription('line one\nline two\tend'))).toBe('line one\nline two\tend');
    expect(good(parseCircleDescription('x'.repeat(500)))).toHaveLength(500);
    expect(bad(parseCircleDescription('x'.repeat(501))).field).toBe('description');
    expect(bad(parseCircleDescription(5)).field).toBe('description');
    expect(bad(parseCircleDescription(null)).field).toBe('description');
    for (const code of [0, 13, 0x1f, 0x7f, 0x2028, 0xfeff]) expect(bad(parseCircleDescription(`a${chr(code)}b`)).field, String(code)).toBe('description');
  });
});

describe('the inputs', () => {
  it('create takes a name and an optional description and nothing else', () => {
    expect(good(parseCreateCircle({ name: ' Team ' }))).toEqual({ name: 'Team' });
    expect(good(parseCreateCircle({ name: 'Team', description: 'About us' }))).toEqual({ name: 'Team', description: 'About us' });
    expect(Object.isFrozen(good(parseCreateCircle({ name: 'Team' })))).toBe(true);
    expect(bad(parseCreateCircle({ name: 'Team', owner: 'x' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'owner' });
    expect(bad(parseCreateCircle({ name: 'Team', id: 'c1' })).field).toBe('id');
    expect(bad(parseCreateCircle({})).field).toBe('name');
    for (const v of [null, undefined, 'x', 5, [], [{ name: 'a' }]]) expect(bad(parseCreateCircle(v)).field, String(v)).toBe('body');
  });
  it('a class instance, or an object with another prototype, is not a plain object', () => {
    expect(bad(parseCreateCircle(new Date())).field).toBe('body');
    expect(bad(parseCreateCircle(Object.create({ name: 'x' }))).field).toBe('body');
    expect(good(parseCreateCircle(Object.assign(Object.create(null), { name: 'x' })))).toEqual({ name: 'x' });
  });
  it('a hostile key is refused by name and the message is cut', () => {
    const hostile = JSON.parse('{"name":"a","__proto__x":1}');
    expect(bad(parseCreateCircle(hostile)).field).toBe('__proto__x');
    const long = bad(parseCreateCircle({ name: 'a', ['k'.repeat(100)]: 1 }));
    expect(long.message.length).toBeLessThan(80);
  });
  it('update needs at least one change; a null or empty description removes it', () => {
    expect(bad(parseUpdateCircle({})).field).toBe('body');
    expect(good(parseUpdateCircle({ name: ' New ' }))).toEqual({ name: 'New' });
    expect(good(parseUpdateCircle({ description: null }))).toEqual({ description: null });
    expect(good(parseUpdateCircle({ description: '  ' }))).toEqual({ description: null });
    expect(good(parseUpdateCircle({ name: 'A', description: 'B' }))).toEqual({ name: 'A', description: 'B' });
    expect(bad(parseUpdateCircle({ name: '' })).field).toBe('name');
    expect(bad(parseUpdateCircle({ description: 5 })).field).toBe('description');
    expect(bad(parseUpdateCircle({ name: null })).field).toBe('name');
    expect(bad(parseUpdateCircle({ role: 'owner' })).field).toBe('role');
  });
  it('invite takes a username and a role, lower-cases the name and checks only its shape', () => {
    expect(good(parseInvite({ username: 'Bob', role: 'member' }))).toEqual({ username: 'bob', role: 'member' });
    expect(bad(parseInvite({ username: 'b', role: 'member' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'username' });
    expect(bad(parseInvite({ username: 'has space', role: 'member' })).field).toBe('username');
    expect(bad(parseInvite({ username: 'bob', role: 'admin' })).field).toBe('role');
    expect(bad(parseInvite({ username: 'bob' })).field).toBe('role');
    expect(bad(parseInvite({ role: 'member' })).field).toBe('username');
    expect(bad(parseInvite({ username: 'bob', role: 'member', email: 'x' })).field).toBe('email');
    expect(bad(parseInvite({ username: 5, role: 'member' })).field).toBe('username');
  });
  it('a role change takes a role and nothing else', () => {
    expect(good(parseRoleChange({ role: 'observer' }))).toBe('observer');
    expect(bad(parseRoleChange({})).field).toBe('role');
    expect(bad(parseRoleChange({ role: 'observer', userId: 'u1' })).field).toBe('userId');
    expect(bad(parseRoleChange('observer')).field).toBe('body');
  });
  it('a join link takes a label and the defaults of R-023: observer, 7 days, one use, approval on', () => {
    expect(good(parseCreateJoinLink({ label: ' Club ' }))).toEqual({ label: 'Club', role: 'observer', days: 7, uses: 1, approval: true });
    expect(good(parseCreateJoinLink({ label: 'x', role: 'member', days: 30, uses: 100, approval: false }))).toEqual({ label: 'x', role: 'member', days: 30, uses: 100, approval: false });
    expect(good(parseCreateJoinLink({ label: 'x', days: 1, uses: 1 }))).toMatchObject({ days: 1, uses: 1 });
  });
  it('a join link never offers owner or manager, whatever is asked', () => {
    for (const role of ['owner', 'manager', 'admin', '', null, 5]) expect(bad(parseCreateJoinLink({ label: 'x', role })).field, String(role)).toBe('role');
  });
  it('a join link\'s days and uses are whole numbers within their ranges, at the edges', () => {
    for (const days of [0, -1, 31, 1.5, '7', null, Number.NaN]) expect(bad(parseCreateJoinLink({ label: 'x', days })).field, `days ${String(days)}`).toBe('days');
    for (const uses of [0, -1, 101, 2.5, '1', null]) expect(bad(parseCreateJoinLink({ label: 'x', uses })).field, `uses ${String(uses)}`).toBe('uses');
    expect(bad(parseCreateJoinLink({ label: 'x', approval: 'yes' })).field).toBe('approval');
    expect(bad(parseCreateJoinLink({ label: 'x', approval: null })).field).toBe('approval');
  });
  it('a join link\'s label is 1 to 80 characters, counted as characters, without control characters', () => {
    for (const label of [undefined, null, 5, '', '   ', 'x'.repeat(81), '\u0001a', 'a\nb']) expect(bad(parseCreateJoinLink({ label })).field, String(label)).toBe('label');
    expect(good(parseCreateJoinLink({ label: 'x'.repeat(80) })).label).toHaveLength(80);
    expect(good(parseCreateJoinLink({ label: '😀'.repeat(80) })).label).toBe('😀'.repeat(80));
  });
  it('a join link takes only its own fields, and a join takes only a token that is text', () => {
    expect(bad(parseCreateJoinLink({ label: 'x', circleId: 'c1' })).field).toBe('circleId');
    expect(bad(parseCreateJoinLink({ label: 'x', token: 'y' })).field).toBe('token');
    expect(bad(parseCreateJoinLink('x')).field).toBe('body');
    expect(good(parseJoinToken({ token: 'anything at all' }))).toBe('anything at all');
    expect(bad(parseJoinToken({ token: 5 })).field).toBe('token');
    expect(bad(parseJoinToken({})).field).toBe('token');
    expect(bad(parseJoinToken({ token: 'x', circleId: 'c' })).field).toBe('circleId');
    expect(bad(parseJoinToken(null)).field).toBe('body');
  });
  it('join ids and tokens have exactly the shapes this service makes', () => {
    expect(isJoinLinkId(newJoinLinkId())).toBe(true);
    expect(isJoinRequestId(newJoinRequestId())).toBe(true);
    expect(isJoinLinkId(newJoinRequestId())).toBe(false);
    expect(isJoinRequestId(newJoinLinkId())).toBe(false);
    for (const odd of ['', 'j', 'jABCDEFGHIJKLMNOP', 'j0000000000000000x', 5, null]) expect(isJoinLinkId(odd), String(odd)).toBe(false);
    const token = newJoinToken();
    expect(token).toMatch(/^cjoin_[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedJoinToken(token)).toBe(true);
    expect(newJoinToken()).not.toBe(token);
    for (const odd of ['', 'cjoin_', `cjoin_${'A'.repeat(42)}`, `cjoin_${'A'.repeat(44)}`, `cpat_${token.slice(6)}`, token.slice(6), `${token} `, `${token}\n`, 5, null, undefined]) expect(isWellFormedJoinToken(odd), String(odd)).toBe(false);
    expect(isWellFormedJoinToken(`cjoin_${'B'.repeat(43)}`)).toBe(false); // a second spelling of the same bytes
  });
});
