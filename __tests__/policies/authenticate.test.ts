'use strict';

import { resolveAuth } from '../../server/src/policies/authenticate';
import { isSafeLocalPath } from '../../server/src/controllers/oauth/authorize';
import { makeStrapi } from '../helpers/strapi-mock';

function setup(
  client: { scopes: string[] } | null,
  tokenScopes = ['strapi:content:read', 'strapi:content:write'],
  enabled: Record<string, boolean> = {}
) {
  const strapi = makeStrapi({
    config: { tools: { enabled } },
    services: {
      tokens: {
        verifyAccessToken: async () => ({
          sub: '1',
          clientId: 'cid',
          jti: 'j',
          exp: 0,
          scope: tokenScopes,
        }),
        revokeAllForUser: jest.fn(),
      },
      clients: { findActive: async () => client },
      permissions: { loadPrincipal: async () => ({ user: { id: 1 }, isSuperAdmin: false }) },
      'session-store': { closeForPrincipal: jest.fn() },
      'tool-registry': { list: () => [] },
    },
  });
  return resolveAuth(strapi, 'tok');
}

describe('resolveAuth', () => {
  it('rejects tokens of a disabled/deleted client immediately', async () => {
    await expect(setup(null)).rejects.toThrow('invalid_token');
  });

  it("narrows token scopes to the client's current grant", async () => {
    const auth = await setup({ scopes: ['strapi:content:read'] });
    expect(auth.scopes).toEqual(['strapi:content:read']);
  });

  it('drops publish/delete scopes unless their tools are enabled in config', async () => {
    const all = ['strapi:content:read', 'strapi:content:publish', 'strapi:content:delete'];
    const off = await setup({ scopes: all }, all);
    expect(off.scopes).toEqual(['strapi:content:read']);
    const on = await setup({ scopes: all }, all, { strapi_content_publish_entry: true });
    expect(on.scopes).toEqual(['strapi:content:read', 'strapi:content:publish']);
  });
});

describe('isSafeLocalPath', () => {
  it.each(['/admin', '/oauth/authorize?x=1'])('allows %s', (p) =>
    expect(isSafeLocalPath(p)).toBe(true)
  );
  it.each([
    'javascript:alert(1)',
    'https://evil.com',
    '//evil.com',
    '/\\evil.com',
    '',
    undefined,
    42,
  ])('rejects %s', (p) => expect(isSafeLocalPath(p)).toBe(false));
});
