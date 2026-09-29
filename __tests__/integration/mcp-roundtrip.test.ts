'use strict';

import { request } from 'undici';
import { TEST_BASE_URL } from '../helpers/test-server';
import { mintMcpToken } from '../helpers/mcp-token';

let token: string;

beforeAll(async () => {
  token = (await mintMcpToken()).accessToken;
});

async function mcpCall(method: string, params: unknown) {
  const resp = await request(`${TEST_BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      origin: TEST_BASE_URL,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: resp.statusCode, headers: resp.headers, body: (await resp.body.json()) as any };
}

describe('/mcp stateless round-trip', () => {
  it('initialize succeeds without issuing a session id', async () => {
    const r = await mcpCall('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0.0' },
    });
    expect(r.status).toBe(200);
    expect(r.headers['mcp-session-id']).toBeUndefined();
    expect(r.body.result.serverInfo.name).toBe('strapi-mcp-server');
  });

  it('every request stands alone: tools/list works with no prior initialize', async () => {
    const r = await mcpCall('tools/list', {});
    expect(r.status).toBe(200);
    const names = r.body.result.tools.map((t: { name: string }) => t.name);
    for (const t of [
      'strapi_content_list_types',
      'strapi_content_get_schema',
      'strapi_content_list_entries',
      'strapi_content_get_entry',
      'strapi_content_create_entry',
      'strapi_content_update_entry',
      'strapi_media_list',
      'strapi_media_upload',
    ]) {
      expect(names).toContain(t);
    }
    expect(r.body.result.tools[0].inputSchema.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema'
    );
  });

  it.each(['GET', 'DELETE'])(
    '%s /mcp is 405 (no sessions, no server-initiated stream)',
    async (method) => {
      const resp = await request(`${TEST_BASE_URL}/mcp`, {
        method: method as 'GET' | 'DELETE',
        headers: { authorization: `Bearer ${token}`, origin: TEST_BASE_URL },
      });
      expect(resp.statusCode).toBe(405);
      await resp.body.text();
    }
  );
});
