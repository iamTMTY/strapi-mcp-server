'use strict';

import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';

export interface PolicyCtx {
  state: Record<string, unknown>;
  ip?: string;
  request: { ip?: string };
  response: { set: (h: string, v: string) => void };
}

export default async (
  ctx: PolicyCtx,
  _cfg: unknown,
  { strapi }: { strapi: Core.Strapi }
): Promise<boolean> => {
  const mcpAuth = ctx.state.mcpAuth as { adminUserId?: string } | undefined;
  const principalId = mcpAuth?.adminUserId;
  const ip = ctx.ip ?? ctx.request.ip;
  const wait = await strapi.plugin('mcp-server').service('rate-limiter').check(principalId, ip);
  if (wait > 0) {
    ctx.response.set('Retry-After', String(wait));
    throw new errors.RateLimitError('rate limit exceeded');
  }
  return true;
};
