'use strict';

import mcpServerFactory from '../../../server/src/services/mcp-server';
import toolRegistry from '../../../server/src/services/tool-registry';
import { ALL_SCOPES } from '../../../server/src/services/oauth/scopes';
import { makeStrapi } from '../../helpers/strapi-mock';

const allow = { can: new Proxy({}, { get: () => () => true }) };

function server(caps: { content?: boolean; media?: boolean } = {}) {
  const strapi = makeStrapi({
    services: {
      permissions: {
        listAllowedUids: () => ['api::a.a'],
        contentChecker: async () =>
          caps.content === false ? { can: new Proxy({}, { get: () => () => false }) } : allow,
        uploadManager: async () => ({ isAllowed: caps.media !== false }),
      },
      'tool-registry': toolRegistry({ strapi: {} as never }),
    },
  });
  const auth = { principal: { user: { id: 1 } }, scopes: [...ALL_SCOPES], clientId: 'c' };
  return mcpServerFactory({ strapi }).create(auth as never);
}

async function listTools(caps?: Parameters<typeof server>[0]) {
  const { mcpServer } = await server(caps);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (mcpServer.server as any)._requestHandlers.get('tools/list');
  return (await handler({ method: 'tools/list', params: {} }, {})).tools as Array<{
    name: string;
    title: string;
    inputSchema: Record<string, unknown>;
    annotations: Record<string, unknown>;
  }>;
}

/**
 * Strict MCP clients drop tools whose inputSchema isn't JSON Schema 2020-12
 * (see strapi/strapi#27395). Assert on what our server actually advertises.
 */
it('advertises every tool input schema as JSON Schema 2020-12', async () => {
  const tools = await listTools();
  expect(tools.length).toBeGreaterThan(10);
  for (const tool of tools) {
    expect(tool.inputSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.annotations.title).toBe(tool.title);
  }
});

it("hides tools the admin's Strapi role cannot use at all", async () => {
  const names = (await listTools({ media: false })).map((t) => t.name);
  expect(names).toContain('strapi_content_list_entries');
  expect(names.some((n) => n.startsWith('strapi_media_'))).toBe(false);
  const none = (await listTools({ content: false, media: false })).map((t) => t.name);
  expect(none).toEqual([]);
});
