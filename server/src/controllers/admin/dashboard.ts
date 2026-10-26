'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { getConfig, isConfigured } from '../../config';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async overview(ctx: Context): Promise<void> {
    const cfg = getConfig(strapi);
    const audit = strapi.plugin('mcp-server').service('audit');
    // Audit rows (params, IPs, admin identities) are the audit log: they need
    // audit.read, not just the dashboard permission. null = not allowed.
    const canReadAudit = Boolean(ctx.state.userAbility?.can('plugin::mcp-server.audit.read'));
    const recent = canReadAudit ? await audit.recent(10) : [];
    const enrichments = await audit.enrich(recent);
    ctx.body = {
      configured: isConfigured(cfg),
      resourceUrl: cfg.resourceUrl,
      allowedOrigins: cfg.allowedOrigins,
      recentCalls: canReadAudit
        ? recent.map((e: Record<string, unknown>, i: number) => ({
            ...e,
            principalAdmin: enrichments[i].principalAdmin,
            client: enrichments[i].client,
          }))
        : null,
      oauth: { mode: cfg.oauth.mode, dcrEnabled: cfg.oauth.dcr.enabled },
    };
  },
});
