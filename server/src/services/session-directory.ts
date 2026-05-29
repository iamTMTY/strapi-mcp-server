'use strict';

import type { Core } from '@strapi/strapi';
import { getConfig } from '../config';
import type { SessionPrincipal } from './session-store';

export interface DirectoryEntry {
  instance: string;
  /** Internal-facing URL of the owning instance (e.g. http://10.0.0.5:1337). */
  address: string;
  adminUserId: string;
  clientId: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Redis-backed mapping from session id to its owning instance. No-op (returns
 * null / 0) when Redis is disabled OR when `redis.internalAddress` is not
 * configured — in that case sessions stay process-local and the cluster must
 * use sticky load balancing.
 */
export default ({ strapi }: { strapi: Core.Strapi }) => {
  async function client() {
    const cfg = getConfig(strapi);
    if (!cfg.redis?.enabled || !cfg.redis.internalAddress) return null;
    return strapi.plugin('mcp-server').service('redis').get();
  }

  function key(...parts: string[]): string {
    return strapi.plugin('mcp-server').service('redis').key('sess', ...parts);
  }

  function principalKey(adminUserId: string, clientId: string): string {
    return `${adminUserId}:${clientId}`;
  }

  return {
    /**
     * Returns true when this slice's session-routing features are enabled.
     * Callers use this to decide whether to consult Redis or stay local-only.
     */
    async isActive(): Promise<boolean> {
      const r = await client();
      return r !== null;
    },

    async register(entry: DirectoryEntry & { id: string }): Promise<void> {
      const r = await client();
      if (!r) return;
      const ttlSec = Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000));
      const pkey = principalKey(entry.adminUserId, entry.clientId);
      // Multi-step write — Redis client doesn't expose pipelining in our
      // narrow interface so we do small sequential calls. Worth tightening
      // if this shows up in load testing.
      await r.hset(key(entry.id), 'instance', entry.instance);
      await r.hset(key(entry.id), 'address', entry.address);
      await r.hset(key(entry.id), 'adminUserId', entry.adminUserId);
      await r.hset(key(entry.id), 'clientId', entry.clientId);
      await r.hset(key(entry.id), 'createdAt', String(entry.createdAt));
      await r.hset(key(entry.id), 'expiresAt', String(entry.expiresAt));
      await r.expire(key(entry.id), ttlSec);
      await r.sadd(key('idx', pkey), entry.id);
      await r.expire(key('idx', pkey), ttlSec);
    },

    async lookup(id: string): Promise<DirectoryEntry | null> {
      const r = await client();
      if (!r) return null;
      const h = await r.hgetall(key(id));
      if (!h || !h.instance) return null;
      // Heartbeat check: if the owning instance is no longer publishing
      // heartbeats, the entry is orphaned. Drop it and report not-found so
      // the client gets a clean 404 → re-init instead of a 502 from a
      // failed proxy attempt.
      const alive = await strapi
        .plugin('mcp-server')
        .service('heartbeat')
        .isAlive(h.instance);
      if (!alive) {
        await this.unregister(id, {
          adminUserId: h.adminUserId,
          clientId: h.clientId,
          jti: '',
        });
        return null;
      }
      return {
        instance: h.instance,
        address: h.address,
        adminUserId: h.adminUserId,
        clientId: h.clientId,
        createdAt: Number(h.createdAt) || 0,
        expiresAt: Number(h.expiresAt) || 0,
      };
    },

    async unregister(id: string, principal?: SessionPrincipal): Promise<void> {
      const r = await client();
      if (!r) return;
      await r.del(key(id));
      if (principal) {
        await r.srem(key('idx', principalKey(principal.adminUserId, principal.clientId)), id);
      }
    },

    /** Count current sessions for a principal across the cluster. */
    async countForPrincipal(adminUserId: string, clientId: string): Promise<number> {
      const r = await client();
      if (!r) return 0;
      return r.scard(key('idx', principalKey(adminUserId, clientId)));
    },

    /** Session ids belonging to a principal across the cluster. */
    async sessionsForPrincipal(adminUserId: string, clientId: string): Promise<string[]> {
      const r = await client();
      if (!r) return [];
      return r.smembers(key('idx', principalKey(adminUserId, clientId)));
    },
  };
};
