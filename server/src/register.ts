'use strict';

import type { Core } from '@strapi/strapi';
import { getConfig, isConfigured } from './config';
import { uploadSizeGuard } from './controllers/uploads';

/**
 * Runs once at Strapi init, before bootstrap. Validates config again as a
 * belt-and-suspenders measure (config.validator is the primary gate) and
 * registers RBAC permission actions for the plugin's admin pages.
 */
export async function register({ strapi }: { strapi: Core.Strapi }): Promise<void> {
  const cfg = getConfig(strapi);

  // Admin permissions are registered even when unconfigured, so the admin
  // pages can load and say so.
  if (!isConfigured(cfg)) {
    strapi.log.warn(
      '[mcp-server] not configured (no resourceUrl) — /mcp and /oauth/* will return 404 until it is set'
    );
  }

  // Three permissions, each gating a distinct slice of the admin API:
  //   read         → dashboard, settings (read-only), tools list, sidebar entry
  //   audit.read   → audit log
  //   clients.manage → OAuth client CRUD
  // Settings has no "manage" because mutations happen in config/plugins.ts —
  // the admin UI is view-only.
  // Before Strapi's body parser (register precedes middleware init), so an
  // oversized one-time upload is refused before anything hits disk.
  strapi.server.use(uploadSizeGuard(strapi));

  const actionProvider = strapi.service('admin::permission').actionProvider;
  await actionProvider.registerMany([
    {
      uid: 'read',
      displayName: 'Read MCP dashboard',
      pluginName: 'mcp-server',
      section: 'plugins',
    },
    {
      uid: 'audit.read',
      displayName: 'Read MCP audit log',
      pluginName: 'mcp-server',
      section: 'plugins',
    },
    {
      uid: 'clients.manage',
      displayName: 'Manage OAuth clients',
      pluginName: 'mcp-server',
      section: 'plugins',
    },
  ]);

  strapi.log.info('[mcp-server] registered RBAC actions and validated config');
}
