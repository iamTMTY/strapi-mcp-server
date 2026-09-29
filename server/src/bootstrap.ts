'use strict';

import type { Core } from '@strapi/strapi';
import { getConfig, isConfigured } from './config';

interface PluginRuntime {
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
  if (!isConfigured(cfg)) return;

  const rt = runtime(strapi);

  // OAuth signing keys must exist before any token is issued.
  await strapi.plugin('mcp-server').service('signing-keys').ensureActiveKey();

  // Eagerly connect to Redis (if enabled) so configuration errors surface at
  // boot instead of on the first rate-limited request.
  if (cfg.redis?.enabled && !(await strapi.plugin('mcp-server').service('redis').get())) {
    strapi.log.warn(
      '[mcp-server] redis enabled but client unavailable — falling back to in-memory rate limiting'
    );
  }

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
          await s.plugin('mcp-server').service('upload-tickets').purgeExpired();
          // Drop DCR clients that never reached consent (no owner, no related
          // codes/tokens/consents) and are older than 1h — a backstop for the
          // immediate sweep at consent-grant time, in case a connect attempt
          // is abandoned before consent.
          await s
            .plugin('mcp-server')
            .service('clients')
            .purgeOrphans(60 * 60 * 1000);
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
