'use strict';

import type { Core } from '@strapi/strapi';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import type { Scope } from './oauth/scopes';
import type { PrincipalContext } from './permissions';
import { buildToolsForSession } from './tools';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Construct a fresh McpServer + StreamableHTTPServerTransport for a new
   * session. The transport's `sessionIdGenerator` returns a UUID the first
   * time it's called (during `initialize`), then the same id forever — the
   * SDK uses that to issue `Mcp-Session-Id` on the initial response.
   */
  async create(options: {
    principal: PrincipalContext;
    scopes: Scope[];
    clientId: string;
    jti: string;
  }): Promise<{
    sessionId: string;
    transport: StreamableHTTPServerTransport;
    mcpServer: McpServer;
  }> {
    const sessionId = randomUUID();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: false,
    });

    const mcpServer = new McpServer({
      name: 'strapi-mcp-server',
      version: '0.1.0',
    });

    const tools = buildToolsForSession({
      strapi,
      principal: options.principal,
      scopes: options.scopes,
    });

    for (const tool of tools) {
      mcpServer.registerTool(
        tool.name,
        {
          description: tool.description,
          // The SDK accepts a Zod schema object literal under `inputSchema`.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          inputSchema: (tool.inputSchema as any).shape ?? tool.inputSchema,
        },
        async (raw: unknown) => {
          const startedAt = Date.now();
          const auditPayload = {
            ts: new Date(),
            principalType: 'admin' as const,
            principalId: String(options.principal.user.id),
            sessionId,
            clientId: options.clientId,
            tool: tool.name,
            params: raw,
            resultStatus: 'ok' as 'ok' | 'error',
            errorCode: undefined as string | undefined,
            durationMs: 0,
          };
          try {
            const result = await tool.handler.call(tool, raw);
            auditPayload.durationMs = Date.now() - startedAt;
            strapi.plugin('mcp-server').service('audit').record(auditPayload);
            return result;
          } catch (err) {
            const code = (err as Error & { code?: string }).code;
            auditPayload.resultStatus = 'error';
            auditPayload.errorCode = code ?? 'internal';
            auditPayload.durationMs = Date.now() - startedAt;
            strapi.plugin('mcp-server').service('audit').record(auditPayload);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: code ?? 'internal_error',
                    message: (err as Error).message,
                  }),
                },
              ],
              isError: true,
            };
          }
        }
      );
    }

    await mcpServer.connect(transport);
    return { sessionId, transport, mcpServer };
  },
});
