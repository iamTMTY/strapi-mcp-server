'use strict';

import { redact } from '../../server/src/services/audit';

const PATTERNS = ['password', 'token', 'secret', 'authorization', 'cookie', 'apikey'];

describe('audit.redact — sensitive keys', () => {
  it('redacts a top-level "password" field', () => {
    expect(redact({ username: 'alice', password: 'hunter2' }, PATTERNS)).toEqual({
      username: 'alice',
      password: '[redacted]',
    });
  });

  it('redacts case-insensitively', () => {
    expect(redact({ Password: 'x', AUTH_TOKEN: 'y', CLIENT_SECRET: 'z' }, PATTERNS)).toEqual({
      Password: '[redacted]',
      AUTH_TOKEN: '[redacted]',
      CLIENT_SECRET: '[redacted]',
    });
  });

  it('redacts substring matches (e.g. refresh_token)', () => {
    expect(redact({ refresh_token: 'abc' }, PATTERNS)).toEqual({ refresh_token: '[redacted]' });
  });

  it('redacts authorization headers', () => {
    expect(redact({ authorization: 'Bearer xxx' }, PATTERNS)).toEqual({
      authorization: '[redacted]',
    });
  });

  it('redacts nested values', () => {
    expect(
      redact({ user: { name: 'alice', secret_key: 'shh' }, top: 'ok' }, PATTERNS)
    ).toEqual({ user: { name: 'alice', secret_key: '[redacted]' }, top: 'ok' });
  });

  it('redacts inside arrays of objects', () => {
    expect(redact([{ token: 't1' }, { token: 't2' }], PATTERNS)).toEqual([
      { token: '[redacted]' },
      { token: '[redacted]' },
    ]);
  });

  it('keeps non-sensitive fields untouched', () => {
    expect(redact({ name: 'alice', age: 30 }, PATTERNS)).toEqual({ name: 'alice', age: 30 });
  });
});

describe('audit.redact — structural safety', () => {
  it('handles null and primitives without throwing', () => {
    expect(redact(null, PATTERNS)).toBe(null);
    expect(redact(42, PATTERNS)).toBe(42);
    expect(redact('hello', PATTERNS)).toBe('hello');
    expect(redact(true, PATTERNS)).toBe(true);
  });

  it('truncates long strings at 2048 chars + ellipsis', () => {
    const big = 'a'.repeat(3000);
    const out = redact(big, PATTERNS) as string;
    expect(out.length).toBe(2049); // 2048 + 1 ellipsis char
    expect(out.endsWith('…')).toBe(true);
  });

  it('caps array length at 50 elements', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const out = redact(arr, PATTERNS) as number[];
    expect(out.length).toBe(50);
  });

  it('bounds recursion depth to avoid stack blowup', () => {
    // Build a 20-deep nested object — way past the 6-level limit.
    let nested: Record<string, unknown> = { leaf: 'deep' };
    for (let i = 0; i < 20; i++) nested = { wrap: nested };
    const out = redact(nested, PATTERNS);
    // Just assert that it returned without throwing and that something marks
    // truncation at some depth.
    const str = JSON.stringify(out);
    expect(str).toContain('[truncated:depth]');
  });
});
