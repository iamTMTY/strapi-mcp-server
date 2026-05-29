'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { getConfig } from '../../config';

/**
 * Read-only view of the merged config. Mutations to security-critical settings
 * happen in config/plugins.ts (env-driven) — exposing a runtime mutation surface
 * would let admins weaken security from the UI without an audit trail.
 *
 * Secrets (redis.internalSecret, password in redis.url) are masked. The UI
 * surfaces whether they're set, not what they're set to.
 */
export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async get(ctx: Context): Promise<void> {
    const cfg = getConfig(strapi);
    const redis = cfg.redis
      ? {
          ...cfg.redis,
          url: maskRedisUrl(cfg.redis.url),
          internalSecret: cfg.redis.internalSecret ? '••••••' : '',
        }
      : undefined;
    ctx.body = { ...cfg, redis };
  },
});

function maskRedisUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.password) u.password = '••••••';
    return u.toString();
  } catch {
    return url;
  }
}
