'use strict';

import type { Core } from '@strapi/strapi';
import { getConfig } from '../config';

let timer: NodeJS.Timeout | null = null;

/**
 * Instance liveness via Redis. Every active instance refreshes
 * `mcp:inst:{INSTANCE_ID}` on a short interval (default 10s) with a slightly
 * longer TTL (default 30s) — peers consider an instance dead if its key has
 * disappeared.
 *
 * Used by the session directory to:
 *  - Skip proxying to a known-dead owner (return 404 instead of 502).
 *  - Garbage-collect stale `mcp:sess:{id}` entries pointing at dead instances.
 */
export default ({ strapi }: { strapi: Core.Strapi }) => {
  function key(instanceId: string): string {
    return strapi.plugin('mcp-server').service('redis').key('inst', instanceId);
  }

  async function refresh(): Promise<void> {
    const cfg = getConfig(strapi);
    if (!cfg.redis?.enabled || !cfg.redis.internalAddress) return;
    const r = await strapi.plugin('mcp-server').service('redis').get();
    if (!r) return;
    const id = strapi.plugin('mcp-server').service('instance-id').get();
    const ttlSec = Math.max(2, Math.ceil((cfg.redis.heartbeatTtlMs ?? 30_000) / 1000));
    try {
      await r.set(key(id), String(Date.now()), 'EX', ttlSec);
    } catch (err) {
      strapi.log.warn(`[mcp-server] heartbeat refresh failed: ${(err as Error).message}`);
    }
  }

  return {
    /** Start the periodic refresh. Safe to call multiple times. */
    async start(): Promise<void> {
      const cfg = getConfig(strapi);
      if (!cfg.redis?.enabled || !cfg.redis.internalAddress) return;
      if (timer) return;
      // Write one immediately so peers can see us right away.
      await refresh();
      const intervalMs = Math.max(1_000, cfg.redis.heartbeatIntervalMs ?? 10_000);
      timer = setInterval(() => {
        void refresh();
      }, intervalMs);
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    /**
     * Truthy when the instance's heartbeat key still exists in Redis. Used by
     * the directory to decide whether to attempt a proxy or treat the session
     * as orphaned.
     */
    async isAlive(instanceId: string): Promise<boolean> {
      const cfg = getConfig(strapi);
      if (!cfg.redis?.enabled) return true; // single-instance mode — always alive
      const r = await strapi.plugin('mcp-server').service('redis').get();
      if (!r) return true;
      try {
        const v = await r.get(key(instanceId));
        return v !== null;
      } catch {
        return true; // fail-open on transient Redis hiccup
      }
    },
  };
};
