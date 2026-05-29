'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async list(ctx: Context): Promise<void> {
    const query = ctx.query as {
      limit?: string;
      tool?: string;
      principalId?: string;
      status?: string;
    };
    const limit = Math.min(500, Math.max(1, Number(query.limit ?? '50')));
    const filters: Record<string, unknown> = {};
    if (query.tool) filters.tool = query.tool;
    if (query.principalId) filters.principalId = query.principalId;
    if (query.status) filters.resultStatus = query.status;
    const auditSvc = strapi.plugin('mcp-server').service('audit');
    const entries = await auditSvc.recent(limit, filters);
    const enrichments = await auditSvc.enrich(entries);
    ctx.body = {
      entries: entries.map((e: Record<string, unknown>, i: number) => ({
        ...e,
        principalAdmin: enrichments[i].principalAdmin,
        client: enrichments[i].client,
      })),
    };
  },
});
