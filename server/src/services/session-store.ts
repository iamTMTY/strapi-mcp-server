'use strict';

import type { Core } from '@strapi/strapi';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getConfig } from '../config';
import type { Scope } from './oauth/scopes';

export interface SessionPrincipal {
  adminUserId: string;
  clientId: string;
  jti: string;
}

export interface Session {
  id: string;
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
  principal: SessionPrincipal;
  scopes: Scope[];
  createdAt: number;
  lastSeenAt: number;
}

export type Location =
  | { kind: 'local'; session: Session }
  | { kind: 'remote'; instance: string; address: string; principal: SessionPrincipal }
  | undefined;

const sessions = new Map<string, Session>();
const byPrincipal = new Map<string, Set<string>>();

export default ({ strapi }: { strapi: Core.Strapi }) => {
  function directory() {
    return strapi.plugin('mcp-server').service('session-directory');
  }
  function instanceId(): string {
    return strapi.plugin('mcp-server').service('instance-id').get();
  }
  function localPrincipalKey(p: SessionPrincipal): string {
    return `${p.adminUserId}:${p.clientId}`;
  }

  return {
    /**
     * Resolve a session id to either the local in-memory session or a remote
     * directory entry pointing at the owning instance. Returns undefined when
     * the id is unknown both locally and in Redis.
     */
    async locate(id: string): Promise<Location> {
      const local = sessions.get(id);
      if (local) {
        local.lastSeenAt = Date.now();
        return { kind: 'local', session: local };
      }
      const remote = await directory().lookup(id);
      if (!remote) return undefined;
      if (remote.instance === instanceId()) {
        // Stale directory entry — we are the owner but lost it (process
        // restart, sweep, etc.). Drop the entry so clients re-initialize.
        await directory().unregister(id, {
          adminUserId: remote.adminUserId,
          clientId: remote.clientId,
          jti: '',
        });
        return undefined;
      }
      return {
        kind: 'remote',
        instance: remote.instance,
        address: remote.address,
        principal: {
          adminUserId: remote.adminUserId,
          clientId: remote.clientId,
          jti: '',
        },
      };
    },

    /**
     * Returns false when global or per-principal caps would be exceeded. In
     * single-instance mode caps are local. With Redis routing enabled, the
     * principal cap becomes cluster-wide (queried from the directory).
     */
    async canCreate(principal: SessionPrincipal): Promise<boolean> {
      const cfg = getConfig(strapi);
      if (sessions.size >= cfg.session.maxTotal) return false;
      if (await directory().isActive()) {
        const count = await directory().countForPrincipal(
          principal.adminUserId,
          principal.clientId
        );
        return count < cfg.session.maxPerPrincipal;
      }
      const owned = byPrincipal.get(localPrincipalKey(principal))?.size ?? 0;
      return owned < cfg.session.maxPerPrincipal;
    },

    async put(session: Session): Promise<void> {
      sessions.set(session.id, session);
      const key = localPrincipalKey(session.principal);
      let set = byPrincipal.get(key);
      if (!set) {
        set = new Set();
        byPrincipal.set(key, set);
      }
      set.add(session.id);

      if (await directory().isActive()) {
        const cfg = getConfig(strapi);
        const internalAddress = cfg.redis?.internalAddress;
        if (!internalAddress) return; // Caller / config validator should have caught this.
        await directory().register({
          id: session.id,
          instance: instanceId(),
          address: internalAddress,
          adminUserId: session.principal.adminUserId,
          clientId: session.principal.clientId,
          createdAt: session.createdAt,
          expiresAt: session.createdAt + cfg.session.hardTtlMs,
        });
      }
    },

    async close(id: string): Promise<void> {
      const s = sessions.get(id);
      if (s) {
        sessions.delete(id);
        byPrincipal.get(localPrincipalKey(s.principal))?.delete(id);
        try {
          await s.transport.close();
        } catch (err) {
          strapi.log.warn(`[mcp-server] transport close failed for session=${id}`, err as Error);
        }
      }
      if (await directory().isActive()) {
        await directory().unregister(
          id,
          s
            ? s.principal
            : undefined
        );
      }
    },

    async closeAll(): Promise<void> {
      const ids = [...sessions.keys()];
      await Promise.all(ids.map((id) => this.close(id)));
    },

    /** Evict idle and hard-TTL-exceeded sessions; called periodically by bootstrap. */
    sweep(): void {
      const cfg = getConfig(strapi);
      const now = Date.now();
      const toClose: string[] = [];
      for (const [id, s] of sessions.entries()) {
        if (now - s.lastSeenAt > cfg.session.idleTtlMs) toClose.push(id);
        else if (now - s.createdAt > cfg.session.hardTtlMs) toClose.push(id);
      }
      for (const id of toClose) {
        void this.close(id);
      }
    },

    /**
     * Drop all sessions belonging to an admin user across the cluster.
     *
     * Closes local sessions immediately AND publishes on `mcp:revoke` so peer
     * instances close any sessions they own for the same principal. The
     * principal's tokens get revoked through a separate path (tokens service);
     * this only affects session liveness.
     */
    async closeForPrincipal(adminUserId: string): Promise<void> {
      await this.closeForPrincipalLocal(adminUserId);
      // Broadcast to peers — best-effort, log on failure.
      try {
        const r = await strapi.plugin('mcp-server').service('redis').get();
        if (r) {
          const channel = strapi.plugin('mcp-server').service('redis').key('revoke');
          await r.publish(channel, adminUserId);
        }
      } catch (err) {
        strapi.log.warn(
          `[mcp-server] failed to publish revocation for user=${adminUserId}: ${(err as Error).message}`
        );
      }
    },

    /**
     * Local-only variant — closes sessions for the principal on THIS instance
     * without re-publishing. The pub/sub subscriber in bootstrap calls this on
     * incoming `mcp:revoke` messages so we don't loop.
     */
    async closeForPrincipalLocal(adminUserId: string): Promise<void> {
      for (const [id, s] of sessions.entries()) {
        if (s.principal.adminUserId === adminUserId) {
          // eslint-disable-next-line no-await-in-loop
          await this.close(id);
        }
      }
    },

    stats(): { total: number; byPrincipal: Record<string, number> } {
      const byP: Record<string, number> = {};
      for (const [k, set] of byPrincipal.entries()) byP[k] = set.size;
      return { total: sessions.size, byPrincipal: byP };
    },

    /** Local-only lookup. Used by the proxy receive controller. */
    getLocal(id: string): Session | undefined {
      const s = sessions.get(id);
      if (s) s.lastSeenAt = Date.now();
      return s;
    },
  };
};
