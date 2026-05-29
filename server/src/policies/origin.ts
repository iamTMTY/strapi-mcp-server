'use strict';

import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { getConfig } from '../config';

/**
 * Origin + Host validation. Required for DNS rebinding mitigation.
 * Empty allowlist → reject all (default-deny).
 *
 * Strapi's PolicyContext is built via Object.assign({}, ctx) which only copies
 * own properties — `ctx.set`/`ctx.throw` (on the Koa prototype) get stripped.
 * Use `ctx.response.*` for header/status work and throw Strapi error classes
 * to surface proper HTTP statuses through the framework's error middleware.
 */
export default (
  ctx: {
    request: { header: Record<string, string | undefined>; url?: string; method?: string };
    response: { set: (h: string, v: string) => void };
  },
  _cfg: unknown,
  { strapi }: { strapi: Core.Strapi }
): boolean => {
  const cfg = getConfig(strapi);
  const origin = ctx.request.header.origin;
  const host = ctx.request.header.host;

  if (cfg.allowedOrigins.length === 0) {
    throw new errors.ForbiddenError('origin not allowed');
  }

  if (cfg.allowedOrigins.includes('*')) return true;

  if (origin) {
    if (!cfg.allowedOrigins.includes(origin)) {
      throw new errors.ForbiddenError('origin not allowed');
    }
  } else {
    try {
      const resourceHost = new URL(cfg.resourceUrl).host;
      if (!host || host !== resourceHost) {
        throw new errors.ForbiddenError('host not allowed');
      }
    } catch (err) {
      if (err instanceof errors.ForbiddenError) throw err;
      throw new errors.ForbiddenError('host validation failed');
    }
  }
  return true;
};
