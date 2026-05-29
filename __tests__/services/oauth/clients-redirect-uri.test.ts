'use strict';

import clientsFactory from '../../../server/src/services/oauth/clients';
import type { ClientRecord } from '../../../server/src/services/oauth/clients';
import { makeStrapi } from '../../helpers/strapi-mock';

function client(redirectUris: string[]): ClientRecord {
  return {
    id: 1,
    clientId: 'cid',
    clientName: 'test',
    clientSecretHash: null,
    isConfidential: false,
    redirectUris,
    grantTypes: ['authorization_code', 'refresh_token'],
    scopes: ['strapi:content:read'],
    tokenEndpointAuthMethod: 'none',
    ownerAdminId: null,
    createdByAdminId: null,
    disabled: false,
    createdAt: null,
    lastUsedAt: null,
  };
}

const svc = clientsFactory({ strapi: makeStrapi() });

describe('clients.isAllowedRedirectUri — exact match (non-loopback)', () => {
  it('accepts exact-match HTTPS URL', () => {
    const c = client(['https://app.example.com/callback']);
    expect(svc.isAllowedRedirectUri(c, 'https://app.example.com/callback')).toBe(true);
  });

  it('rejects different path', () => {
    const c = client(['https://app.example.com/callback']);
    expect(svc.isAllowedRedirectUri(c, 'https://app.example.com/other')).toBe(false);
  });

  it('rejects different host', () => {
    const c = client(['https://app.example.com/callback']);
    expect(svc.isAllowedRedirectUri(c, 'https://evil.example.com/callback')).toBe(false);
  });

  it('rejects different scheme', () => {
    const c = client(['https://app.example.com/callback']);
    expect(svc.isAllowedRedirectUri(c, 'http://app.example.com/callback')).toBe(false);
  });

  it('rejects different port on non-loopback host', () => {
    const c = client(['https://app.example.com:443/callback']);
    expect(svc.isAllowedRedirectUri(c, 'https://app.example.com:8443/callback')).toBe(false);
  });
});

describe('clients.isAllowedRedirectUri — loopback leniency', () => {
  it('accepts any loopback port when stored URI omits a port', () => {
    const c = client(['http://localhost/callback']);
    expect(svc.isAllowedRedirectUri(c, 'http://localhost:33418/callback')).toBe(true);
    expect(svc.isAllowedRedirectUri(c, 'http://localhost:42791/callback')).toBe(true);
    expect(svc.isAllowedRedirectUri(c, 'http://localhost:60001/callback')).toBe(true);
  });

  it('accepts any loopback port when stored URI has a specific port', () => {
    const c = client(['http://localhost:33418/callback']);
    expect(svc.isAllowedRedirectUri(c, 'http://localhost:42791/callback')).toBe(true);
  });

  it('treats localhost / 127.0.0.1 / [::1] as equivalent', () => {
    const c1 = client(['http://localhost/callback']);
    const c2 = client(['http://127.0.0.1/callback']);
    const c3 = client(['http://[::1]/callback']);
    expect(svc.isAllowedRedirectUri(c1, 'http://127.0.0.1:42000/callback')).toBe(true);
    expect(svc.isAllowedRedirectUri(c2, 'http://localhost:42000/callback')).toBe(true);
    expect(svc.isAllowedRedirectUri(c3, 'http://localhost:42000/callback')).toBe(true);
  });

  it('still requires path to match', () => {
    const c = client(['http://localhost/callback']);
    expect(svc.isAllowedRedirectUri(c, 'http://localhost:33418/different-path')).toBe(false);
  });

  it('still requires scheme to match', () => {
    const c = client(['http://localhost/callback']);
    expect(svc.isAllowedRedirectUri(c, 'https://localhost:33418/callback')).toBe(false);
  });

  it('does NOT loosen non-loopback even if registered URI is loopback', () => {
    const c = client(['http://localhost/callback']);
    expect(svc.isAllowedRedirectUri(c, 'http://evil.example.com/callback')).toBe(false);
  });
});

describe('clients.isAllowedRedirectUri — input validation', () => {
  it('rejects empty / non-string', () => {
    const c = client(['http://localhost/callback']);
    expect(svc.isAllowedRedirectUri(c, '')).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(svc.isAllowedRedirectUri(c, undefined as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(svc.isAllowedRedirectUri(c, null as any)).toBe(false);
  });

  it('rejects unparseable URLs', () => {
    const c = client(['http://localhost/callback']);
    expect(svc.isAllowedRedirectUri(c, 'not a url')).toBe(false);
    expect(svc.isAllowedRedirectUri(c, '/no-scheme')).toBe(false);
  });
});

describe('clients.verifySecret', () => {
  // verifySecret needs a real hash. We compute it the same way the service does
  // (sha256 hex) so we can build a fixture without secret-management plumbing.
  const { createHash } = require('crypto');
  function sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }

  it('rejects when client is confidential but no secret presented', () => {
    const c = { ...client(['http://localhost/callback']), isConfidential: true, clientSecretHash: sha256('secret') };
    expect(svc.verifySecret(c, undefined)).toBe(false);
    expect(svc.verifySecret(c, '')).toBe(false);
  });

  it('accepts correct secret on confidential client', () => {
    const c = { ...client(['http://localhost/callback']), isConfidential: true, clientSecretHash: sha256('correct-secret') };
    expect(svc.verifySecret(c, 'correct-secret')).toBe(true);
  });

  it('rejects wrong secret on confidential client', () => {
    const c = { ...client(['http://localhost/callback']), isConfidential: true, clientSecretHash: sha256('correct-secret') };
    expect(svc.verifySecret(c, 'wrong-secret')).toBe(false);
  });

  it('public client: returns true only when no secret is presented', () => {
    const c = client(['http://localhost/callback']);
    expect(svc.verifySecret(c, undefined)).toBe(true);
    expect(svc.verifySecret(c, 'anything')).toBe(false);
  });
});
