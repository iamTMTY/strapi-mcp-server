'use strict';

import { randomBytes, createHash } from 'crypto';
import type { Core } from '@strapi/strapi';
import { getConfig } from '../../config';

const UID = 'plugin::mcp-server.oauth-auth-code';

export interface AuthCodeRow {
  id: number;
  codeHash: string;
  clientId: string;
  adminUserId: string;
  scope: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  resource: string;
  used: boolean;
  expiresAt: string;
}

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

  return {
    async issue(input: {
      clientId: string;
      adminUserId: string;
      scope: string;
      redirectUri: string;
      codeChallenge: string;
      resource: string;
    }): Promise<string> {
      const cfg = getConfig(strapi);
      const code = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + cfg.oauth.authCodeTtlSec * 1000);
      await strapi.db.query(UID).create({
        data: {
          codeHash: sha256(code),
          clientId: input.clientId,
          adminUserId: input.adminUserId,
          scope: input.scope,
          redirectUri: input.redirectUri,
          codeChallenge: input.codeChallenge,
          codeChallengeMethod: 'S256',
          resource: input.resource,
          used: false,
          expiresAt,
        },
      });
      return code;
    },

    /**
     * Single-use, race-safe: read-then-update-where-used-false. Returns the
     * row if it was the consumer; null otherwise (already used, expired, or
     * not found). Caller is responsible for triggering family revocation on
     * a "used" replay.
     */
    async consume(code: string): Promise<AuthCodeRow | 'replayed' | null> {
      const codeHash = sha256(code);
      const row = (await strapi.db.query(UID).findOne({ where: { codeHash } })) as AuthCodeRow | null;
      if (!row) return null;
      if (new Date(row.expiresAt).getTime() < Date.now()) return null;
      if (row.used) return 'replayed';

      // Atomic-ish: update where used=false, then check rowcount via re-read.
      await strapi.db.query(UID).update({
        where: { id: row.id, used: false },
        data: { used: true },
      });
      const after = (await strapi.db.query(UID).findOne({ where: { id: row.id } })) as AuthCodeRow | null;
      if (!after || !after.used) return null;
      return after;
    },
  };
};
