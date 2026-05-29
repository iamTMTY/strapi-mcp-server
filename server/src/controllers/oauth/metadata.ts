'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { authorizationServerUrl, canonicalResourceUrl } from '../../services/oauth/audience';
import { ALL_SCOPES } from '../../services/oauth/scopes';
import { getConfig } from '../../config';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * RFC 9728 — points the client at the AS that issued tokens for this RS.
   * In external mode the AS is the operator-configured external issuer; in
   * embedded mode it's this server's root URL.
   */
  protectedResource(ctx: Context): void {
    const cfg = getConfig(strapi);
    const resource = canonicalResourceUrl(strapi);
    const externalMode = cfg.oauth.mode === 'external' && !!cfg.oauth.external;
    const asUrl = externalMode
      ? cfg.oauth.external!.issuer
      : authorizationServerUrl(strapi);

    const body: Record<string, unknown> = {
      resource,
      authorization_servers: [asUrl],
      bearer_methods_supported: ['header'],
      resource_documentation: `${asUrl}/.well-known/oauth-authorization-server`,
    };

    // Only advertise `strapi:*` scopes when this server is the AS (embedded
    // mode) or when the operator has opted into IdP-side scope enforcement.
    // Otherwise clients shouldn't request scopes the external IdP doesn't
    // know about — they'd fail with `invalid_scope`.
    const advertiseScopes = !externalMode || cfg.oauth.external?.enforceScopes === true;
    if (advertiseScopes) {
      body.scopes_supported = ALL_SCOPES;
    }

    ctx.body = body;
  },

  /**
   * RFC 8414 — Authorization Server metadata. Only valid in embedded mode;
   * in external mode the external AS publishes its own metadata at its own
   * URL, so we 404 to avoid lying.
   */
  authorizationServer(ctx: Context): void {
    const cfg = getConfig(strapi);
    if (cfg.oauth.mode === 'external') {
      ctx.status = 404;
      ctx.body = { error: 'not_found', error_description: 'AS metadata served by external issuer' };
      return;
    }
    const asUrl = authorizationServerUrl(strapi);
    const body: Record<string, unknown> = {
      issuer: asUrl,
      authorization_endpoint: `${asUrl}/oauth/authorize`,
      token_endpoint: `${asUrl}/oauth/token`,
      revocation_endpoint: `${asUrl}/oauth/revoke`,
      introspection_endpoint: `${asUrl}/oauth/introspect`,
      jwks_uri: `${asUrl}/oauth/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      scopes_supported: ALL_SCOPES,
      response_modes_supported: ['query'],
    };
    if (cfg.oauth.dcr.enabled) {
      body.registration_endpoint = `${asUrl}/oauth/register`;
    }
    ctx.body = body;
  },

  async jwks(ctx: Context): Promise<void> {
    const cfg = getConfig(strapi);
    if (cfg.oauth.mode === 'external') {
      ctx.status = 404;
      ctx.body = { error: 'not_found', error_description: 'JWKS served by external issuer' };
      return;
    }
    const sk = strapi.plugin('mcp-server').service('signing-keys');
    ctx.body = await sk.publicJwks();
    ctx.set('Cache-Control', 'public, max-age=300');
  },
});
