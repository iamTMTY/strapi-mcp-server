'use strict';

import { generateKeyPair, exportJWK, importJWK, type JWK, type KeyLike } from 'jose';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'crypto';
import type { Core } from '@strapi/strapi';

const UID = 'plugin::mcp-server.oauth-signing-key';

export interface ActiveKey {
  kid: string;
  alg: string;
  publicJwk: JWK;
  privateKey: KeyLike;
}

interface KeyRow {
  id: number;
  kid: string;
  alg: string;
  publicJwk: JWK;
  privateJwkEncrypted: string;
  retiredAt: string | null;
}

let cached: ActiveKey | null = null;

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Generate-on-first-boot. Idempotent: if an active (non-retired) key exists
   * AND can be decrypted, load and cache it. If a row exists but can't be
   * decrypted (e.g. legacy null/garbled value from a prior boot before this
   * fix), the row is dropped and a new key is minted in its place.
   */
  async ensureActiveKey(): Promise<ActiveKey> {
    if (cached) return cached;

    const existing = (await strapi.db.query(UID).findOne({
      where: { retiredAt: { $null: true } },
      orderBy: { id: 'desc' },
    })) as KeyRow | null;

    if (existing) {
      try {
        const decrypted = decryptBlob(strapi, existing.privateJwkEncrypted);
        const jwk = JSON.parse(decrypted) as JWK;
        const privateKey = (await importJWK(jwk, existing.alg)) as KeyLike;
        cached = {
          kid: existing.kid,
          alg: existing.alg,
          publicJwk: { ...existing.publicJwk, kid: existing.kid, alg: existing.alg, use: 'sig' },
          privateKey,
        };
        return cached;
      } catch (err) {
        strapi.log.warn(
          `[mcp-server] existing signing key kid=${existing.kid} could not be decrypted (${
            (err as Error).message
          }); discarding and regenerating`
        );
        await strapi.db.query(UID).delete({ where: { id: existing.id } });
      }
    }

    const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
    const publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);
    const kid = randomBytes(16).toString('hex');
    publicJwk.kid = kid;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';

    const encrypted = encryptBlob(strapi, JSON.stringify(privateJwk));
    await strapi.db.query(UID).create({
      data: {
        kid,
        alg: 'RS256',
        publicJwk,
        privateJwkEncrypted: encrypted,
      },
    });

    cached = { kid, alg: 'RS256', publicJwk, privateKey };
    strapi.log.info(`[mcp-server] minted OAuth signing key kid=${kid}`);
    return cached;
  },

  async getActiveKey(): Promise<ActiveKey> {
    return cached ?? this.ensureActiveKey();
  },

  /** JWKS endpoint payload — public keys only, includes retired-but-not-purged. */
  async publicJwks(): Promise<{ keys: JWK[] }> {
    const rows = (await strapi.db.query(UID).findMany({
      orderBy: { id: 'desc' },
      limit: 10,
    })) as KeyRow[];
    return {
      keys: rows.map((r) => ({ ...r.publicJwk, kid: r.kid, alg: r.alg, use: 'sig' })),
    };
  },

  invalidateCache(): void {
    cached = null;
  },
});

/**
 * Derive a 32-byte AES-256 key from APP_KEYS + ADMIN_JWT_SECRET via HKDF.
 * This is self-contained — we don't rely on Strapi's admin encryption service,
 * which requires extra config and is silently nullable in some setups.
 *
 * Threat model: rotating APP_KEYS invalidates stored signing keys; we handle
 * that by regenerating on decrypt failure (see ensureActiveKey above).
 */
function deriveKey(strapi: Core.Strapi): Buffer {
  const appKeys = (strapi.config.get('app.keys') as string[] | undefined) ?? [];
  const adminSecret =
    (strapi.config.get('admin.auth.secret') as string | undefined) ?? '';
  const material = `${appKeys.join('|')}|${adminSecret}`;
  if (material === '|') {
    throw new Error(
      '[mcp-server] APP_KEYS and ADMIN_JWT_SECRET must be configured for signing-key encryption'
    );
  }
  return Buffer.from(
    hkdfSync('sha256', material, 'strapi-mcp-server-salt', 'oauth-signing-key:v1', 32)
  );
}

function encryptBlob(strapi: Core.Strapi, plaintext: string): string {
  const key = deriveKey(strapi);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${enc.toString('base64url')}`;
}

function decryptBlob(strapi: Core.Strapi, blob: string): string {
  if (!blob || typeof blob !== 'string') {
    throw new Error('encrypted blob is null or non-string');
  }
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('unrecognized blob format');
  }
  const key = deriveKey(strapi);
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const enc = Buffer.from(parts[3], 'base64url');
  // Pin authTagLength to 16 bytes (GCM's full 128-bit tag) so an attacker who
  // can forge the stored blob can't downgrade to a shorter tag and brute-force
  // it. encryptBlob always emits a 16-byte tag via getAuthTag(); reject any
  // blob that doesn't match before handing it to setAuthTag.
  if (tag.length !== 16) {
    throw new Error('GCM auth tag has unexpected length');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
