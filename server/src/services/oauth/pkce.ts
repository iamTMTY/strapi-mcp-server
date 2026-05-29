'use strict';

import { createHash, timingSafeEqual } from 'crypto';

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function base64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

/** RFC 7636 §4.1 — code_verifier charset and length. */
export function isValidVerifier(verifier: string): boolean {
  return typeof verifier === 'string' && VERIFIER_RE.test(verifier);
}

/** SHA-256(code_verifier) → base64url. Only S256 is supported (plain is rejected upstream). */
export function s256Challenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/**
 * Constant-time comparison of the S256-hashed verifier against the stored
 * challenge. Inputs must be base64url strings; mismatched lengths fail fast.
 */
export function verifyS256(verifier: string, storedChallenge: string): boolean {
  if (!isValidVerifier(verifier)) return false;
  const computed = s256Challenge(verifier);
  if (computed.length !== storedChallenge.length) return false;
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(storedChallenge));
  } catch {
    return false;
  }
}
