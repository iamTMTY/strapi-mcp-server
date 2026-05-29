'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { getConfig } from '../../config';
import { ensureEmbeddedMode } from './mode-guard';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * RFC 7662 introspection — internal use only, IP-allowlisted.
   * Without this guard, introspection is a token-validity oracle attackers can
   * leverage; default config restricts to loopback.
   */
  async introspect(ctx: Context): Promise<void> {
    if (!ensureEmbeddedMode(ctx, strapi)) return;
    const cfg = getConfig(strapi);
    const ip = ctx.ip ?? ctx.request.ip ?? '';
    if (!cfg.oauth.introspection.allowedIps.includes(ip)) {
      ctx.status = 403;
      ctx.body = { active: false };
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = ((ctx.request as any).body ?? {}) as { token?: string };
    if (!body.token) {
      ctx.body = { active: false };
      return;
    }
    try {
      const claims = await strapi
        .plugin('mcp-server')
        .service('tokens')
        .verifyAccessToken(body.token);
      ctx.body = {
        active: true,
        sub: claims.sub,
        scope: claims.scope.join(' '),
        client_id: claims.clientId,
        exp: claims.exp,
      };
    } catch {
      ctx.body = { active: false };
    }
  },
});
