'use strict';

import type { Core } from '@strapi/strapi';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { ALL_SCOPES, parseScope, type Scope } from './scopes';

const UID = 'plugin::mcp-server.oauth-client';

export interface ClientRecord {
  id: number;
  clientId: string;
  clientName: string;
  clientSecretHash: string | null;
  isConfidential: boolean;
  redirectUris: string[];
  grantTypes: string[];
  scopes: Scope[];
  tokenEndpointAuthMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
  /**
   * Admin who granted consent to this client. NULL until first consent. UI
   * creation does NOT populate this — creation is captured in createdByAdminId.
   */
  ownerAdminId: string | null;
  /**
   * Admin who made the client appear in the table. For UI-created clients,
   * the admin who clicked Create. For DCR-created clients, the admin who
   * first granted consent (DCR itself is unauthenticated). NULL only on a
   * DCR client between its register call and its first consent.
   */
  createdByAdminId: string | null;
  disabled: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

  return {
    async findActive(clientId: string): Promise<ClientRecord | null> {
      const row = await strapi.db.query(UID).findOne({ where: { clientId, disabled: false } });
      if (!row) return null;
      return normalize(row);
    },

    /**
     * Validate that a presented `redirect_uri` matches one the client has
     * registered. Exact-match for non-loopback URIs (open-redirect mitigation).
     *
     * Loopback URIs (RFC 8252 §7.3) match leniently: scheme + host + path must
     * match, **port is ignored**. Reason: native CLI/IDE clients pick a free
     * loopback port at runtime, so requiring a fixed port forces operators to
     * either pin the client to a specific port (UX bug) or pre-register every
     * possible port (impractical). Loopback ports cannot leak the auth code to
     * another machine — they all resolve to localhost — so port leniency
     * doesn't widen the attack surface. `localhost`, `127.0.0.1`, and `[::1]`
     * are treated as equivalent hosts; clients vary on which they emit.
     */
    isAllowedRedirectUri(client: ClientRecord, redirectUri: string): boolean {
      if (typeof redirectUri !== 'string' || !redirectUri) return false;
      let presented: URL;
      try {
        presented = new URL(redirectUri);
      } catch {
        return false;
      }
      if (client.redirectUris.includes(redirectUri)) return true;
      if (!isLoopbackUrl(presented)) return false;
      return client.redirectUris.some((registered) => {
        let r: URL;
        try {
          r = new URL(registered);
        } catch {
          return false;
        }
        if (!isLoopbackUrl(r)) return false;
        return r.protocol === presented.protocol && r.pathname === presented.pathname;
      });
    },

    /** Verify a posted client_secret with constant-time compare. */
    verifySecret(client: ClientRecord, presentedSecret: string | undefined): boolean {
      if (!client.isConfidential || !client.clientSecretHash) {
        return !presentedSecret;
      }
      if (typeof presentedSecret !== 'string' || presentedSecret.length === 0) return false;
      const a = Buffer.from(sha256(presentedSecret));
      const b = Buffer.from(client.clientSecretHash);
      if (a.length !== b.length) return false;
      try {
        return timingSafeEqual(a, b);
      } catch {
        return false;
      }
    },

    async create(input: {
      clientName: string;
      redirectUris: string[];
      scopes: Scope[];
      isConfidential: boolean;
      grantTypes?: string[];
      /** Admin who clicked Create. UI passes this; DCR omits it. */
      createdByAdminId?: string;
    }): Promise<{ client: ClientRecord; clientSecret?: string }> {
      validateRedirectUris(input.redirectUris);
      const filteredScopes = input.scopes.filter((s) =>
        (ALL_SCOPES as readonly string[]).includes(s)
      );
      if (filteredScopes.length === 0) {
        throw new Error('at least one valid scope is required');
      }
      const clientId = randomBytes(16).toString('hex');
      let clientSecret: string | undefined;
      let clientSecretHash: string | null = null;
      if (input.isConfidential) {
        clientSecret = randomBytes(32).toString('base64url');
        clientSecretHash = sha256(clientSecret);
      }
      const created = await strapi.db.query(UID).create({
        data: {
          clientId,
          clientName: input.clientName,
          clientSecretHash,
          isConfidential: input.isConfidential,
          redirectUris: input.redirectUris,
          grantTypes: input.grantTypes ?? ['authorization_code', 'refresh_token'],
          scopes: filteredScopes,
          tokenEndpointAuthMethod: input.isConfidential ? 'client_secret_basic' : 'none',
          ownerAdminId: null,
          createdByAdminId: input.createdByAdminId ?? null,
          disabled: false,
        },
      });
      return { client: normalize(created), clientSecret };
    },

    async update(
      clientId: string,
      patch: Partial<{
        clientName: string;
        redirectUris: string[];
        scopes: Scope[];
        disabled: boolean;
      }>
    ): Promise<ClientRecord | null> {
      if (patch.redirectUris) validateRedirectUris(patch.redirectUris);
      if (patch.scopes) {
        patch.scopes = patch.scopes.filter((s) => (ALL_SCOPES as readonly string[]).includes(s));
      }
      const row = await strapi.db.query(UID).update({ where: { clientId }, data: patch });
      return row ? normalize(row) : null;
    },

    async list(): Promise<ClientRecord[]> {
      const rows = await strapi.db.query(UID).findMany({ orderBy: { id: 'desc' }, limit: 200 });
      return rows.map(normalize);
    },

    async touchLastUsed(clientId: string): Promise<void> {
      try {
        await strapi.db.query(UID).update({ where: { clientId }, data: { lastUsedAt: new Date() } });
      } catch {
        /* non-fatal */
      }
    },

    /**
     * Record the consenting admin as this client's owner. Also backfills
     * createdByAdminId on DCR-registered clients (which have no creator at
     * registration time) so the Clients UI can show "created by". For
     * UI-created clients, createdByAdminId is set at creation and left
     * untouched here.
     *
     * No-op for the field if it's already set — a second consent from a
     * different admin doesn't overwrite the first owner.
     */
    async setOwner(clientId: string, adminUserId: string): Promise<void> {
      try {
        const row = (await strapi.db.query(UID).findOne({ where: { clientId } })) as {
          ownerAdminId?: string | null;
          createdByAdminId?: string | null;
        } | null;
        if (!row) return;
        const patch: Record<string, string> = {};
        if (!row.ownerAdminId) patch.ownerAdminId = adminUserId;
        if (!row.createdByAdminId) patch.createdByAdminId = adminUserId;
        if (Object.keys(patch).length === 0) return;
        await strapi.db.query(UID).update({ where: { clientId }, data: patch });
      } catch {
        /* non-fatal */
      }
    },

    /**
     * Delete sibling DCR-orphan clients that match `reference` on name +
     * redirect URIs, have no owner, and have no consents / auth codes /
     * refresh tokens. Called after a consent grant succeeds — when an MCP
     * library hits `/oauth/register` multiple times during connect (RFC 7591
     * issues a fresh client per call, no idempotency), only the registration
     * that reached consent matters; the others are deletable.
     *
     * Redirect URIs are compared port-agnostically for loopback (per RFC 8252
     * §7.3 — native CLI/IDE clients pick a fresh free port each launch, so
     * `http://localhost:54321/callback` and `http://localhost:54322/callback`
     * are the same logical URI). Same canonicalization as isAllowedRedirectUri.
     */
    async purgeOrphansLike(reference: {
      clientId: string;
      clientName: string;
      redirectUris: string[];
    }): Promise<number> {
      const candidates = (await strapi.db.query(UID).findMany({
        where: { clientName: reference.clientName, createdByAdminId: null },
        limit: 200,
      })) as Array<Record<string, unknown>>;
      const targetSig = canonicalUriSetSig(reference.redirectUris);
      const toPurge: string[] = [];
      for (const row of candidates) {
        if (row.clientId === reference.clientId) continue;
        const uris = Array.isArray(row.redirectUris) ? (row.redirectUris as string[]) : [];
        if (canonicalUriSetSig(uris) !== targetSig) continue;
        if (await hasAnyRelated(strapi, row.clientId as string)) continue;
        toPurge.push(row.clientId as string);
      }
      if (toPurge.length === 0) return 0;
      // Audit writes are buffered; flush so the orphan's just-recorded
      // dcr.register row is on disk before we delete it.
      await strapi.plugin('mcp-server').service('audit').drain();
      for (const clientId of toPurge) {
        await strapi.db
          .query('plugin::mcp-server.audit-log')
          .deleteMany({ where: { clientId, tool: 'oauth.dcr.register' } });
        await this.delete(clientId);
      }
      return toPurge.length;
    },

    /**
     * Backstop sweep: drop any unowned client older than `olderThanMs` that
     * never produced a consent, auth code, or refresh token. Runs from the
     * nightly cron so accumulated orphans from incomplete DCR attempts don't
     * pollute the Clients UI long-term.
     */
    async purgeOrphans(olderThanMs: number): Promise<number> {
      const cutoff = new Date(Date.now() - olderThanMs);
      const candidates = (await strapi.db.query(UID).findMany({
        where: { createdByAdminId: null, createdAt: { $lt: cutoff } },
        limit: 500,
      })) as Array<Record<string, unknown>>;
      const toPurge: string[] = [];
      for (const row of candidates) {
        if (await hasAnyRelated(strapi, row.clientId as string)) continue;
        toPurge.push(row.clientId as string);
      }
      if (toPurge.length === 0) return 0;
      await strapi.plugin('mcp-server').service('audit').drain();
      for (const clientId of toPurge) {
        await strapi.db
          .query('plugin::mcp-server.audit-log')
          .deleteMany({ where: { clientId, tool: 'oauth.dcr.register' } });
        await this.delete(clientId);
      }
      return toPurge.length;
    },

    async delete(clientId: string): Promise<boolean> {
      const row = await strapi.db.query(UID).delete({ where: { clientId } });
      // Cascade-clean any auth codes / refresh tokens / consents tied to this
      // client so a re-registered client can't accidentally inherit state.
      await strapi.db
        .query('plugin::mcp-server.oauth-auth-code')
        .deleteMany({ where: { clientId } });
      await strapi.db
        .query('plugin::mcp-server.oauth-refresh-token')
        .deleteMany({ where: { clientId } });
      await strapi.db
        .query('plugin::mcp-server.oauth-consent')
        .deleteMany({ where: { clientId } });
      return Boolean(row);
    },
  };
};

function normalize(row: Record<string, unknown>): ClientRecord {
  return {
    id: row.id as number,
    clientId: row.clientId as string,
    clientName: row.clientName as string,
    clientSecretHash: (row.clientSecretHash as string | null) ?? null,
    isConfidential: !!row.isConfidential,
    redirectUris: Array.isArray(row.redirectUris) ? (row.redirectUris as string[]) : [],
    grantTypes: Array.isArray(row.grantTypes) ? (row.grantTypes as string[]) : [],
    scopes: parseScope(
      Array.isArray(row.scopes) ? (row.scopes as string[]).join(' ') : (row.scopes as string)
    ),
    tokenEndpointAuthMethod:
      (row.tokenEndpointAuthMethod as ClientRecord['tokenEndpointAuthMethod']) ?? 'none',
    ownerAdminId: (row.ownerAdminId as string | null) ?? null,
    createdByAdminId: (row.createdByAdminId as string | null) ?? null,
    disabled: !!row.disabled,
    createdAt: rowDateField(row, 'createdAt'),
    lastUsedAt: rowDateField(row, 'lastUsedAt'),
  };
}

/**
 * Per RFC 8252 §7.3 — a redirect URI is "loopback" if its host is localhost or
 * one of the literal IPv4/IPv6 loopback addresses. Port matching is deliberately
 * not part of the check; that's what loopback leniency is for.
 */
function isLoopbackUrl(u: URL): boolean {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function rowDateField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
}

/**
 * Build a port-agnostic, host-canonicalized signature of a redirect URI set
 * for orphan matching. Loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) all
 * collapse to `localhost` and the port is dropped — same rule the redirect-URI
 * allowlist uses, so two registrations from the same MCP client only diff by
 * a fresh loopback port still match.
 */
function canonicalUriSetSig(uris: string[]): string {
  const canon = uris.map(canonicalizeUri).filter((s) => s.length > 0);
  return JSON.stringify(canon.sort());
}

function canonicalizeUri(uri: string): string {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return uri;
  }
  const host = u.hostname.toLowerCase();
  const isLoopback =
    (u.protocol === 'http:' || u.protocol === 'https:') &&
    (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1');
  if (isLoopback) {
    return `${u.protocol}//localhost${u.pathname}${u.search}`;
  }
  return `${u.protocol}//${host}${u.port ? ':' + u.port : ''}${u.pathname}${u.search}`;
}

async function hasAnyRelated(strapi: Core.Strapi, clientId: string): Promise<boolean> {
  const checks = await Promise.all([
    strapi.db.query('plugin::mcp-server.oauth-consent').count({ where: { clientId } }),
    strapi.db.query('plugin::mcp-server.oauth-auth-code').count({ where: { clientId } }),
    strapi.db.query('plugin::mcp-server.oauth-refresh-token').count({ where: { clientId } }),
  ]);
  return checks.some((n) => (n ?? 0) > 0);
}

function validateRedirectUris(uris: string[]): void {
  if (!Array.isArray(uris) || uris.length === 0) {
    throw new Error('redirectUris must be a non-empty array');
  }
  for (const u of uris) {
    if (typeof u !== 'string') throw new Error('redirectUri must be a string');
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw new Error(`invalid redirectUri: ${u}`);
    }
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1' && parsed.protocol !== 'http:') {
      // permit non-http(s) custom schemes (e.g. vscode://) — but no javascript:
      if (parsed.protocol === 'javascript:' || parsed.protocol === 'data:') {
        throw new Error(`unsafe redirectUri scheme: ${parsed.protocol}`);
      }
    }
    if (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new Error(`http:// redirectUri only allowed for loopback: ${u}`);
    }
    if (parsed.hash) throw new Error('redirectUri cannot include a fragment');
  }
}
