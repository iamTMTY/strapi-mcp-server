'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { ALL_SCOPES } from '../../services/oauth/scopes';
import { allTools, isToolEnabled } from '../../services/tools';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  list(ctx: Context): void {
    ctx.body = {
      tools: allTools(strapi).map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        scope: t.scope,
        annotations: t.annotations,
        enabled: isToolEnabled(strapi, t.name),
      })),
      scopes: ALL_SCOPES,
    };
  },
});
