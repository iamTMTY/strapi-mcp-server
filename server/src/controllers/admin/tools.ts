'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { allTools, grantableScopes, isToolEnabled } from '../../services/tools';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  list(ctx: Context): void {
    ctx.body = {
      tools: allTools(strapi).map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        scope: t.scope,
        annotations: t.annotations,
        enabled: isToolEnabled(strapi, t),
      })),
      scopes: grantableScopes(strapi),
    };
  },
});
