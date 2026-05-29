'use strict';

import { request } from 'undici';
import { TEST_BASE_URL } from '../helpers/test-server';
import { mintMcpToken } from '../helpers/mcp-token';

let token: string;

beforeAll(async () => {
  const result = await mintMcpToken();
  token = result.accessToken;
});

async function mcpCall(method: string, params: unknown, sessionId?: string) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    origin: TEST_BASE_URL,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const resp = await request(`${TEST_BASE_URL}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  return resp;
}

describe('/mcp authenticated round-trip', () => {
  let sessionId: string | undefined;

  it('initialize succeeds and returns Mcp-Session-Id', async () => {
    const resp = await mcpCall('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0.0' },
    });
    expect(resp.statusCode).toBe(200);
    sessionId = resp.headers['mcp-session-id'] as string;
    expect(sessionId).toBeDefined();
    expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('tools/list returns the documented tool set', async () => {
    const resp = await mcpCall('tools/list', {}, sessionId);
    expect(resp.statusCode).toBe(200);
    const body = await resp.body.text();
    // SSE format: lines like `event: message\ndata: {...}`
    const expectedTools = [
      'strapi.content.list_types',
      'strapi.content.get_schema',
      'strapi.content.list_entries',
      'strapi.content.get_entry',
      'strapi.content.create_entry',
      'strapi.content.update_entry',
      'strapi.media.list',
      'strapi.media.upload',
    ];
    for (const t of expectedTools) {
      expect(body).toContain(`"name":"${t}"`);
    }
  });

  it('rejects a request with a fake Mcp-Session-Id (no proxy fallback in single-instance mode)', async () => {
    const resp = await mcpCall('tools/list', {}, 'not-a-real-session-id');
    expect([400, 404]).toContain(resp.statusCode);
  });

  it('DELETE /mcp with a valid session id terminates the session', async () => {
    const resp = await request(`${TEST_BASE_URL}/mcp`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${token}`,
        origin: TEST_BASE_URL,
        'mcp-session-id': sessionId as string,
      },
    });
    expect(resp.statusCode).toBe(204);
    // Subsequent call to the terminated session should miss
    const after = await mcpCall('tools/list', {}, sessionId);
    expect([400, 404]).toContain(after.statusCode);
  });
});
