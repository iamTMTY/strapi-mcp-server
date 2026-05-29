'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { getConfig } from '../../config';
import { ALL_SCOPES, parseScope, type Scope } from '../../services/oauth/scopes';
import { ensureEmbeddedMode } from './mode-guard';

/**
 * RFC 7591 Dynamic Client Registration.
 *
 * When `oauth.dcr.enabled` is true, any caller can register a client. Safe
 * because (a) redirect_uris are restricted to loopback HTTP or HTTPS by
 * `services/oauth/clients.ts.validateRedirectUris`, and (b) the admin still
 * has to approve the resulting client on the consent screen before any token
 * is issued. When disabled, this endpoint 403s and clients must be created
 * manually by an admin via the Clients page.
 */
export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async register(ctx: Context): Promise<void> {
    if (!ensureEmbeddedMode(ctx, strapi)) return;
    const cfg = getConfig(strapi);
    if (!cfg.oauth.dcr.enabled) {
      ctx.status = 403;
      ctx.body = { error: 'dcr_disabled' };
      return;
    }

    const ip = ctx.ip ?? ctx.request.ip;
    const userAgent = ctx.request.header['user-agent'] as string | undefined;
    const wait = await strapi.plugin('mcp-server').service('rate-limiter').checkDcr(ip);
    if (wait > 0) {
      ctx.response.set('Retry-After', String(wait));
      ctx.status = 429;
      ctx.body = { error: 'too_many_requests', error_description: 'DCR rate limit exceeded' };
      strapi.plugin('mcp-server').service('audit').record({
        ts: new Date(),
        principalType: 'system',
        principalId: 'anonymous',
        tool: 'oauth.dcr.register',
        params: { rateLimited: true, retryAfterSec: wait },
        resultStatus: 'error',
        errorCode: 'too_many_requests',
        ip,
        userAgent,
      });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = ((ctx.request as any).body ?? {}) as {
      client_name?: string;
      redirect_uris?: string[];
      scope?: string;
      token_endpoint_auth_method?: string;
      grant_types?: string[];
    };
    if (!body.client_name || !body.redirect_uris) {
      ctx.status = 400;
      ctx.body = { error: 'invalid_client_metadata' };
      return;
    }
    const requestedScopes = parseScope(body.scope ?? '');
    const grantedScopes: Scope[] =
      requestedScopes.length > 0 ? requestedScopes : [...ALL_SCOPES];

    try {
      const { client, clientSecret } = await strapi
        .plugin('mcp-server')
        .service('clients')
        .create({
          clientName: body.client_name,
          redirectUris: body.redirect_uris,
          scopes: grantedScopes,
          isConfidential: body.token_endpoint_auth_method
            ? body.token_endpoint_auth_method !== 'none'
            : false,
        });
      ctx.status = 201;
      ctx.body = {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        scope: client.scopes.join(' '),
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      };
      strapi.plugin('mcp-server').service('audit').record({
        ts: new Date(),
        principalType: 'system',
        principalId: 'anonymous',
        clientId: client.clientId,
        tool: 'oauth.dcr.register',
        params: {
          client_name: client.clientName,
          redirect_uris: client.redirectUris,
          scopes: client.scopes,
        },
        resultStatus: 'ok',
        ip,
        userAgent,
      });
    } catch (err) {
      ctx.status = 400;
      ctx.body = { error: 'invalid_client_metadata', error_description: (err as Error).message };
    }
  },
});
