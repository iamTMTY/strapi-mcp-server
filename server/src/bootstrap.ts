'use strict';

import type { Core } from '@strapi/strapi';
import { getConfig } from './config';

interface PluginRuntime {
  sweepTimer?: NodeJS.Timeout;
  auditTimer?: NodeJS.Timeout;
}

/**
 * Stash runtime handles on the strapi instance so destroy() can clear them.
 * Strapi's strapi.plugin('mcp-server') namespace would also work but is harder
 * to type cleanly.
 */
function runtime(strapi: Core.Strapi): PluginRuntime {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyStrapi = strapi as any;
  if (!anyStrapi.__mcpServerRuntime) anyStrapi.__mcpServerRuntime = {};
  return anyStrapi.__mcpServerRuntime as PluginRuntime;
}

export async function bootstrap({ strapi }: { strapi: Core.Strapi }): Promise<void> {
  const cfg = getConfig(strapi);
  if (!cfg.enabled) return;

  const rt = runtime(strapi);

  // OAuth signing keys must exist before any token is issued.
  await strapi.plugin('mcp-server').service('signing-keys').ensureActiveKey();

  // Eagerly connect to Redis (if enabled) so configuration errors surface at
  // boot instead of on the first request that triggers a rate-limit check.
  if (cfg.redis?.enabled) {
    const r = await strapi.plugin('mcp-server').service('redis').get();
    if (!r) {
      strapi.log.warn('[mcp-server] redis enabled but client unavailable — falling back to in-memory rate limiting');
    } else if (cfg.redis.internalAddress) {
      const id = strapi.plugin('mcp-server').service('instance-id').get();
      strapi.log.info(
        `[mcp-server] cluster instance id=${id} internal=${cfg.redis.internalAddress}`
      );

      // Start the heartbeat ticker so peers know we're alive.
      await strapi.plugin('mcp-server').service('heartbeat').start();

      // Subscribe to cluster-wide revocation events. Single channel keyed
      // `mcp:revoke`; payload is the adminUserId whose sessions should die.
      const sub = await strapi.plugin('mcp-server').service('redis').getSubscriber();
      if (sub) {
        const channel = strapi.plugin('mcp-server').service('redis').key('revoke');
        try {
          await sub.subscribe(channel);
          sub.on('message', (...args: unknown[]) => {
            const ch = args[0] as string;
            const msg = args[1] as string;
            if (ch !== channel || !msg) return;
            void strapi
              .plugin('mcp-server')
              .service('session-store')
              .closeForPrincipalLocal(msg)
              .catch((err: Error) =>
                strapi.log.warn(
                  `[mcp-server] revocation handler failed for user=${msg}: ${err.message}`
                )
              );
          });
          strapi.log.info(`[mcp-server] subscribed to revocation channel ${channel}`);
        } catch (err) {
          strapi.log.warn(
            `[mcp-server] failed to subscribe revocation channel: ${(err as Error).message}`
          );
        }
      }
    }
  }

  // Periodic session eviction (idle/hard TTLs).
  const sessionStore = strapi.plugin('mcp-server').service('session-store');
  rt.sweepTimer = setInterval(() => {
    try {
      sessionStore.sweep();
    } catch (err) {
      strapi.log.error('[mcp-server] session sweep failed', err as Error);
    }
  }, cfg.session.sweepIntervalMs);

  // Audit log drainer (buffered async writes).
  const audit = strapi.plugin('mcp-server').service('audit');
  rt.auditTimer = setInterval(() => {
    audit.drain().catch((err: Error) => strapi.log.error('[mcp-server] audit drain', err));
  }, cfg.audit.drainIntervalMs);

  // Daily cron: purge expired OAuth artifacts and old audit-log entries.
  // Strapi v5 cron format expects a record keyed by cron expression or task name.
  strapi.cron.add({
    mcpServerNightlyCleanup: {
      task: async ({ strapi: s }: { strapi: Core.Strapi }) => {
        try {
          await s.plugin('mcp-server').service('audit').purgeOlderThan(cfg.audit.retentionDays);
          await s.plugin('mcp-server').service('tokens').purgeExpired();
          // Drop DCR clients that never reached consent (no owner, no related
          // codes/tokens/consents) and are older than 1h — a backstop for the
          // immediate sweep at consent-grant time, in case a connect attempt
          // is abandoned before consent.
          await s.plugin('mcp-server').service('clients').purgeOrphans(60 * 60 * 1000);
        } catch (err) {
          s.log.error('[mcp-server] nightly cleanup failed', err as Error);
        }
      },
      options: { rule: '0 3 * * *' },
    },
  });

  strapi.log.info(
    `[mcp-server] bootstrap complete (resource=${cfg.resourceUrl}, origins=${cfg.allowedOrigins.length})`
  );
}
