'use strict';

import type { Core } from '@strapi/strapi';

export interface RateBucketConfig {
  capacity: number;
  refillPerSec: number;
}

export interface McpConfig {
  resourceUrl: string;
  allowedOrigins: string[];
  oauth: {
    mode: 'embedded' | 'external';
    accessTokenTtlSec: number;
    refreshTokenTtlSec: number;
    /** Absolute lifetime of a refresh-token family; rotation can't extend past it. */
    refreshFamilyMaxAgeSec: number;
    authCodeTtlSec: number;
    ssoCookieTtlSec: number;
    dcr: {
      enabled: boolean;
      ratelimitPerHour: number;
      /**
       * Optional allowlist of hosts DCR clients may redirect to (loopback is
       * always allowed). E.g. `['claude.ai', 'chatgpt.com']`. Unset = any
       * https host, with the consent screen as the only gate.
       */
      allowedRedirectHosts?: string[];
    };
    consent: { rememberDays: number };
    introspection: { allowedIps: string[] };
    external?: {
      issuer: string;
      jwksUri: string;
      /**
       * Required `aud` value (or values). Without it, any token the IdP minted
       * for any other application would be accepted here.
       */
      audience: string | string[];
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
  rateLimit: {
    perPrincipal: RateBucketConfig;
    perIp: RateBucketConfig;
  };
  upload: {
    maxBytes: number;
    mimeAllowlist: string[];
    allowSvg: boolean;
    /** Lifetime of a one-time upload URL from strapi_media_request_upload. */
    ticketTtlSec: number;
  };
  audit: {
    retentionDays: number;
    redactKeyPatterns: string[];
    drainIntervalMs: number;
    drainBatchSize: number;
    /** Record successful read-only tool calls too. Errors and writes are always recorded. */
    recordReads: boolean;
  };
  tools: { enabled: Record<string, boolean> };
  /** Upper bound for a single tool call; the model gets a `timeout` error past it. */
  requestTimeoutMs: number;
  /**
   * Optional Redis, used only to share rate-limit buckets across instances.
   * The MCP transport is stateless, so any instance can serve any request —
   * no sticky sessions or session routing needed.
   */
  redis?: {
    enabled: boolean;
    url: string;
    keyPrefix?: string;
  };
}

const defaultConfig: McpConfig = {
  resourceUrl: '',
  allowedOrigins: [],
  oauth: {
    mode: 'embedded',
    accessTokenTtlSec: 600,
    refreshTokenTtlSec: 86400,
    refreshFamilyMaxAgeSec: 30 * 86400,
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
  rateLimit: {
    perPrincipal: { capacity: 60, refillPerSec: 1 },
    perIp: { capacity: 120, refillPerSec: 2 },
  },
  upload: {
    maxBytes: 10 * 1024 * 1024,
    mimeAllowlist: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'],
    allowSvg: false,
    ticketTtlSec: 600,
  },
  audit: {
    retentionDays: 90,
    redactKeyPatterns: ['password', 'token', 'secret', 'authorization', 'cookie', 'apikey'],
    drainIntervalMs: 2000,
    drainBatchSize: 50,
    recordReads: true,
  },
  tools: { enabled: {} },
  requestTimeoutMs: 60_000,
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
  // Unconfigured = installed but inactive (see isConfigured). Everything
  // below applies once the operator opts in by setting resourceUrl.
  if (!isConfigured(config)) return;

  if (typeof config.resourceUrl !== 'string') {
    throw new Error('[mcp-server] config.resourceUrl must be a string');
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
  if (!(config.requestTimeoutMs >= 1000 && config.requestTimeoutMs <= 600_000)) {
    throw new Error('[mcp-server] requestTimeoutMs must be between 1000 and 600000');
  }
  if (config.upload.ticketTtlSec < 60 || config.upload.ticketTtlSec > 3600) {
    throw new Error('[mcp-server] upload.ticketTtlSec must be between 60 and 3600');
  }
  if (config.oauth.refreshFamilyMaxAgeSec < config.oauth.refreshTokenTtlSec) {
    throw new Error('[mcp-server] oauth.refreshFamilyMaxAgeSec must be >= refreshTokenTtlSec');
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
    if (!config.redis.url.startsWith('redis://') && !config.redis.url.startsWith('rediss://')) {
      throw new Error('[mcp-server] redis.url must start with redis:// or rediss://');
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
    const aud = config.oauth.external.audience;
    if (!aud || (Array.isArray(aud) && aud.length === 0)) {
      throw new Error(
        '[mcp-server] oauth.external.audience is required when oauth.mode is "external" — set it to the audience your IdP puts in tokens issued for this MCP server'
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

/**
 * The plugin serves nothing until `resourceUrl` is set: installing it from npm
 * (which Strapi auto-enables) must not expose OAuth or MCP endpoints. To turn
 * a configured plugin off, use Strapi's own `'mcp-server': { enabled: false }`.
 */
export function isConfigured(config: Pick<McpConfig, 'resourceUrl'> | undefined): boolean {
  return !!config?.resourceUrl;
}

export function getConfig(strapi: Core.Strapi): McpConfig {
  return strapi.config.get('plugin::mcp-server') as McpConfig;
}
