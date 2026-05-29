'use strict';

import type { Core } from '@strapi/strapi';
import { getConfig } from '../config';

const UID = 'plugin::mcp-server.audit-log';

export interface AuditEntry {
  ts: Date;
  principalType: 'admin' | 'system';
  principalId: string;
  sessionId?: string;
  clientId?: string;
  tool: string;
  params?: unknown;
  resultStatus: 'ok' | 'error';
  errorCode?: string;
  ip?: string;
  userAgent?: string;
  durationMs?: number;
}

let queue: AuditEntry[] = [];

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const cfg = () => getConfig(strapi);

  return {
    record(entry: AuditEntry): void {
      const redacted: AuditEntry = {
        ...entry,
        params: redact(entry.params, cfg().audit.redactKeyPatterns),
      };
      queue.push(redacted);
      if (queue.length >= cfg().audit.drainBatchSize) {
        void this.drain();
      }
    },

    async drain(): Promise<void> {
      if (queue.length === 0) return;
      const batch = queue;
      queue = [];
      try {
        await strapi.db.query(UID).createMany({ data: batch });
      } catch (err) {
        strapi.log.error('[mcp-server] audit write failed; dropping batch', err as Error);
      }
    },

    async purgeOlderThan(days: number): Promise<number> {
      const cutoff = new Date(Date.now() - days * 86400 * 1000);
      const { count } = await strapi.db.query(UID).deleteMany({ where: { ts: { $lt: cutoff } } });
      return count ?? 0;
    },

    async recent(limit = 50, filters: Record<string, unknown> = {}): Promise<AuditEntry[]> {
      return strapi.db
        .query(UID)
        .findMany({ where: filters, orderBy: { ts: 'desc' }, limit: Math.min(500, limit) });
    },

    /**
     * Resolve admin user + OAuth client info for a batch of audit rows. Used
     * by both the audit list and the dashboard's recent-calls panel so they
     * present principal as a human name instead of a raw numeric ID, and so
     * the OAuth client (Claude Code, etc.) is identified by name.
     */
    async enrich(
      rows: Array<{ principalId?: string | null; clientId?: string | null }>
    ): Promise<
      Array<{
        principalAdmin: AdminUserRow | null;
        client: { clientId: string; clientName: string } | null;
      }>
    > {
      const adminIds = Array.from(
        new Set(
          rows
            .map((r) => r.principalId)
            .filter((v): v is string => typeof v === 'string' && v.length > 0)
            .map((s) => Number(s))
            .filter((n) => Number.isFinite(n))
        )
      );
      const clientIds = Array.from(
        new Set(
          rows
            .map((r) => r.clientId)
            .filter((v): v is string => typeof v === 'string' && v.length > 0)
        )
      );

      const [admins, clients] = await Promise.all([
        adminIds.length
          ? (strapi.db.query('admin::user').findMany({
              where: { id: { $in: adminIds } },
              select: ['id', 'email', 'firstname', 'lastname', 'username'],
            }) as Promise<AdminUserRow[]>)
          : Promise.resolve<AdminUserRow[]>([]),
        clientIds.length
          ? (strapi.db.query('plugin::mcp-server.oauth-client').findMany({
              where: { clientId: { $in: clientIds } },
              select: ['clientId', 'clientName'],
            }) as Promise<Array<{ clientId: string; clientName: string }>>)
          : Promise.resolve<Array<{ clientId: string; clientName: string }>>([]),
      ]);

      const adminById = new Map(admins.map((a) => [String(a.id), a]));
      const clientById = new Map(clients.map((c) => [c.clientId, c]));

      return rows.map((r) => ({
        principalAdmin: r.principalId ? adminById.get(r.principalId) ?? null : null,
        client: r.clientId ? clientById.get(r.clientId) ?? null : null,
      }));
    },

    /** Test/diagnostic only. */
    _peekQueue(): AuditEntry[] {
      return [...queue];
    },
  };
};

export interface AdminUserRow {
  id: number;
  email?: string;
  firstname?: string;
  lastname?: string;
  username?: string;
}

const TRUNCATE_AT = 2048;

export function redact(value: unknown, patterns: string[]): unknown {
  const regex = new RegExp(`(${patterns.join('|')})`, 'i');
  return walk(value, regex, 0);
}

function walk(value: unknown, regex: RegExp, depth: number): unknown {
  if (depth > 6) return '[truncated:depth]';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > TRUNCATE_AT) {
      return value.slice(0, TRUNCATE_AT) + '…';
    }
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => walk(v, regex, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (regex.test(k)) {
      out[k] = '[redacted]';
    } else {
      out[k] = walk(v, regex, depth + 1);
    }
  }
  return out;
}
