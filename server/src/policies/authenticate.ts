'use strict';

import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { bearerChallenge } from '../services/oauth/errors';

export interface PolicyCtx {
  request: { header: Record<string, string | undefined> };
  response: { set: (h: string, v: string) => void };
  state: Record<string, unknown>;
}

/**
 * Validate the Authorization header, attach { user, permissions, scopes, clientId, jti }
 * to ctx.state.mcpAuth. Failure → 401 with WWW-Authenticate per RFC 6750.
 *
 * Never log the Authorization header — only its presence/absence.
 */
export default async (
  ctx: PolicyCtx,
  _cfg: unknown,
  { strapi }: { strapi: Core.Strapi }
): Promise<boolean> => {
  const header = ctx.request.header.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    ctx.response.set(
      'WWW-Authenticate',
      bearerChallenge(strapi, { error: 'invalid_token', error_description: 'missing bearer token' })
    );
    throw new errors.UnauthorizedError('missing bearer token');
  }
  const token = header.slice(7).trim();
  if (!token) {
    ctx.response.set('WWW-Authenticate', bearerChallenge(strapi, { error: 'invalid_token' }));
    throw new errors.UnauthorizedError('empty bearer token');
  }

  const tokens = strapi.plugin('mcp-server').service('tokens');
  let claims;
  try {
    claims = await tokens.verifyAccessToken(token);
  } catch (err) {
    const message = (err as Error).message;
    ctx.response.set(
      'WWW-Authenticate',
      bearerChallenge(strapi, {
        error: 'invalid_token',
        error_description: message === 'expired' ? 'token expired' : 'invalid token',
      })
    );
    throw new errors.UnauthorizedError(message);
  }

  const principal = await strapi
    .plugin('mcp-server')
    .service('permissions')
    .loadPrincipal(claims.sub);
  if (!principal) {
    try {
      await tokens.revokeAllForUser(claims.sub);
      await strapi
        .plugin('mcp-server')
        .service('session-store')
        .closeForPrincipal(claims.sub);
    } catch {
      /* non-fatal */
    }
    ctx.response.set('WWW-Authenticate', bearerChallenge(strapi, { error: 'invalid_token' }));
    throw new errors.UnauthorizedError('principal unavailable');
  }

  ctx.state.mcpAuth = {
    principal,
    scopes: claims.scope,
    clientId: claims.clientId,
    jti: claims.jti,
    adminUserId: claims.sub,
    exp: claims.exp,
  };
  return true;
};
