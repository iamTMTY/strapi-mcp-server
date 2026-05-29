'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { getConfig } from '../../config';

/**
 * Short-circuit OAuth endpoints that only make sense in embedded AS mode.
 * Returns true when the caller should proceed; returns false (and sets a 404
 * response on ctx) when the plugin is configured to delegate to an external
 * AS — in that case the external issuer owns these endpoints, not us.
 */
export function ensureEmbeddedMode(ctx: Context, strapi: Core.Strapi): boolean {
  const cfg = getConfig(strapi);
  if (cfg.oauth.mode !== 'external') return true;
  ctx.status = 404;
  ctx.body = {
    error: 'not_found',
    error_description: 'OAuth AS endpoints are disabled; this plugin is configured to delegate to an external authorization server.',
  };
  return false;
}
