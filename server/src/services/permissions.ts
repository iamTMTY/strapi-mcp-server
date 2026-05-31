'use strict';

import type { Core } from '@strapi/strapi';

const INTERNAL_UID =
  /^(admin::|strapi::|plugin::users-permissions\.(role|permission)|plugin::i18n\.locale|plugin::upload\.(folder|file)$|plugin::mcp-server\.)/;

export interface PrincipalContext {
  user: { id: number | string; isActive?: boolean };
  permissions: unknown[];
  isSuperAdmin: boolean;
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Load an admin user and their permissions. Used both at JWT verification time
   * (to confirm the principal still exists and is active) and at tool-call time
   * for RBAC enforcement.
   *
   * We bypass `admin::user.findOne(...)` because its `populate: ['roles']` path
   * triggered a Knex "Undefined binding" error in some Strapi installs. Going
   * direct to `strapi.db.query` is more predictable and gives us exactly the
   * shape we need (user with roles relation).
   */
  async loadPrincipal(adminUserId: string | number): Promise<PrincipalContext | null> {
    const id = typeof adminUserId === 'string' ? Number(adminUserId) || adminUserId : adminUserId;

    const user = await strapi.db.query('admin::user').findOne({
      where: { id },
      populate: { roles: true },
    });
    if (!user || user.isActive === false || user.blocked) return null;

    const roleSvc = strapi.service('admin::role');
    let isSuperAdmin = false;
    try {
      isSuperAdmin = (await roleSvc.hasSuperAdminRole(user)) === true;
    } catch {
      // Fallback: check role code locally.
      isSuperAdmin =
        Array.isArray(user.roles) &&
        user.roles.some((r: { code?: string }) => r.code === 'strapi-super-admin');
    }

    const permSvc = strapi.service('admin::permission');
    let permissions: unknown[] = [];
    try {
      // Strapi v5 signature: findUserPermissions(user) — pass the user object
      // directly, NOT wrapped in `{ user }`. Wrapping makes `user.id` resolve
      // to undefined inside the query, producing "Undefined binding ... t4.id"
      // Knex errors. Super-admins short-circuited above so this only bites
      // non-super-admin roles, masquerading as "no permissions found."
      permissions = await permSvc.findUserPermissions(user);
    } catch (err) {
      strapi.log.warn('[mcp-server] findUserPermissions failed', err as Error);
    }

    return { user, permissions, isSuperAdmin };
  },

  /**
   * Content-manager-equivalent RBAC check for a UID + action.
   * action: 'read' | 'create' | 'update' | 'delete' | 'publish'
   * Internal UIDs are denied outright regardless of role.
   */
  async canActionOnUid(
    principal: PrincipalContext,
    uid: string,
    action: 'read' | 'create' | 'update' | 'delete' | 'publish'
  ): Promise<boolean> {
    if (INTERNAL_UID.test(uid)) return false;
    if (principal.isSuperAdmin) return true;

    const actionId = `plugin::content-manager.explorer.${action}`;
    return (principal.permissions as Array<{ action: string; subject: string | null }>).some(
      (p) => p.action === actionId && (p.subject === uid || p.subject === null)
    );
  },

  isInternalUid(uid: string): boolean {
    return INTERNAL_UID.test(uid);
  },

  /** Returns allowed UIDs (collectionType + singleType, minus the denylist). */
  listAllowedUids(): string[] {
    const cts = strapi.contentTypes as unknown as Record<string, { kind?: string }>;
    return Object.keys(cts).filter(
      (uid) =>
        !INTERNAL_UID.test(uid) &&
        (cts[uid].kind === 'collectionType' || cts[uid].kind === 'singleType')
    );
  },
});
