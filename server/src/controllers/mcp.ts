'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { bearerChallenge } from '../services/oauth/errors';

const SESSION_HEADER = 'mcp-session-id';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Single handler for POST + GET on /mcp. POST initialize creates a new
   * session; subsequent POSTs and GETs lookup by Mcp-Session-Id.
   *
   * When Redis-backed session routing is enabled and the session lives on
   * a different instance, this request is proxied to the owning instance
   * over HTTP. The original client never sees the difference.
   */
  async handle(ctx: Context): Promise<void> {
    const mcpAuth = ctx.state.mcpAuth as {
      principal: { user: { id: string | number }; permissions: unknown[]; isSuperAdmin: boolean };
      scopes: string[];
      clientId: string;
      jti: string;
      adminUserId: string;
    };
    if (!mcpAuth) {
      ctx.throw(401, 'missing auth context');
    }

    const sessionStore = strapi.plugin('mcp-server').service('session-store');
    const sessionIdHeader = (ctx.request.header[SESSION_HEADER] as string | undefined)?.trim();

    if (sessionIdHeader) {
      const location = await sessionStore.locate(sessionIdHeader);
      if (!location) {
        ctx.status = 404;
        ctx.body = { error: 'session_not_found' };
        return;
      }
      if (location.principal && location.principal.adminUserId !== mcpAuth.adminUserId) {
        // Token swap mid-session — refuse rather than allow privilege transfer.
        ctx.set(
          'WWW-Authenticate',
          bearerChallenge(strapi, {
            error: 'invalid_token',
            error_description: 'session principal mismatch',
          })
        );
        ctx.throw(401, 'session principal mismatch');
      }
      if (location.kind === 'remote') {
        try {
          await strapi
            .plugin('mcp-server')
            .service('proxy-client')
            .forward(ctx, location.address, sessionIdHeader);
        } catch (err) {
          strapi.log.warn(
            `[mcp-server] proxy to ${location.address} failed: ${(err as Error).message}`
          );
          if (!ctx.res.headersSent) {
            ctx.res.statusCode = 502;
            ctx.res.end(JSON.stringify({ error: 'session_owner_unreachable' }));
          }
        }
        return;
      }
      if (location.session.principal.adminUserId !== mcpAuth.adminUserId) {
        ctx.set(
          'WWW-Authenticate',
          bearerChallenge(strapi, {
            error: 'invalid_token',
            error_description: 'session principal mismatch',
          })
        );
        ctx.throw(401, 'session principal mismatch');
      }
      await dispatchLocal(strapi, ctx, location.session.transport);
      return;
    }

    if (ctx.method !== 'POST') {
      ctx.status = 400;
      ctx.body = { error: 'missing_session_id' };
      return;
    }

    const principal = {
      adminUserId: mcpAuth.adminUserId,
      clientId: mcpAuth.clientId,
      jti: mcpAuth.jti,
    };
    if (!(await sessionStore.canCreate(principal))) {
      ctx.status = 503;
      ctx.body = { error: 'session_capacity_reached' };
      return;
    }

    const factory = strapi.plugin('mcp-server').service('mcp-server');
    const created = await factory.create({
      principal: mcpAuth.principal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scopes: mcpAuth.scopes as any,
      clientId: mcpAuth.clientId,
      jti: mcpAuth.jti,
    });
    const now = Date.now();
    const session = {
      id: created.sessionId,
      transport: created.transport,
      mcpServer: created.mcpServer,
      principal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scopes: mcpAuth.scopes as any,
      createdAt: now,
      lastSeenAt: now,
    };
    await sessionStore.put(session);
    await dispatchLocal(strapi, ctx, session.transport);
  },

  async end(ctx: Context): Promise<void> {
    const id = (ctx.request.header[SESSION_HEADER] as string | undefined)?.trim();
    if (!id) {
      ctx.status = 400;
      ctx.body = { error: 'missing_session_id' };
      return;
    }
    const sessionStore = strapi.plugin('mcp-server').service('session-store');
    // Owner instance handles close; for remote sessions, proxy the DELETE.
    const location = await sessionStore.locate(id);
    if (location?.kind === 'remote') {
      try {
        await strapi
          .plugin('mcp-server')
          .service('proxy-client')
          .forward(ctx, location.address, id);
      } catch {
        // best-effort — owner may already be gone; consider closed
        ctx.status = 204;
      }
      return;
    }
    await sessionStore.close(id);
    ctx.status = 204;
  },
});

async function dispatchLocal(
  strapi: Core.Strapi,
  ctx: Context,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transport: any
): Promise<void> {
  ctx.respond = false;
  ctx.req.socket.setTimeout(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (ctx.request as any).body;
  try {
    await transport.handleRequest(ctx.req, ctx.res, body);
  } catch (err) {
    strapi.log.error('[mcp-server] transport.handleRequest failed', err as Error);
    if (!ctx.res.headersSent) {
      ctx.res.statusCode = 500;
      ctx.res.end(JSON.stringify({ error: 'internal_error' }));
    }
  }
}
