'use strict';

import type { Core } from '@strapi/strapi';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getConfig } from '../config';
import type { McpAuth } from '../policies/authenticate';
import { toolsFor, type ToolDef } from './tools';
import { isProviderError } from './tools/common';

/**
 * What the transport hands tool callbacks as `extra.authInfo`. The HTTP layer
 * sets it on `req.auth` from the request's own bearer token.
 */
export function toAuthInfo(auth: McpAuth) {
  return {
    token: auth.token,
    clientId: auth.clientId,
    scopes: auth.scopes,
    expiresAt: auth.exp,
    extra: { mcpAuth: auth },
  };
}

const SCHEMA_URI = 'strapi://content-types/{uid}/schema';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * A fresh McpServer + stateless transport for ONE HTTP request, built for
   * that request's principal: only tools the token's scopes and the admin's
   * Strapi role can use are listed. Nothing survives the request, so
   * permission, scope and client changes apply on the very next call — and
   * any instance behind a load balancer can serve any request.
   */
  async create(
    auth: McpAuth
  ): Promise<{ transport: StreamableHTTPServerTransport; mcpServer: McpServer }> {
    const cfg = getConfig(strapi);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcpServer = new McpServer({ name: 'strapi-mcp-server', version: '0.2.0' });
    const tools = await toolsFor(strapi, auth);

    for (const tool of tools) {
      mcpServer.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema.shape,
          annotations: { title: tool.title, ...tool.annotations },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (raw: unknown, extra: any) => runTool(strapi, tool, raw, extra, cfg.requestTimeoutMs)
      );
    }

    // SDK 1.x advertises schemas as JSON Schema draft-07 even for zod v4, and
    // strict clients silently drop such tools (strapi/strapi#27395). Serve
    // tools/list ourselves in 2020-12; tools/call still goes through the SDK.
    // With no usable tools the SDK registers no handler at all; answer with
    // an empty list rather than "method not found".
    if (tools.length === 0) mcpServer.server.registerCapabilities({ tools: {} });
    {
      const listed = tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: z.toJSONSchema(t.inputSchema, { target: 'draft-2020-12', io: 'input' }),
        annotations: { title: t.title, ...t.annotations },
      }));
      mcpServer.server.setRequestHandler(
        ListToolsRequestSchema,
        () => ({ tools: listed }) as never
      );
    }

    // Content-type schemas as MCP resources, for clients that attach context
    // from resources instead of calling tools. Same permission path as the
    // strapi_content_get_schema tool.
    const schemaTool = tools.find((t) => t.name === 'strapi_content_get_schema');
    const listTypesTool = tools.find((t) => t.name === 'strapi_content_list_types');
    if (schemaTool && listTypesTool) {
      const toolAuth = { principal: auth.principal, scopes: auth.scopes, clientId: auth.clientId };
      mcpServer.registerResource(
        'content-type-schema',
        new ResourceTemplate(SCHEMA_URI, {
          list: async () => {
            const res = await listTypesTool.handler({}, toolAuth);
            const { contentTypes } = res.structuredContent as {
              contentTypes: Array<{ uid: string; displayName?: string }>;
            };
            return {
              resources: contentTypes.map((ct) => ({
                uri: SCHEMA_URI.replace('{uid}', encodeURIComponent(ct.uid)),
                name: ct.displayName ?? ct.uid,
                mimeType: 'application/json',
              })),
            };
          },
        }),
        {
          title: 'Content type schema',
          description: 'Attribute schema of a Strapi content type',
          mimeType: 'application/json',
        },
        async (uri, vars) => {
          const uid = decodeURIComponent(String(vars.uid));
          const res = await schemaTool.handler({ uid }, toolAuth);
          return {
            contents: [{ uri: uri.href, mimeType: 'application/json', text: res.content[0].text }],
          };
        }
      );
    }

    await mcpServer.connect(transport);
    return { transport, mcpServer };
  },
});

async function runTool(
  strapi: Core.Strapi,
  tool: ToolDef,
  raw: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra: any,
  timeoutMs: number
) {
  const auth = extra?.authInfo?.extra?.mcpAuth as McpAuth | undefined;
  const cfg = getConfig(strapi);
  const startedAt = Date.now();
  const audit = (resultStatus: 'ok' | 'error', errorCode?: string) => {
    // Reads that succeed can be skipped to keep the audit table small.
    if (resultStatus === 'ok' && tool.annotations.readOnlyHint && !cfg.audit.recordReads) return;
    strapi
      .plugin('mcp-server')
      .service('audit')
      .record({
        ts: new Date(),
        principalType: 'admin',
        principalId: auth ? String(auth.adminUserId) : 'unknown',
        clientId: auth?.clientId,
        tool: tool.name,
        params: raw,
        resultStatus,
        errorCode,
        durationMs: Date.now() - startedAt,
      });
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!auth)
      throw Object.assign(new Error('Missing request authentication.'), { code: 'unauthorized' });
    const work = tool.handler(raw, {
      principal: auth.principal,
      scopes: auth.scopes,
      clientId: auth.clientId,
    });
    // A race can't cancel a database write halfway, so only read-only tools
    // are cut off: telling the model a write "timed out" while it may still
    // land would invite a duplicate retry. Writes run to completion.
    const result = !tool.annotations.readOnlyHint
      ? await work
      : await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Object.assign(new Error(`Tool timed out after ${timeoutMs} ms.`), {
                    code: 'timeout',
                  })
                ),
              timeoutMs
            );
          }),
        ]);
    audit('ok');
    return result;
  } catch (err) {
    const code = toolErrorCode(err);
    audit('error', code);
    if (code === 'internal_error')
      strapi.log.error(`[mcp-server] tool ${tool.name} failed`, err as Error);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: code, message: toolErrorMessage(err, code) }),
        },
      ],
      isError: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stable machine-readable code. Our own errors carry `.code`; zod and
 * Strapi's own errors are mapped so the model can tell "fix your input"
 * from "you may not" from "server broke".
 */
function toolErrorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: string };
  if (typeof e?.code === 'string' && /^[a-z_]+$/.test(e.code)) return e.code;
  switch (e?.name) {
    case 'ZodError':
    case 'ValidationError':
    case 'ApplicationError':
      return 'bad_request';
    case 'ForbiddenError':
    case 'PolicyError':
      return 'forbidden';
    case 'NotFoundError':
      return 'not_found';
    default:
      // Upload providers (S3, Cloudinary, …) throw their own error types.
      return isProviderError(err) ? 'upload_provider_error' : 'internal_error';
  }
}

function toolErrorMessage(err: unknown, code: string): string {
  // Don't leak stack/SQL details for unexpected failures.
  if (code === 'internal_error') return 'Internal error while running the tool.';
  if (code === 'upload_provider_error') {
    return `The configured upload provider rejected the file: ${(err as Error).message}`;
  }
  const e = err as { message?: string; issues?: Array<{ path: unknown[]; message: string }> };
  if (Array.isArray(e.issues)) {
    return e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
  }
  return e.message ?? code;
}
