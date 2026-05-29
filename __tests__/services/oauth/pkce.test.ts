'use strict';

import { createHash, randomBytes } from 'crypto';
import {
  base64url,
  isValidVerifier,
  s256Challenge,
  verifyS256,
} from '../../../server/src/services/oauth/pkce';

describe('pkce.isValidVerifier', () => {
  it('accepts a 43-char verifier', () => {
    expect(isValidVerifier('a'.repeat(43))).toBe(true);
  });

  it('accepts a 128-char verifier', () => {
    expect(isValidVerifier('A'.repeat(128))).toBe(true);
  });

  it('accepts all RFC 7636 unreserved characters', () => {
    const sample = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn-._~0123456789';
    expect(isValidVerifier(sample)).toBe(true);
  });

  it('rejects too short (42 chars)', () => {
    expect(isValidVerifier('a'.repeat(42))).toBe(false);
  });

  it('rejects too long (129 chars)', () => {
    expect(isValidVerifier('a'.repeat(129))).toBe(false);
  });

  it('rejects characters outside the unreserved set', () => {
    expect(isValidVerifier('a'.repeat(42) + '+')).toBe(false); // + is reserved
    expect(isValidVerifier('a'.repeat(42) + '/')).toBe(false);
    expect(isValidVerifier('a'.repeat(42) + '=')).toBe(false);
    expect(isValidVerifier('a'.repeat(42) + ' ')).toBe(false);
  });

  it('rejects empty / non-string', () => {
    expect(isValidVerifier('')).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isValidVerifier(undefined as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isValidVerifier(null as any)).toBe(false);
  });
});

describe('pkce.s256Challenge', () => {
  it('produces base64url(sha256(verifier))', () => {
    const verifier = 'abc' + 'd'.repeat(40);
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(s256Challenge(verifier)).toBe(expected);
  });

  it('is deterministic', () => {
    const v = randomBytes(48).toString('base64url').slice(0, 60);
    expect(s256Challenge(v)).toBe(s256Challenge(v));
  });
});

describe('pkce.verifyS256', () => {
  it('verifies a real PKCE pair', () => {
    const verifier = 'a'.repeat(43);
    const challenge = s256Challenge(verifier);
    expect(verifyS256(verifier, challenge)).toBe(true);
  });

  it('rejects mismatched verifier', () => {
    const challenge = s256Challenge('a'.repeat(43));
    expect(verifyS256('b'.repeat(43), challenge)).toBe(false);
  });

  it('rejects invalid verifier format outright (before computing)', () => {
    expect(verifyS256('short', s256Challenge('a'.repeat(43)))).toBe(false);
  });

  it('rejects challenge of mismatched length without throwing', () => {
    expect(verifyS256('a'.repeat(43), 'short-challenge')).toBe(false);
  });

  it('rejects garbage challenge', () => {
    expect(verifyS256('a'.repeat(43), '')).toBe(false);
  });
});

describe('pkce.base64url', () => {
  it('encodes a buffer without padding or +/', () => {
    const out = base64url(Buffer.from([0xff, 0xfe, 0xfd, 0xfc]));
    expect(out).not.toMatch(/[+/=]/);
    expect(Buffer.from(out, 'base64url').equals(Buffer.from([0xff, 0xfe, 0xfd, 0xfc]))).toBe(true);
  });
});
