'use strict';

import { request } from 'undici';
import { TEST_BASE_URL } from '../helpers/test-server';

describe('/mcp without a token', () => {
  it('returns 401 with a WWW-Authenticate Bearer challenge pointing at resource metadata', async () => {
    const resp = await request(`${TEST_BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        origin: TEST_BASE_URL,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'integration-test', version: '1.0.0' },
        },
      }),
    });
    expect(resp.statusCode).toBe(401);
    const challenge = resp.headers['www-authenticate'] as string;
    expect(challenge).toBeDefined();
    expect(challenge).toMatch(/Bearer/);
    expect(challenge).toMatch(/error="invalid_token"/);
    expect(challenge).toContain(`resource_metadata="${TEST_BASE_URL}/.well-known/oauth-protected-resource"`);
  });

  it('returns 401 for a malformed Authorization header', async () => {
    const resp = await request(`${TEST_BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        origin: TEST_BASE_URL,
        authorization: 'NotBearer abc',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(resp.statusCode).toBe(401);
  });

  it('returns 401 for an obviously bogus bearer token', async () => {
    const resp = await request(`${TEST_BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        origin: TEST_BASE_URL,
        authorization: 'Bearer not-a-real-jwt',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(resp.statusCode).toBe(401);
  });

  it('rejects an unallowed Origin header', async () => {
    const resp = await request(`${TEST_BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        origin: 'http://evil.example.com',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect([401, 403]).toContain(resp.statusCode);
  });
});
