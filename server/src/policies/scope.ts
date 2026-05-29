'use strict';

import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { bearerChallenge } from '../services/oauth/errors';
import type { Scope } from '../services/oauth/scopes';

export interface PolicyCtx {
  state: { mcpAuth?: { scopes?: Scope[] } };
  response: { set: (h: string, v: string) => void };
}

/**
 * Higher-order policy for admin/audit routes. Returns a policy function whose
 * `config` is the required scope name. Currently unused for /mcp itself
 * (per-tool checks happen inside the tool callback).
 */
export default (
  ctx: PolicyCtx,
  config: { scope: Scope },
  { strapi }: { strapi: Core.Strapi }
): boolean => {
  const granted = ctx.state.mcpAuth?.scopes ?? [];
  if (!granted.includes(config.scope)) {
    ctx.response.set(
      'WWW-Authenticate',
      bearerChallenge(strapi, { error: 'insufficient_scope', scope: config.scope })
    );
    throw new errors.ForbiddenError('insufficient_scope');
  }
  return true;
};
