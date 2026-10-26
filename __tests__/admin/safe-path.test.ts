'use strict';

import { isSafeLocalPath } from '../../admin/src/lib/safePath';

const ORIGIN = 'https://cms.example';

describe('admin isSafeLocalPath (SSO bridge)', () => {
  it.each([
    '/admin',
    '/admin/settings',
    '/oauth/authorize?client_id=x&redirect_uri=https%3A%2F%2Fa',
  ])('allows %s', (p) => expect(isSafeLocalPath(p, ORIGIN)).toBe(true));

  it.each([
    'javascript:alert(1)',
    'https://evil.com',
    '//evil.com',
    '/\\evil.com',
    // Each of these resolves to evil.com in a browser (tab/newline dropped, `\` read as `/`).
    '/\t/evil.com',
    '/\n/evil.com',
    '/\r/evil.com',
    '/\t\\evil.com',
    '/a\\b',
    '/\u0000x',
    '',
    undefined,
    42,
  ])('rejects %j', (p) => expect(isSafeLocalPath(p, ORIGIN)).toBe(false));

  it('those payloads really are cross-origin once resolved', () => {
    for (const p of ['/\t/evil.com', '/\n/evil.com', '/\t\\evil.com']) {
      expect(new URL(p, ORIGIN).host).toBe('evil.com');
    }
  });
});
