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
  familyId: string | null;
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
     * Single-use, race-safe. Returns the row (with the refresh `familyId`
     * the caller must mint into) if this caller consumed it; 'replayed' if it
     * was already used — sequentially or concurrently — after revoking the
     * family the winning redemption mints into; null if unknown or expired.
     */
    async consume(code: string): Promise<AuthCodeRow | 'replayed' | null> {
      const codeHash = sha256(code);
      const row = (await strapi.db
        .query(UID)
        .findOne({ where: { codeHash } })) as AuthCodeRow | null;
      if (!row) return null;
      if (new Date(row.expiresAt).getTime() < Date.now()) return null;
      if (row.used) {
        // RFC 6749 §4.1.2: a replayed code should revoke what it minted.
        if (row.familyId) {
          await strapi.plugin('mcp-server').service('tokens').revokeFamily(row.familyId);
        }
        return 'replayed';
      }

      // Atomic claim. The winner also fixes the refresh family id in the same
      // statement, so a racing loser can always find — and revoke — it, even
      // before the winner has minted anything.
      const familyId = randomBytes(16).toString('hex');
      const { count } = await strapi.db.query(UID).updateMany({
        where: { id: row.id, used: false },
        data: { used: true, familyId },
      });
      if (count !== 1) {
        const winner = (await strapi.db
          .query(UID)
          .findOne({ where: { id: row.id } })) as AuthCodeRow | null;
        if (winner?.familyId) {
          await strapi.plugin('mcp-server').service('tokens').revokeFamily(winner.familyId);
        }
        return 'replayed';
      }
      return { ...row, used: true, familyId };
    },
  };
};
