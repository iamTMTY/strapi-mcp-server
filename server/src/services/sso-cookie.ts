'use strict';

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Core } from '@strapi/strapi';
import { getConfig } from '../config';

const COOKIE_NAME = 'mcp_admin_sso';
const RESUME_COOKIE_NAME = 'mcp_resume';
const RESUME_TTL_SEC = 600;

interface CookiePayload {
  adminId: string;
  /**
   * Strapi admin session id captured at handoff time. We re-check it against
   * `strapi.sessionManager('admin').isSessionActive` on every verify so that
   * logging out of Strapi admin immediately invalidates our SSO cookie too —
   * otherwise our own TTL would let a logged-out user breeze past /authorize.
   * Older cookies issued before this field was added omit it; we treat those
   * as invalid to fail closed.
   */
  sid?: string;
  exp: number;
  nonce: string;
}

interface ResumePayload {
  url: string;
  exp: number;
}

/**
 * The SSO cookie is HMAC'd with a key derived from the active OAuth signing key
 * (kid + Strapi APP_KEYS). Never uses ADMIN_JWT_SECRET. The cookie body is
 * base64url(JSON) and the signature is the second segment.
 */
export default ({ strapi }: { strapi: Core.Strapi }) => {
  async function hmacKey(): Promise<string> {
    const key = await strapi.plugin('mcp-server').service('signing-keys').getActiveKey();
    const appKeys = strapi.config.get('app.keys') as string[] | undefined;
    return `${key.kid}.${(appKeys ?? []).join('|')}`;
  }

  function sign(value: string, key: string): string {
    return createHmac('sha256', key).update(value).digest('base64url');
  }

  return {
    cookieName(): string {
      return COOKIE_NAME;
    },

    resumeCookieName(): string {
      return RESUME_COOKIE_NAME;
    },

    /**
     * Sign a resume URL into a short-lived cookie. Used to survive Strapi's
     * /auth/login redirectTo round-trip, which double-decodes the value and
     * mangles nested OAuth query strings. The cookie is the source of truth;
     * the URL `next` param is best-effort fallback.
     */
    async issueResume(url: string): Promise<{ value: string; maxAgeSec: number }> {
      const payload: ResumePayload = {
        url,
        exp: Math.floor(Date.now() / 1000) + RESUME_TTL_SEC,
      };
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = sign(body, await hmacKey());
      return { value: `${body}.${sig}`, maxAgeSec: RESUME_TTL_SEC };
    },

    async verifyResume(cookieValue: string | undefined): Promise<string | null> {
      if (!cookieValue) return null;
      const [body, sig] = cookieValue.split('.');
      if (!body || !sig) return null;
      const expected = sign(body, await hmacKey());
      if (expected.length !== sig.length) return null;
      try {
        if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
      } catch {
        return null;
      }
      try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ResumePayload;
        if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
        if (typeof payload.url !== 'string' || !payload.url.startsWith('/')) return null;
        return payload.url;
      } catch {
        return null;
      }
    },

    async issue(
      adminId: string,
      sessionId: string
    ): Promise<{ value: string; maxAgeSec: number }> {
      const cfg = getConfig(strapi);
      const exp = Math.floor(Date.now() / 1000) + cfg.oauth.ssoCookieTtlSec;
      const payload: CookiePayload = {
        adminId,
        sid: sessionId,
        exp,
        nonce: randomBytes(12).toString('base64url'),
      };
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = sign(body, await hmacKey());
      return { value: `${body}.${sig}`, maxAgeSec: cfg.oauth.ssoCookieTtlSec };
    },

    async verify(cookieValue: string | undefined): Promise<string | null> {
      if (!cookieValue) return null;
      const [body, sig] = cookieValue.split('.');
      if (!body || !sig) return null;
      const expected = sign(body, await hmacKey());
      if (expected.length !== sig.length) return null;
      try {
        if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
      } catch {
        return null;
      }
      let payload: CookiePayload;
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CookiePayload;
      } catch {
        return null;
      }
      if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
      if (typeof payload.adminId !== 'string' || !payload.adminId) return null;
      if (typeof payload.sid !== 'string' || !payload.sid) return null;
      // Re-check the bound Strapi admin session is still active. When the
      // admin logs out, Strapi calls invalidateRefreshToken which deletes the
      // session row; this check then returns false and the cookie is
      // effectively dead even though our own TTL hasn't expired yet.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sm = strapi.sessionManager('admin' as any);
        const active: boolean = await sm.isSessionActive(payload.sid);
        if (!active) return null;
      } catch {
        // Defensive: if the session manager isn't available, fail closed.
        return null;
      }
      return payload.adminId;
    },
  };
};
