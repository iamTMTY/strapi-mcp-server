'use strict';

import {
  SignJWT,
  jwtVerify,
  type JWTPayload,
  createLocalJWKSet,
  createRemoteJWKSet,
  type JWTVerifyGetKey,
} from 'jose';
import { createHash, randomBytes } from 'crypto';
import type { Core } from '@strapi/strapi';
import { getConfig } from '../../config';
import { authorizationServerUrl, canonicalResourceUrl } from './audience';
import { ALL_SCOPES, scopeString, parseScope, type Scope } from './scopes';

// Remote-JWKS cache for external AS mode. jose's createRemoteJWKSet has its
// own internal HTTP cache (~10 min default); we just avoid recreating the
// callable on every request.
let externalJwksCache: { uri: string; jwks: JWTVerifyGetKey } | null = null;
function getExternalJwks(uri: string): JWTVerifyGetKey {
  if (!externalJwksCache || externalJwksCache.uri !== uri) {
    externalJwksCache = { uri, jwks: createRemoteJWKSet(new URL(uri)) };
  }
  return externalJwksCache.jwks;
}

const REFRESH_UID = 'plugin::mcp-server.oauth-refresh-token';
const REVOKE_UID = 'plugin::mcp-server.oauth-revocation';

export interface MintResult {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  jti: string;
  familyId: string;
}

export interface VerifiedClaims {
  sub: string;
  scope: Scope[];
  clientId: string;
  jti: string;
  exp: number;
}

export interface RefreshRow {
  id: number;
  tokenHash: string;
  familyId: string;
  parentJti: string | null;
  clientId: string;
  adminUserId: string;
  scope: string;
  rotatedTo: string | null;
  revoked: boolean;
  expiresAt: string;
}

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

  return {
    /**
     * Mint a fresh access+refresh pair. New family — caller passes a stable
     * familyId if this is a refresh rotation.
     */
    async mint(opts: {
      adminUserId: string;
      clientId: string;
      scope: Scope[];
      familyId?: string;
      parentJti?: string;
    }): Promise<MintResult> {
      const cfg = getConfig(strapi);
      const key = await strapi.plugin('mcp-server').service('signing-keys').getActiveKey();
      const now = Math.floor(Date.now() / 1000);
      const jti = randomBytes(16).toString('hex');
      const issuer = authorizationServerUrl(strapi);
      const audience = canonicalResourceUrl(strapi);

      const payload: JWTPayload = {
        scope: scopeString(opts.scope),
        client_id: opts.clientId,
        azp: opts.clientId,
        jti,
      };
      const accessToken = await new SignJWT(payload)
        .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'at+jwt' })
        .setIssuer(issuer)
        .setSubject(opts.adminUserId)
        .setAudience(audience)
        .setIssuedAt(now)
        .setExpirationTime(now + cfg.oauth.accessTokenTtlSec)
        .sign(key.privateKey);

      const refreshSecret = randomBytes(32).toString('base64url');
      const familyId = opts.familyId ?? randomBytes(16).toString('hex');
      const refreshExp = new Date((now + cfg.oauth.refreshTokenTtlSec) * 1000);

      await strapi.db.query(REFRESH_UID).create({
        data: {
          tokenHash: sha256(refreshSecret),
          familyId,
          parentJti: opts.parentJti ?? null,
          clientId: opts.clientId,
          adminUserId: opts.adminUserId,
          scope: scopeString(opts.scope),
          revoked: false,
          rotatedTo: null,
          expiresAt: refreshExp,
        },
      });

      return {
        accessToken,
        refreshToken: refreshSecret,
        accessTokenExpiresAt: new Date((now + cfg.oauth.accessTokenTtlSec) * 1000),
        refreshTokenExpiresAt: refreshExp,
        jti,
        familyId,
      };
    },

    /**
     * Verify an access JWT. Two modes, picked from `oauth.mode`:
     *
     *  - **embedded** (default): verify against the plugin's own JWKS, check
     *    iss/aud/exp + revocation list. `sub` is already a Strapi admin user id.
     *  - **external**: verify against the configured external AS's JWKS, check
     *    iss/exp. Map the JWT's email-style claim back to a Strapi admin
     *    user (the JWT's `sub` is the external identity, NOT a Strapi id, so
     *    we resolve it server-side and present a Strapi admin id to callers).
     *
     * Throws Error('invalid_token' | 'expired') on failure.
     */
    async verifyAccessToken(token: string): Promise<VerifiedClaims> {
      const cfg = getConfig(strapi);
      if (cfg.oauth.mode === 'external') {
        return verifyExternal(strapi, token);
      }
      return verifyEmbedded(strapi, token);
    },

    /**
     * Atomically consume a refresh token: returns the previous row only if it
     * was still rotatable. Reuse (rotatedTo set, or revoked) returns null AND
     * triggers family-wide revocation.
     */
    async consumeRefresh(refreshSecret: string): Promise<RefreshRow | null> {
      const hash = sha256(refreshSecret);
      const row = (await strapi.db.query(REFRESH_UID).findOne({
        where: { tokenHash: hash },
      })) as RefreshRow | null;
      if (!row) return null;

      if (new Date(row.expiresAt).getTime() < Date.now()) {
        return null;
      }
      if (row.revoked || row.rotatedTo) {
        // Reuse detection: nuke the whole family.
        await this.revokeFamily(row.familyId);
        strapi.log.warn(
          `[mcp-server] refresh-token reuse detected family=${row.familyId} client=${row.clientId} — family revoked`
        );
        return null;
      }
      return row;
    },

    async markRotated(parentRowId: number, newRefreshHash: string): Promise<void> {
      await strapi.db
        .query(REFRESH_UID)
        .update({ where: { id: parentRowId }, data: { rotatedTo: newRefreshHash } });
    },

    async revokeFamily(familyId: string): Promise<void> {
      await strapi.db.query(REFRESH_UID).updateMany({
        where: { familyId },
        data: { revoked: true },
      });
    },

    async revokeRefresh(refreshSecret: string): Promise<void> {
      const hash = sha256(refreshSecret);
      const row = (await strapi.db
        .query(REFRESH_UID)
        .findOne({ where: { tokenHash: hash } })) as RefreshRow | null;
      if (row) await this.revokeFamily(row.familyId);
    },

    async revokeAccessJti(jti: string, expiresAt: Date): Promise<void> {
      try {
        await strapi.db.query(REVOKE_UID).create({ data: { jti, expiresAt } });
      } catch {
        // unique constraint collision — already revoked, ignore
      }
    },

    async revokeAllForUser(adminUserId: string): Promise<void> {
      await strapi.db.query(REFRESH_UID).updateMany({
        where: { adminUserId, revoked: false },
        data: { revoked: true },
      });
    },

    /** Daily purge — drops expired refresh tokens and revocation entries. */
    async purgeExpired(): Promise<void> {
      const now = new Date();
      await strapi.db.query(REFRESH_UID).deleteMany({ where: { expiresAt: { $lt: now } } });
      await strapi.db.query(REVOKE_UID).deleteMany({ where: { expiresAt: { $lt: now } } });
      await strapi.db
        .query('plugin::mcp-server.oauth-auth-code')
        .deleteMany({ where: { expiresAt: { $lt: now } } });
    },

    hash(s: string): string {
      return sha256(s);
    },
  };
};

async function verifyEmbedded(
  strapi: Core.Strapi,
  token: string
): Promise<VerifiedClaims> {
  const sk = strapi.plugin('mcp-server').service('signing-keys');
  const jwks = createLocalJWKSet(await sk.publicJwks());
  const issuer = authorizationServerUrl(strapi);
  const audience = canonicalResourceUrl(strapi);

  let claims: JWTPayload;
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    claims = payload;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_JWT_EXPIRED') throw new Error('expired');
    throw new Error('invalid_token');
  }

  const jti = typeof claims.jti === 'string' ? claims.jti : '';
  if (!jti) throw new Error('invalid_token');

  const revoked = await strapi.db.query(REVOKE_UID).findOne({ where: { jti } });
  if (revoked) throw new Error('invalid_token');

  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const clientId = typeof claims.client_id === 'string' ? claims.client_id : '';
  if (!sub || !clientId) throw new Error('invalid_token');

  return {
    sub,
    scope: parseScope(claims.scope),
    clientId,
    jti,
    exp: typeof claims.exp === 'number' ? claims.exp : 0,
  };
}

async function verifyExternal(
  strapi: Core.Strapi,
  token: string
): Promise<VerifiedClaims> {
  const cfg = getConfig(strapi);
  const ext = cfg.oauth.external;
  if (!ext) throw new Error('invalid_token');
  const jwks = getExternalJwks(ext.jwksUri);

  let claims: JWTPayload;
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ext.issuer,
      // No audience check in external mode — external AS owns aud.
    });
    claims = payload;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_JWT_EXPIRED') throw new Error('expired');
    throw new Error('invalid_token');
  }

  const lookupClaim = ext.adminLookupClaim ?? 'email';
  const lookupValue = (claims as Record<string, unknown>)[lookupClaim];
  if (typeof lookupValue !== 'string' || !lookupValue) {
    throw new Error('invalid_token');
  }
  const adminWhere =
    lookupClaim === 'email' ? { email: lookupValue } : { username: lookupValue };
  const admin = (await strapi.db
    .query('admin::user')
    .findOne({ where: adminWhere })) as
    | { id: number; isActive?: boolean; blocked?: boolean }
    | null;
  if (!admin || admin.isActive === false || admin.blocked) {
    throw new Error('invalid_token');
  }

  const clientId =
    typeof claims.azp === 'string'
      ? claims.azp
      : typeof claims.client_id === 'string'
        ? claims.client_id
        : 'external';

  // Scope handling in external mode:
  //  - enforceScopes: true  → require strapi:* scopes in the JWT (operator
  //    must define them as Client Scopes in the IdP)
  //  - enforceScopes: false (default) → grant the full surface, leaving
  //    granular control to Strapi RBAC + per-tool toggles. Keeps setup
  //    cross-IdP portable without per-vendor scope registration.
  const scope: Scope[] = ext.enforceScopes
    ? parseScope(claims.scope)
    : [...ALL_SCOPES];

  return {
    sub: String(admin.id),
    scope,
    clientId,
    jti: typeof claims.jti === 'string' ? claims.jti : '',
    exp: typeof claims.exp === 'number' ? claims.exp : 0,
  };
}
