'use strict';

import originPolicy from '../../server/src/policies/origin';
import { makeStrapi } from '../helpers/strapi-mock';
import { errors } from '@strapi/utils';

function ctx(headers: Record<string, string | undefined>): {
  request: { header: Record<string, string | undefined>; url?: string; method?: string };
  response: { set: jest.Mock };
} {
  return {
    request: { header: headers, url: '/mcp', method: 'POST' },
    response: { set: jest.fn() },
  };
}

describe('origin policy — Origin header', () => {
  const strapi = makeStrapi({
    config: { allowedOrigins: ['http://localhost:1337', 'https://app.example.com'] },
  });

  it('accepts an Origin in the allowlist', () => {
    expect(originPolicy(ctx({ origin: 'http://localhost:1337' }), {}, { strapi })).toBe(true);
  });

  it('rejects an Origin not in the allowlist', () => {
    expect(() =>
      originPolicy(ctx({ origin: 'http://evil.example.com' }), {}, { strapi })
    ).toThrow(errors.ForbiddenError);
  });

  it('accepts second-listed origin', () => {
    expect(originPolicy(ctx({ origin: 'https://app.example.com' }), {}, { strapi })).toBe(true);
  });
});

describe('origin policy — Host fallback (no Origin)', () => {
  const strapi = makeStrapi({
    config: {
      resourceUrl: 'https://cms.example.com/mcp',
      allowedOrigins: ['https://cms.example.com'],
    },
  });

  it('accepts when Host matches resourceUrl host', () => {
    expect(originPolicy(ctx({ host: 'cms.example.com' }), {}, { strapi })).toBe(true);
  });

  it('rejects when Host does not match', () => {
    expect(() =>
      originPolicy(ctx({ host: 'other.example.com' }), {}, { strapi })
    ).toThrow(errors.ForbiddenError);
  });

  it('rejects when both Origin and Host are missing', () => {
    expect(() => originPolicy(ctx({}), {}, { strapi })).toThrow(errors.ForbiddenError);
  });
});

describe('origin policy — wildcard', () => {
  it('accepts everything when allowedOrigins contains "*"', () => {
    const strapi = makeStrapi({ config: { allowedOrigins: ['*'] } });
    expect(originPolicy(ctx({ origin: 'http://anywhere.example.com' }), {}, { strapi })).toBe(true);
    expect(originPolicy(ctx({}), {}, { strapi })).toBe(true);
  });
});

describe('origin policy — empty allowlist', () => {
  it('rejects everything (default-deny)', () => {
    const strapi = makeStrapi({ config: { allowedOrigins: [] } });
    expect(() =>
      originPolicy(ctx({ origin: 'http://localhost:1337' }), {}, { strapi })
    ).toThrow(errors.ForbiddenError);
  });
});
