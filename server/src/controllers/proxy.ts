'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { getConfig } from '../config';
import { verifySignature } from '../services/proxy-client';

/**
 * Receives a request forwarded from a peer Strapi instance for a session
 * this instance owns. The forwarder has already verified the original
 * bearer token; trust is established via the HMAC on `X-MCP-Proxy-Auth`.
 *
 * Note: this endpoint is publicly mountable. Security comes from the HMAC
 * (signed with `redis.internalSecret`, which is shared only among cluster
 * peers) and the small attack surface — the only legal action here is to
 * dispatch into a local session's existing transport.
 */
export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async receive(ctx: Context): Promise<void> {
    const cfg = getConfig(strapi);
    const secret = cfg.redis?.internalSecret;
    if (!secret) {
      ctx.status = 503;
      ctx.body = { error: 'proxy_disabled' };
      return;
    }

    const sessionId = decodeURIComponent(ctx.params.sessionId as string);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (ctx.request as any).body;
    const bodyStr =
      body === undefined || body === null
        ? ''
        : typeof body === 'string'
          ? body
          : JSON.stringify(body);

    const ok = verifySignature({
      header: ctx.request.header['x-mcp-proxy-auth'] as string | undefined,
      method: ctx.method,
      sessionId,
      body: bodyStr,
      secret,
    });
    if (!ok) {
      strapi.log.warn(`[mcp-server] proxy receive: bad HMAC for session=${sessionId}`);
      ctx.status = 401;
      ctx.body = { error: 'invalid_proxy_auth' };
      return;
    }

    const sessionStore = strapi.plugin('mcp-server').service('session-store');

    if (ctx.method === 'DELETE') {
      await sessionStore.close(sessionId);
      ctx.status = 204;
      return;
    }

    const session = sessionStore.getLocal(sessionId);
    if (!session) {
      // The directory pointed here but we don't have the session — maybe the
      // process just restarted or the session was swept. Tell the forwarder.
      ctx.status = 404;
      ctx.body = { error: 'session_not_found' };
      return;
    }

    ctx.respond = false;
    ctx.req.socket.setTimeout(0);
    try {
      await session.transport.handleRequest(ctx.req, ctx.res, body);
    } catch (err) {
      strapi.log.error('[mcp-server] proxy receive dispatch failed', err as Error);
      if (!ctx.res.headersSent) {
        ctx.res.statusCode = 500;
        ctx.res.end(JSON.stringify({ error: 'internal_error' }));
      }
    }
  },
});
