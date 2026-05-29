'use strict';

import { request } from 'undici';
import { TEST_BASE_URL } from '../helpers/test-server';

describe('discovery endpoints', () => {
  it('serves /.well-known/oauth-protected-resource (RFC 9728)', async () => {
    const resp = await request(`${TEST_BASE_URL}/.well-known/oauth-protected-resource`);
    expect(resp.statusCode).toBe(200);
    const body = (await resp.body.json()) as Record<string, unknown>;
    expect(body.resource).toBe(`${TEST_BASE_URL}/mcp`);
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    expect((body.authorization_servers as string[]).length).toBeGreaterThan(0);
  });

  it('serves /.well-known/oauth-authorization-server (RFC 8414) in embedded mode', async () => {
    const resp = await request(`${TEST_BASE_URL}/.well-known/oauth-authorization-server`);
    expect(resp.statusCode).toBe(200);
    const body = (await resp.body.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(TEST_BASE_URL);
    expect(body.authorization_endpoint).toBe(`${TEST_BASE_URL}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${TEST_BASE_URL}/oauth/token`);
    expect(body.code_challenge_methods_supported).toContain('S256');
    expect(body.response_types_supported).toContain('code');
    expect(body.grant_types_supported).toContain('authorization_code');
    expect(body.grant_types_supported).toContain('refresh_token');
  });

  it('does NOT advertise registration_endpoint when DCR is off (fixture overrides to off)', async () => {
    const resp = await request(`${TEST_BASE_URL}/.well-known/oauth-authorization-server`);
    const body = (await resp.body.json()) as Record<string, unknown>;
    expect(body.registration_endpoint).toBeUndefined();
  });

  it('serves /oauth/jwks with at least one key', async () => {
    const resp = await request(`${TEST_BASE_URL}/oauth/jwks`);
    expect(resp.statusCode).toBe(200);
    const body = (await resp.body.json()) as { keys: Array<{ kty: string; kid: string; alg: string }> };
    expect(body.keys.length).toBeGreaterThan(0);
    expect(body.keys[0].kty).toBe('RSA');
    expect(body.keys[0].alg).toBe('RS256');
  });
});

describe('DCR endpoint when disabled', () => {
  it('POST /oauth/register returns 403 dcr_disabled', async () => {
    const resp = await request(`${TEST_BASE_URL}/oauth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: TEST_BASE_URL,
      },
      body: JSON.stringify({
        client_name: 'test-dcr',
        redirect_uris: ['http://localhost/callback'],
      }),
    });
    expect(resp.statusCode).toBe(403);
    const body = (await resp.body.json()) as Record<string, string>;
    expect(body.error).toBe('dcr_disabled');
  });
});
