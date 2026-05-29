'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { getConfig } from '../../config';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async overview(ctx: Context): Promise<void> {
    const cfg = getConfig(strapi);
    const sessionStore = strapi.plugin('mcp-server').service('session-store');
    const audit = strapi.plugin('mcp-server').service('audit');
    const stats = sessionStore.stats();
    const recent = await audit.recent(10);
    const enrichments = await audit.enrich(recent);
    ctx.body = {
      enabled: cfg.enabled,
      resourceUrl: cfg.resourceUrl,
      allowedOrigins: cfg.allowedOrigins,
      sessions: stats,
      recentCalls: recent.map((e: Record<string, unknown>, i: number) => ({
        ...e,
        principalAdmin: enrichments[i].principalAdmin,
        client: enrichments[i].client,
      })),
      oauth: { mode: cfg.oauth.mode, dcrEnabled: cfg.oauth.dcr.enabled },
    };
  },
});
