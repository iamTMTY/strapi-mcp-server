'use strict';

/**
 * Admin API routes. Every route requires an authenticated admin AND a
 * specific permission registered in `register.ts`. The role UI checkboxes
 * map onto these endpoints 1:1 so toggling them in **Settings →
 * Administration Panel → Roles** has the obvious effect.
 *
 * Permissions:
 *   `plugin::mcp-server.read`           → dashboard, settings, tools
 *   `plugin::mcp-server.audit.read`     → audit log
 *   `plugin::mcp-server.clients.manage` → OAuth clients CRUD
 *
 * Settings are read-only from the UI (mutations happen in `config/plugins.ts`),
 * so there's no separate "manage settings" permission — exposing a runtime
 * mutation surface would let admins weaken security without an audit trail.
 */
const requirePermission = (action: string) => [
  'admin::isAuthenticatedAdmin',
  { name: 'admin::hasPermissions', config: { actions: [action] } },
];

const readPolicies = requirePermission('plugin::mcp-server.read');
const auditPolicies = requirePermission('plugin::mcp-server.audit.read');
const clientPolicies = requirePermission('plugin::mcp-server.clients.manage');

export default {
  type: 'admin' as const,
  routes: [
    {
      method: 'GET',
      path: '/dashboard',
      handler: 'dashboard.overview',
      config: { policies: readPolicies },
    },
    {
      method: 'GET',
      path: '/clients',
      handler: 'clients.list',
      config: { policies: clientPolicies },
    },
    {
      method: 'POST',
      path: '/clients',
      handler: 'clients.create',
      config: { policies: clientPolicies },
    },
    {
      method: 'GET',
      path: '/clients/:clientId',
      handler: 'clients.findOne',
      config: { policies: clientPolicies },
    },
    {
      method: 'PUT',
      path: '/clients/:clientId',
      handler: 'clients.update',
      config: { policies: clientPolicies },
    },
    {
      method: 'DELETE',
      path: '/clients/:clientId',
      handler: 'clients.destroy',
      config: { policies: clientPolicies },
    },
    {
      method: 'GET',
      path: '/audit',
      handler: 'audit.list',
      config: { policies: auditPolicies },
    },
    {
      method: 'GET',
      path: '/settings',
      handler: 'settings.get',
      config: { policies: readPolicies },
    },
    {
      method: 'GET',
      path: '/tools',
      handler: 'tools.list',
      config: { policies: readPolicies },
    },
  ],
};
