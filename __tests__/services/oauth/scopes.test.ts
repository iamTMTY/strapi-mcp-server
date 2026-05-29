'use strict';

import {
  ALL_SCOPES,
  parseScope,
  scopeString,
  isSubsetOf,
  hasScope,
} from '../../../server/src/services/oauth/scopes';

describe('parseScope', () => {
  it('parses a single scope', () => {
    expect(parseScope('strapi:content:read')).toEqual(['strapi:content:read']);
  });

  it('parses space-separated scopes', () => {
    expect(parseScope('strapi:content:read strapi:media:write')).toEqual([
      'strapi:content:read',
      'strapi:media:write',
    ]);
  });

  it('tolerates extra whitespace', () => {
    expect(parseScope('  strapi:content:read   strapi:media:read  ')).toEqual([
      'strapi:content:read',
      'strapi:media:read',
    ]);
  });

  it('drops unknown scopes silently', () => {
    expect(parseScope('strapi:content:read garbage:scope')).toEqual([
      'strapi:content:read',
    ]);
  });

  it('deduplicates', () => {
    expect(parseScope('strapi:content:read strapi:content:read')).toEqual([
      'strapi:content:read',
    ]);
  });

  it('returns [] for non-string input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseScope(undefined as any)).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseScope(null as any)).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseScope(42 as any)).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseScope(['strapi:content:read'] as any)).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(parseScope('')).toEqual([]);
    expect(parseScope('   ')).toEqual([]);
  });
});

describe('scopeString', () => {
  it('joins scopes alphabetically', () => {
    expect(scopeString(['strapi:media:write', 'strapi:content:read'])).toBe(
      'strapi:content:read strapi:media:write'
    );
  });

  it('deduplicates', () => {
    expect(scopeString(['strapi:content:read', 'strapi:content:read'])).toBe(
      'strapi:content:read'
    );
  });

  it('returns empty string for empty input', () => {
    expect(scopeString([])).toBe('');
  });
});

describe('isSubsetOf', () => {
  it('true when requested is subset of allowed', () => {
    expect(
      isSubsetOf(['strapi:content:read'], ['strapi:content:read', 'strapi:media:read'])
    ).toBe(true);
  });

  it('true when equal', () => {
    expect(isSubsetOf([...ALL_SCOPES], [...ALL_SCOPES])).toBe(true);
  });

  it('false when requested has an extra scope', () => {
    expect(
      isSubsetOf(['strapi:content:read', 'strapi:media:write'], ['strapi:content:read'])
    ).toBe(false);
  });

  it('true for empty requested', () => {
    expect(isSubsetOf([], ['strapi:content:read'])).toBe(true);
  });
});

describe('hasScope', () => {
  it('true when granted contains required', () => {
    expect(hasScope(['strapi:content:read', 'strapi:media:read'], 'strapi:content:read')).toBe(
      true
    );
  });

  it('false when missing', () => {
    expect(hasScope(['strapi:content:read'], 'strapi:content:write')).toBe(false);
  });
});
