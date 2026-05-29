'use strict';

import type { Core } from '@strapi/strapi';
import type { McpConfig } from '../../server/src/config';

export interface MockOptions {
  config?: Partial<McpConfig>;
  services?: Record<string, unknown>;
  query?: Record<string, MockQuery>;
  contentTypes?: Record<string, { kind?: string }>;
}

export interface MockQuery {
  findOne?: jest.Mock;
  findMany?: jest.Mock;
  findPage?: jest.Mock;
  create?: jest.Mock;
  createMany?: jest.Mock;
  update?: jest.Mock;
  updateMany?: jest.Mock;
  delete?: jest.Mock;
  deleteMany?: jest.Mock;
  count?: jest.Mock;
}

export const DEFAULT_MCP_CONFIG: McpConfig = {
  enabled: true,
  resourceUrl: 'http://localhost:1337/mcp',
  allowedOrigins: ['http://localhost:1337'],
  oauth: {
    mode: 'embedded',
    accessTokenTtlSec: 600,
    refreshTokenTtlSec: 86400,
    authCodeTtlSec: 60,
    ssoCookieTtlSec: 900,
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

export function makeStrapi(opts: MockOptions = {}): Core.Strapi {
  const services = opts.services ?? {};
  const queries = opts.query ?? {};
  const config: McpConfig = mergeConfig(DEFAULT_MCP_CONFIG, opts.config ?? {});

  const query = jest.fn((uid: string) => {
    if (!queries[uid]) queries[uid] = {};
    return queries[uid];
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const strapi: any = {
    log: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      fatal: jest.fn(),
    },
    db: { query },
    config: {
      get: jest.fn((key: string) =>
        key === 'plugin::mcp-server' ? config : undefined
      ),
    },
    plugin: jest.fn((name: string) => ({
      service: (svc: string) => {
        if (name !== 'mcp-server') return undefined;
        if (!(svc in services)) {
          throw new Error(`mock strapi: service '${svc}' was requested but not provided`);
        }
        return services[svc];
      },
    })),
    service: jest.fn(),
    contentTypes: opts.contentTypes ?? {},
    cron: { add: jest.fn() },
  };
  return strapi as Core.Strapi;
}

function mergeConfig(base: McpConfig, override: Partial<McpConfig>): McpConfig {
  return {
    ...base,
    ...override,
    oauth: { ...base.oauth, ...(override.oauth ?? {}) },
    session: { ...base.session, ...(override.session ?? {}) },
    rateLimit: { ...base.rateLimit, ...(override.rateLimit ?? {}) },
    upload: { ...base.upload, ...(override.upload ?? {}) },
    audit: { ...base.audit, ...(override.audit ?? {}) },
    tools: { ...base.tools, ...(override.tools ?? {}) },
    redis: override.redis ?? base.redis,
  } as McpConfig;
}

/**
 * Build a chainable Jest mock for `strapi.db.query(uid)` operations.
 * Pass implementations per-method; missing ones return reasonable defaults.
 */
export function mockQuery(overrides: Partial<MockQuery> = {}): MockQuery {
  return {
    findOne: overrides.findOne ?? jest.fn(async () => null),
    findMany: overrides.findMany ?? jest.fn(async () => []),
    findPage: overrides.findPage ?? jest.fn(async () => ({ results: [], pagination: {} })),
    create: overrides.create ?? jest.fn(async ({ data }) => ({ id: 1, ...data })),
    createMany: overrides.createMany ?? jest.fn(async () => ({ count: 0 })),
    update: overrides.update ?? jest.fn(async ({ data }) => ({ id: 1, ...data })),
    updateMany: overrides.updateMany ?? jest.fn(async () => ({ count: 0 })),
    delete: overrides.delete ?? jest.fn(async () => ({ id: 1 })),
    deleteMany: overrides.deleteMany ?? jest.fn(async () => ({ count: 0 })),
    count: overrides.count ?? jest.fn(async () => 0),
  };
}

/** Stable timestamp for deterministic tests. */
export const FIXED_NOW = new Date('2026-05-24T12:00:00.000Z').getTime();
