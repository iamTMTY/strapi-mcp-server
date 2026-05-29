'use strict';

import { hostname } from 'os';
import { randomBytes } from 'crypto';
import type { Core } from '@strapi/strapi';
import { getConfig } from '../config';

let cached: string | null = null;

/**
 * Stable per-process identifier. Used as the value of `sess:{id}.instance`
 * in the Redis session directory so peers know who owns a session.
 *
 * Format: `<hostname>-<pid>-<8hex>` so operators can match it to a host
 * when debugging. Override via `config.redis.instanceId` if you'd rather
 * pin it (e.g. from a Kubernetes pod name).
 */
export default ({ strapi }: { strapi: Core.Strapi }) => ({
  get(): string {
    if (cached) return cached;
    const cfg = getConfig(strapi);
    const override = cfg.redis?.instanceId?.trim();
    if (override) {
      cached = override;
      return cached;
    }
    cached = `${hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`;
    return cached;
  },
});
