'use strict';

import type { Core } from '@strapi/strapi';
import { getConfig } from '../../config';
import { scopeString, type Scope } from './scopes';

const UID = 'plugin::mcp-server.oauth-consent';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Check whether a (client, admin, scope-set) consent is still active.
   * Returns false when rememberDays is 0 — i.e. always prompt.
   */
  async hasActiveConsent(
    clientId: string,
    adminUserId: string,
    scopes: Scope[]
  ): Promise<boolean> {
    const cfg = getConfig(strapi);
    if (cfg.oauth.consent.rememberDays <= 0) return false;
    const row = await strapi.db.query(UID).findOne({
      where: { clientId, adminUserId, scope: scopeString(scopes) },
    });
    if (!row) return false;
    return new Date(row.expiresAt).getTime() > Date.now();
  },

  async record(clientId: string, adminUserId: string, scopes: Scope[]): Promise<void> {
    const cfg = getConfig(strapi);
    const grantedAt = new Date();
    const expiresAt = new Date(
      grantedAt.getTime() + cfg.oauth.consent.rememberDays * 86400 * 1000
    );
    await strapi.db.query(UID).create({
      data: { clientId, adminUserId, scope: scopeString(scopes), grantedAt, expiresAt },
    });
  },
});
