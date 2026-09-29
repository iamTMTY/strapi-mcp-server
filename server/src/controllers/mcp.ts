'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import type { McpAuth } from '../policies/authenticate';
import { toAuthInfo } from '../services/mcp-server';

/**
 * Stateless Streamable HTTP: every POST gets its own McpServer + transport,
 * authorized from that request's bearer token alone. No Mcp-Session-Id, no
 * server-side session state, nothing to route between instances.
 */
export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async handle(ctx: Context): Promise<void> {
    const auth = ctx.state.mcpAuth as McpAuth;
    if (!auth) ctx.throw(401, 'missing auth context');

    const { transport, mcpServer } = await strapi
      .plugin('mcp-server')
      .service('mcp-server')
      .create(auth);

    // Lets Strapi's own request-scoped features (e.g. Enterprise audit logs,
    // which read the request context's user) attribute MCP writes to the admin.
    ctx.state.user = auth.principal.user;
    // `req.auth` is how the SDK passes per-request identity to tool callbacks.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx.req as any).auth = toAuthInfo(auth);

    ctx.respond = false;
    ctx.res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await transport.handleRequest(ctx.req, ctx.res, (ctx.request as any).body);
    } catch (err) {
      strapi.log.error('[mcp-server] transport.handleRequest failed', err as Error);
      if (!ctx.res.headersSent) {
        ctx.res.statusCode = 500;
        ctx.res.setHeader('content-type', 'application/json');
        ctx.res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          })
        );
      }
    }
  },

  /** GET (server-initiated SSE) and DELETE (session end) don't exist without sessions. */
  methodNotAllowed(ctx: Context): void {
    ctx.status = 405;
    ctx.set('Allow', 'POST');
    ctx.body = {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    };
  },
});
