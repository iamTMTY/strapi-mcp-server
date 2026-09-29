'use strict';

import type { Core } from '@strapi/strapi';

const INTERNAL_UID =
  /^(admin::|strapi::|plugin::users-permissions\.(role|permission)|plugin::i18n\.locale|plugin::upload\.(folder|file)$|plugin::mcp-server\.)/;

export const FILE_UID = 'plugin::upload.file';

export const UPLOAD_ACTIONS = {
  read: 'plugin::upload.read',
  create: 'plugin::upload.assets.create',
  update: 'plugin::upload.assets.update',
} as const;

export interface PrincipalContext {
  user: { id: number | string; isActive?: boolean; roles?: unknown[] };
  isSuperAdmin: boolean;
  /** CASL ability, generated lazily once per request (see getAbility). */
  ability?: unknown;
}

/**
 * The subset of content-manager's permission-checker the tools use. It is
 * Strapi's own enforcement: conditions ("is creator"), field-level and
 * locale permissions, plus private-field stripping on input and output.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ContentChecker {
  can: Record<string, (entity?: unknown, field?: string) => boolean>;
  cannot: Record<string, (entity?: unknown, field?: string) => boolean>;
  sanitizeOutput: (data: unknown) => Promise<any>;
  sanitizeCreateInput: (data: unknown) => Promise<any>;
  sanitizeUpdateInput: (entity: unknown) => (data: unknown) => Promise<any>;
  validateQuery: (query: unknown, opts?: { action?: string }) => Promise<void>;
  sanitizedQuery: Record<string, (query: unknown) => Promise<any>>;
}

export interface UploadPermissionsManager {
  isAllowed: boolean;
  action: string;
  ability: {
    cannot: (action: string, subject: unknown) => boolean;
    rulesFor?: (
      action: string,
      subjectType: string
    ) => Array<{ conditions?: unknown; inverted?: boolean }>;
  };
  toSubject: (entity: unknown) => unknown;
  sanitizeQuery: (query: unknown) => Promise<any>;
  addPermissionsQueryTo: (query: unknown) => any;
  sanitizeOutput: (data: unknown, opts?: { action?: string }) => Promise<any>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Load an admin user with roles. Called on every authenticated request, so
   * deactivation, blocking and role changes take effect immediately.
   *
   * We bypass `admin::user.findOne(...)` because its `populate: ['roles']` path
   * triggered a Knex "Undefined binding" error in some Strapi installs.
   */
  async loadPrincipal(adminUserId: string | number): Promise<PrincipalContext | null> {
    const id = typeof adminUserId === 'string' ? Number(adminUserId) || adminUserId : adminUserId;

    const user = await strapi.db.query('admin::user').findOne({
      where: { id },
      populate: { roles: true },
    });
    if (!user || user.isActive === false || user.blocked) return null;

    let isSuperAdmin = false;
    try {
      isSuperAdmin = (await strapi.service('admin::role').hasSuperAdminRole(user)) === true;
    } catch {
      isSuperAdmin =
        Array.isArray(user.roles) &&
        user.roles.some((r: { code?: string }) => r.code === 'strapi-super-admin');
    }
    return { user, isSuperAdmin };
  },

  /** Strapi's CASL ability for the principal. Memoised on the (per-request) principal. */
  async getAbility(principal: PrincipalContext): Promise<unknown> {
    if (!principal.ability) {
      principal.ability = await strapi
        .service('admin::permission')
        .engine.generateUserAbility(principal.user);
    }
    return principal.ability;
  },

  /** content-manager permission-checker for a UID. Internal UIDs are refused outright. */
  async contentChecker(principal: PrincipalContext, uid: string): Promise<ContentChecker> {
    if (INTERNAL_UID.test(uid)) throw forbidden();
    const userAbility = await this.getAbility(principal);
    return strapi
      .plugin('content-manager')
      .service('permission-checker')
      .create({ userAbility, model: uid }) as ContentChecker;
  },

  /** Upload-plugin permissions manager, the same one the Media Library admin API uses. */
  async uploadManager(
    principal: PrincipalContext,
    action: (typeof UPLOAD_ACTIONS)[keyof typeof UPLOAD_ACTIONS]
  ): Promise<UploadPermissionsManager> {
    const ability = await this.getAbility(principal);
    return strapi
      .service('admin::permission')
      .createPermissionsManager({ ability, action, model: FILE_UID }) as UploadPermissionsManager;
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

export function forbidden(): Error {
  const err = new Error('You do not have permission to access this content.');
  (err as Error & { code?: string }).code = 'forbidden';
  return err;
}
