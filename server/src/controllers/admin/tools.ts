'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { ALL_SCOPES } from '../../services/oauth/scopes';

const TOOLS = [
  { name: 'strapi.content.list_types', scope: 'strapi:content:read' as const },
  { name: 'strapi.content.get_schema', scope: 'strapi:content:read' as const },
  { name: 'strapi.content.list_entries', scope: 'strapi:content:read' as const },
  { name: 'strapi.content.get_entry', scope: 'strapi:content:read' as const },
  { name: 'strapi.content.create_entry', scope: 'strapi:content:write' as const },
  { name: 'strapi.content.update_entry', scope: 'strapi:content:write' as const },
  { name: 'strapi.media.list', scope: 'strapi:media:read' as const },
  { name: 'strapi.media.upload', scope: 'strapi:media:write' as const },
];

export default ({ strapi: _strapi }: { strapi: Core.Strapi }) => ({
  list(ctx: Context): void {
    void _strapi;
    ctx.body = { tools: TOOLS, scopes: ALL_SCOPES };
  },
});
