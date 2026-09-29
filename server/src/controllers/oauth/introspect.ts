'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { getConfig } from '../../config';
import { ensureEmbeddedMode } from './mode-guard';
import { resolveAuth } from '../../policies/authenticate';

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
      // Same checks as /mcp: disabled clients, narrowed scopes and
      // deactivated admins all report as they would be enforced.
      const auth = await resolveAuth(strapi, body.token);
      ctx.body = {
        active: true,
        sub: auth.adminUserId,
        scope: auth.scopes.join(' '),
        client_id: auth.clientId,
        exp: auth.exp,
      };
    } catch {
      ctx.body = { active: false };
    }
  },
});
