'use strict';

import {
  canonicalResourceUrl,
  authorizationServerUrl,
  audienceMatches,
} from '../../../server/src/services/oauth/audience';
import { makeStrapi } from '../../helpers/strapi-mock';

describe('oauth/audience', () => {
  it('canonicalResourceUrl returns the configured resourceUrl', () => {
    const strapi = makeStrapi({ config: { resourceUrl: 'http://localhost:1337/mcp' } });
    expect(canonicalResourceUrl(strapi)).toBe('http://localhost:1337/mcp');
  });

  it('authorizationServerUrl is origin of resource URL (no path)', () => {
    const strapi = makeStrapi({
      config: { resourceUrl: 'https://cms.example.com/mcp' },
    });
    expect(authorizationServerUrl(strapi)).toBe('https://cms.example.com');
  });

  it('authorizationServerUrl preserves port', () => {
    const strapi = makeStrapi({
      config: { resourceUrl: 'http://localhost:1337/mcp' },
    });
    expect(authorizationServerUrl(strapi)).toBe('http://localhost:1337');
  });

  it('audienceMatches: exact string match', () => {
    const strapi = makeStrapi({ config: { resourceUrl: 'http://localhost:1337/mcp' } });
    expect(audienceMatches(strapi, 'http://localhost:1337/mcp')).toBe(true);
    expect(audienceMatches(strapi, 'http://localhost:1337/mcp/')).toBe(false);
    expect(audienceMatches(strapi, 'http://localhost:1337')).toBe(false);
  });

  it('audienceMatches: rejects non-strings', () => {
    const strapi = makeStrapi();
    expect(audienceMatches(strapi, undefined)).toBe(false);
    expect(audienceMatches(strapi, null)).toBe(false);
    expect(audienceMatches(strapi, ['http://localhost:1337/mcp'])).toBe(false);
  });
});
