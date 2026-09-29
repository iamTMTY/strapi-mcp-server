'use strict';

import type { Core } from '@strapi/strapi';
import { getConfig } from '../config';

// Loose Redis interface — narrow surface we actually use. Avoids forcing a
// hard typed dep on ioredis when Redis is disabled.
export interface RedisLike {
  eval(script: string, numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  quit(): Promise<unknown>;
}

let client: RedisLike | null = null;
let initializing: Promise<RedisLike | null> | null = null;

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Return the shared Redis client (used only to share rate-limit buckets
   * across instances). Returns null when Redis is disabled in config —
   * callers fall back to process-local state.
   * Multiple concurrent callers during boot share the same connect promise.
   */
  async get(): Promise<RedisLike | null> {
    const cfg = getConfig(strapi);
    if (!cfg.redis?.enabled) return null;
    if (client) return client;
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        // Dynamic require so single-instance deployments don't need ioredis
        // installed at all. If they enable Redis but skipped install, fail
        // loudly with a useful message.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const IORedis = require('ioredis');
        const Ctor = IORedis.default ?? IORedis;
        const instance: RedisLike = new Ctor(cfg.redis!.url, {
          lazyConnect: false,
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
        });
        instance.on('error', (err: unknown) => {
          strapi.log.warn(`[mcp-server] redis error: ${(err as Error).message}`);
        });
        instance.on('connect', () => {
          strapi.log.info('[mcp-server] redis connected');
        });
        client = instance;
        return instance;
      } catch (err) {
        const msg = (err as Error).message;
        strapi.log.error(
          `[mcp-server] redis init failed (${msg}). Install ioredis or set redis.enabled=false.`
        );
        client = null;
        return null;
      } finally {
        initializing = null;
      }
    })();
    return initializing;
  },

  /**
   * Build a namespaced key. All Redis keys flow through here so that
   * deployments with shared Redis can prefix per-tenant.
   */
  key(...parts: string[]): string {
    const cfg = getConfig(strapi);
    const prefix = cfg.redis?.keyPrefix ?? 'mcp:';
    return prefix + parts.join(':');
  },

  /** Close the shared client. Called from destroy(). */
  async disconnect(): Promise<void> {
    try {
      await client?.quit();
    } catch {
      // best-effort
    }
    client = null;
  },
});
