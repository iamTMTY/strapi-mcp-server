'use strict';

import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { bearerChallenge } from '../services/oauth/errors';
import { getConfig } from '../config';
import type { Scope } from '../services/oauth/scopes';
import type { PrincipalContext } from '../services/permissions';

export interface PolicyCtx {
  request: { header: Record<string, string | undefined> };
  response: { set: (h: string, v: string) => void };
  state: Record<string, unknown>;
}

export interface McpAuth {
  principal: PrincipalContext;
  scopes: Scope[];
  clientId: string;
  jti: string;
  adminUserId: string;
  exp: number;
  token: string;
}

/**
 * Verify a bearer token and resolve the live principal + effective scopes.
 * Shared by the `/mcp` policy and token introspection.
 *
 * Throws Error with message 'expired' | 'invalid_token' | 'principal unavailable'.
 */
export async function resolveAuth(strapi: Core.Strapi, token: string): Promise<McpAuth> {
  const plugin = strapi.plugin('mcp-server');
  const claims = await plugin.service('tokens').verifyAccessToken(token);

  let scopes: Scope[] = claims.scope;
  if (getConfig(strapi).oauth.mode !== 'external') {
    // Disabling or narrowing a client must bite immediately, not when its
    // access tokens expire.
    const client = await plugin.service('clients').findActive(claims.clientId);
    if (!client) throw new Error('invalid_token');
    scopes = scopes.filter((s) => client.scopes.includes(s));
  }

  const principal = await plugin.service('permissions').loadPrincipal(claims.sub);
  if (!principal) {
    try {
      await plugin.service('tokens').revokeAllForUser(claims.sub);
    } catch {
      /* non-fatal */
    }
    throw new Error('principal unavailable');
  }

  return {
    principal,
    scopes,
    clientId: claims.clientId,
    jti: claims.jti,
    adminUserId: claims.sub,
    exp: claims.exp,
    token,
  };
}

/**
 * Validate the Authorization header and attach McpAuth to ctx.state.mcpAuth.
 * Failure → 401 with WWW-Authenticate per RFC 6750.
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

  try {
    ctx.state.mcpAuth = await resolveAuth(strapi, token);
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
  return true;
};
