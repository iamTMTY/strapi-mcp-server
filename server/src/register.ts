'use strict';

import type { Core } from '@strapi/strapi';
import { getConfig } from './config';

/**
 * Runs once at Strapi init, before bootstrap. Validates config again as a
 * belt-and-suspenders measure (config.validator is the primary gate) and
 * registers RBAC permission actions for the plugin's admin pages.
 */
export async function register({ strapi }: { strapi: Core.Strapi }): Promise<void> {
  const cfg = getConfig(strapi);

  if (!cfg.enabled) {
    strapi.log.info('[mcp-server] plugin disabled — skipping registration');
    return;
  }

  // Three permissions, each gating a distinct slice of the admin API:
  //   read         → dashboard, settings (read-only), tools list, sidebar entry
  //   audit.read   → audit log
  //   clients.manage → OAuth client CRUD
  // Settings has no "manage" because mutations happen in config/plugins.ts —
  // the admin UI is view-only.
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
