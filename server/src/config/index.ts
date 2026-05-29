'use strict';

import type { Core } from '@strapi/strapi';

export interface RateBucketConfig {
  capacity: number;
  refillPerSec: number;
}

export interface McpConfig {
  enabled: boolean;
  resourceUrl: string;
  allowedOrigins: string[];
  oauth: {
    mode: 'embedded' | 'external';
    accessTokenTtlSec: number;
    refreshTokenTtlSec: number;
    authCodeTtlSec: number;
    ssoCookieTtlSec: number;
    dcr: {
      enabled: boolean;
      ratelimitPerHour: number;
    };
    consent: { rememberDays: number };
    introspection: { allowedIps: string[] };
    external?: {
      issuer: string;
      jwksUri: string;
      /** JWT claim used to look up the matching Strapi admin user. Default: 'email'. */
      adminLookupClaim?: string;
      /**
       * When `false` (default), external mode treats a verified JWT as fully
       * authorized — the IdP gates auth, and granular permissions come from
       * Strapi RBAC + per-tool toggles. `strapi:*` scopes are NOT advertised
       * to clients and NOT required on the JWT.
       *
       * Set `true` to require the JWT's `scope` claim to contain `strapi:*`
       * scopes (you must define them as Client Scopes in your IdP).
       */
      enforceScopes?: boolean;
    };
  };
  session: {
    idleTtlMs: number;
    hardTtlMs: number;
    maxPerPrincipal: number;
    maxTotal: number;
    sweepIntervalMs: number;
  };
  rateLimit: {
    perPrincipal: RateBucketConfig;
    perIp: RateBucketConfig;
  };
  upload: {
    maxBytes: number;
    mimeAllowlist: string[];
    allowSvg: boolean;
  };
  audit: {
    retentionDays: number;
    redactKeyPatterns: string[];
    drainIntervalMs: number;
    drainBatchSize: number;
  };
  tools: { enabled: Record<string, boolean> };
  /**
   * Optional Redis backend for horizontal scale. When `enabled: false`
   * (default), the plugin uses process-local state and is single-instance.
   *
   * Two opt-in tiers:
   *  - `enabled: true` alone shares only the rate limiter buckets across
   *    instances. Sessions stay process-local — sticky LB is still required.
   *  - `enabled: true` + `internalAddress` + `internalSecret` adds session
   *    routing: any instance can serve any session by proxying to the owner.
   */
  redis?: {
    enabled: boolean;
    url: string;
    keyPrefix?: string;
    /** Override the auto-generated instance id (default: `${host}-${pid}-${rand}`). */
    instanceId?: string;
    /**
     * Internal-facing URL of this instance (e.g. `http://10.0.0.5:1337`).
     * Peers use this address to proxy requests for sessions this instance owns.
     * When unset, session routing is disabled and Redis is only used for rate
     * limiting.
     */
    internalAddress?: string;
    /**
     * Shared secret used to sign cross-instance proxy requests. Required when
     * `internalAddress` is set. Must be at least 32 characters of high-entropy
     * randomness — peers that don't share this secret cannot reach any
     * session on this instance.
     */
    internalSecret?: string;
    /** How often each instance refreshes its heartbeat key. Default 10s. */
    heartbeatIntervalMs?: number;
    /** TTL of the heartbeat key. Must be > intervalMs. Default 30s. */
    heartbeatTtlMs?: number;
  };
}

const defaultConfig: McpConfig = {
  enabled: false,
  resourceUrl: '',
  allowedOrigins: [],
  oauth: {
    mode: 'embedded',
    accessTokenTtlSec: 600,
    refreshTokenTtlSec: 86400,
    authCodeTtlSec: 60,
    ssoCookieTtlSec: 900,
    // DCR off by default — admins create clients via the Clients page in the
    // admin UI and inject `client_id` + `client_secret` into the AI client's
    // config. All major MCP clients (Claude Code, Claude web, Codex via
    // mcp-remote, opencode, Cursor) support pre-registered credentials, so DCR
    // is an opt-in convenience for self-registration rather than the default.
    // Set `enabled: true` to allow self-registration via `/oauth/register`
    // (still rate-limited per IP and audited; the admin consent screen is the
    // real security gate either way).
    dcr: { enabled: false, ratelimitPerHour: 60 },
    consent: { rememberDays: 0 },
    introspection: { allowedIps: ['127.0.0.1', '::1'] },
  },
  session: {
    idleTtlMs: 30 * 60 * 1000,
    hardTtlMs: 24 * 60 * 60 * 1000,
    maxPerPrincipal: 10,
    maxTotal: 1000,
    sweepIntervalMs: 60 * 1000,
  },
  rateLimit: {
    perPrincipal: { capacity: 60, refillPerSec: 1 },
    perIp: { capacity: 120, refillPerSec: 2 },
  },
  upload: {
    maxBytes: 10 * 1024 * 1024,
    mimeAllowlist: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'],
    allowSvg: false,
  },
  audit: {
    retentionDays: 90,
    redactKeyPatterns: ['password', 'token', 'secret', 'authorization', 'cookie', 'apikey'],
    drainIntervalMs: 2000,
    drainBatchSize: 50,
  },
  tools: { enabled: {} },
};

/**
 * Validate the merged plugin configuration. Throws on hard misconfiguration —
 * Strapi will refuse to boot the plugin.
 *
 * Why: every check here is load-bearing for security. Don't soften without
 * thinking through the threat model.
 */
function validator(config: McpConfig): void {
  if (!config) throw new Error('[mcp-server] config is missing');
  if (typeof config.enabled !== 'boolean') {
    throw new Error('[mcp-server] config.enabled must be a boolean');
  }
  if (!config.enabled) return;

  if (!config.resourceUrl || typeof config.resourceUrl !== 'string') {
    throw new Error('[mcp-server] config.resourceUrl is required when enabled');
  }
  try {
    // throws on invalid URL
    // eslint-disable-next-line no-new
    new URL(config.resourceUrl);
  } catch {
    throw new Error('[mcp-server] config.resourceUrl is not a valid URL');
  }

  if (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.length === 0) {
    throw new Error('[mcp-server] config.allowedOrigins must be a non-empty array');
  }
  const env = process.env.NODE_ENV;
  const hasWildcard = config.allowedOrigins.includes('*');
  if (env === 'production' && hasWildcard) {
    throw new Error('[mcp-server] allowedOrigins cannot include "*" in production');
  }

  const resourceIsHttp = config.resourceUrl.startsWith('http://');
  if (resourceIsHttp) {
    const nonLoopback = config.allowedOrigins.some((o) => {
      if (o === '*') return true;
      try {
        const u = new URL(o);
        const h = u.hostname.toLowerCase();
        return h !== 'localhost' && h !== '127.0.0.1' && h !== '::1';
      } catch {
        return false;
      }
    });
    if (nonLoopback) {
      throw new Error(
        '[mcp-server] resourceUrl uses http:// but allowedOrigins contains non-loopback hosts — refuse to start'
      );
    }
  }

  if (config.oauth.accessTokenTtlSec < 60 || config.oauth.accessTokenTtlSec > 3600) {
    throw new Error('[mcp-server] oauth.accessTokenTtlSec must be between 60 and 3600');
  }
  if (config.oauth.refreshTokenTtlSec < 300) {
    throw new Error('[mcp-server] oauth.refreshTokenTtlSec must be >= 300');
  }
  if (config.oauth.authCodeTtlSec < 10 || config.oauth.authCodeTtlSec > 600) {
    throw new Error('[mcp-server] oauth.authCodeTtlSec must be between 10 and 600');
  }

  if (config.redis?.enabled) {
    if (!config.redis.url || typeof config.redis.url !== 'string') {
      throw new Error('[mcp-server] redis.url is required when redis.enabled is true');
    }
    try {
      // eslint-disable-next-line no-new
      new URL(config.redis.url);
    } catch {
      throw new Error('[mcp-server] redis.url is not a valid URL (expected redis:// or rediss://)');
    }
    if (
      !config.redis.url.startsWith('redis://') &&
      !config.redis.url.startsWith('rediss://')
    ) {
      throw new Error('[mcp-server] redis.url must start with redis:// or rediss://');
    }

    if (config.redis.internalAddress || config.redis.internalSecret) {
      if (!config.redis.internalAddress) {
        throw new Error(
          '[mcp-server] redis.internalAddress is required when redis.internalSecret is set'
        );
      }
      if (!config.redis.internalSecret) {
        throw new Error(
          '[mcp-server] redis.internalSecret is required when redis.internalAddress is set'
        );
      }
      try {
        const u = new URL(config.redis.internalAddress);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          throw new Error('protocol');
        }
      } catch {
        throw new Error('[mcp-server] redis.internalAddress must be a valid http(s) URL');
      }
      if (config.redis.internalSecret.length < 32) {
        throw new Error(
          '[mcp-server] redis.internalSecret must be at least 32 characters of random data'
        );
      }
    }
  }

  if (config.oauth.mode === 'external') {
    if (!config.oauth.external) {
      throw new Error('[mcp-server] oauth.mode is "external" but oauth.external is missing');
    }
    if (!config.oauth.external.issuer || !config.oauth.external.jwksUri) {
      throw new Error(
        '[mcp-server] oauth.external.issuer and oauth.external.jwksUri are required when oauth.mode is "external"'
      );
    }
    try {
      // eslint-disable-next-line no-new
      new URL(config.oauth.external.issuer);
      // eslint-disable-next-line no-new
      new URL(config.oauth.external.jwksUri);
    } catch {
      throw new Error('[mcp-server] oauth.external.issuer / jwksUri must be valid URLs');
    }
  }
}

/**
 * Strapi reads `default` and `validator` from this module. The merged
 * runtime config is then accessible via `strapi.config.get('plugin::mcp-server')`.
 */
export default {
  default: defaultConfig,
  validator(config: McpConfig) {
    validator(config);
  },
};

export function getConfig(strapi: Core.Strapi): McpConfig {
  return strapi.config.get('plugin::mcp-server') as McpConfig;
}
