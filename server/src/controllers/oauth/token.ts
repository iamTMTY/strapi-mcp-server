'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { verifyS256 } from '../../services/oauth/pkce';
import { parseScope, scopeString, isSubsetOf, type Scope } from '../../services/oauth/scopes';
import { canonicalResourceUrl } from '../../services/oauth/audience';
import { ensureEmbeddedMode } from './mode-guard';

interface TokenRequestBody {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  client_secret?: string;
  code_verifier?: string;
  refresh_token?: string;
  resource?: string;
  scope?: string;
}

function error(
  ctx: Context,
  status: number,
  code: string,
  description?: string
): void {
  ctx.status = status;
  ctx.set('Cache-Control', 'no-store');
  ctx.body = { error: code, ...(description ? { error_description: description } : {}) };
}

function readClientCreds(ctx: Context, body: TokenRequestBody): {
  clientId?: string;
  clientSecret?: string;
} {
  const header = ctx.request.header.authorization;
  if (header?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx > 0) {
        return {
          clientId: decoded.slice(0, idx),
          clientSecret: decoded.slice(idx + 1),
        };
      }
    } catch {
      /* fall through */
    }
  }
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async token(ctx: Context): Promise<void> {
    if (!ensureEmbeddedMode(ctx, strapi)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = ((ctx.request as any).body ?? {}) as TokenRequestBody;
    const grant = body.grant_type;

    if (grant === 'authorization_code') return handleAuthCode(strapi, ctx, body);
    if (grant === 'refresh_token') return handleRefresh(strapi, ctx, body);

    return error(ctx, 400, 'unsupported_grant_type', `grant_type=${grant ?? ''} not supported`);
  },

  async revoke(ctx: Context): Promise<void> {
    if (!ensureEmbeddedMode(ctx, strapi)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = ((ctx.request as any).body ?? {}) as { token?: string };
    if (!body.token) {
      ctx.status = 400;
      ctx.body = { error: 'invalid_request' };
      return;
    }
    try {
      await strapi.plugin('mcp-server').service('tokens').revokeRefresh(body.token);
    } catch {
      /* swallow per RFC 7009 */
    }
    ctx.status = 200;
    ctx.body = { ok: true };
  },
});

async function handleAuthCode(
  strapi: Core.Strapi,
  ctx: Context,
  body: TokenRequestBody
): Promise<void> {
  const creds = readClientCreds(ctx, body);
  if (!creds.clientId) return error(ctx, 400, 'invalid_request', 'client_id required');
  if (!body.code) return error(ctx, 400, 'invalid_request', 'code required');
  if (!body.redirect_uri) return error(ctx, 400, 'invalid_request', 'redirect_uri required');
  if (!body.code_verifier) return error(ctx, 400, 'invalid_request', 'code_verifier required');
  if (body.resource !== canonicalResourceUrl(strapi)) {
    return error(ctx, 400, 'invalid_target', 'resource mismatch');
  }

  const clientsSvc = strapi.plugin('mcp-server').service('clients');
  const client = await clientsSvc.findActive(creds.clientId);
  if (!client) return error(ctx, 401, 'invalid_client');
  if (!clientsSvc.verifySecret(client, creds.clientSecret)) {
    return error(ctx, 401, 'invalid_client');
  }
  if (!clientsSvc.isAllowedRedirectUri(client, body.redirect_uri)) {
    return error(ctx, 400, 'invalid_grant', 'redirect_uri mismatch');
  }

  const tokensSvc = strapi.plugin('mcp-server').service('tokens');
  const codesSvc = strapi.plugin('mcp-server').service('auth-codes');
  const consumed = await codesSvc.consume(body.code);
  if (consumed === 'replayed') {
    // Don't reveal which family — but log the incident.
    strapi.log.warn(`[mcp-server] authorization code replay on client=${client.clientId}`);
    return error(ctx, 400, 'invalid_grant', 'code already used');
  }
  if (!consumed) return error(ctx, 400, 'invalid_grant');
  if (consumed.clientId !== client.clientId) return error(ctx, 400, 'invalid_grant');
  if (consumed.redirectUri !== body.redirect_uri) {
    return error(ctx, 400, 'invalid_grant', 'redirect_uri mismatch');
  }
  if (consumed.resource !== body.resource) return error(ctx, 400, 'invalid_target');
  if (!verifyS256(body.code_verifier, consumed.codeChallenge)) {
    return error(ctx, 400, 'invalid_grant', 'PKCE verification failed');
  }

  const scopes = parseScope(consumed.scope);
  const minted = await tokensSvc.mint({
    adminUserId: consumed.adminUserId,
    clientId: client.clientId,
    scope: scopes,
  });
  await clientsSvc.touchLastUsed(client.clientId);

  ctx.set('Cache-Control', 'no-store');
  ctx.body = {
    access_token: minted.accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(
      (minted.accessTokenExpiresAt.getTime() - Date.now()) / 1000
    ),
    refresh_token: minted.refreshToken,
    scope: scopeString(scopes),
  };
}

async function handleRefresh(
  strapi: Core.Strapi,
  ctx: Context,
  body: TokenRequestBody
): Promise<void> {
  const creds = readClientCreds(ctx, body);
  if (!creds.clientId) return error(ctx, 400, 'invalid_request', 'client_id required');
  if (!body.refresh_token) return error(ctx, 400, 'invalid_request', 'refresh_token required');
  if (body.resource && body.resource !== canonicalResourceUrl(strapi)) {
    return error(ctx, 400, 'invalid_target', 'resource mismatch');
  }

  const clientsSvc = strapi.plugin('mcp-server').service('clients');
  const client = await clientsSvc.findActive(creds.clientId);
  if (!client) return error(ctx, 401, 'invalid_client');
  if (!clientsSvc.verifySecret(client, creds.clientSecret)) {
    return error(ctx, 401, 'invalid_client');
  }

  const tokensSvc = strapi.plugin('mcp-server').service('tokens');
  const consumed = await tokensSvc.consumeRefresh(body.refresh_token);
  if (!consumed) return error(ctx, 400, 'invalid_grant');
  if (consumed.clientId !== client.clientId) {
    await tokensSvc.revokeFamily(consumed.familyId);
    return error(ctx, 400, 'invalid_grant');
  }

  let scopes = parseScope(consumed.scope);
  if (body.scope) {
    const requested = parseScope(body.scope);
    if (!isSubsetOf(requested, scopes as Scope[])) {
      return error(ctx, 400, 'invalid_scope', 'cannot expand scopes on refresh');
    }
    scopes = requested;
  }

  const minted = await tokensSvc.mint({
    adminUserId: consumed.adminUserId,
    clientId: client.clientId,
    scope: scopes,
    familyId: consumed.familyId,
    parentJti: consumed.parentJti ?? undefined,
  });

  await tokensSvc.markRotated(consumed.id, tokensSvc.hash(minted.refreshToken));
  await clientsSvc.touchLastUsed(client.clientId);

  ctx.set('Cache-Control', 'no-store');
  ctx.body = {
    access_token: minted.accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(
      (minted.accessTokenExpiresAt.getTime() - Date.now()) / 1000
    ),
    refresh_token: minted.refreshToken,
    scope: scopeString(scopes),
  };
}
