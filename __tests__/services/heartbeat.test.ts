'use strict';

import heartbeatFactory from '../../server/src/services/heartbeat';
import { makeStrapi } from '../helpers/strapi-mock';

function makeRedisStub() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    set: jest.fn(async (key: string, value: string, _ex: string, ttlSec: number) => {
      store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
      return 'OK';
    }),
    get: jest.fn(async (key: string) => {
      const v = store.get(key);
      if (!v) return null;
      if (v.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return v.value;
    }),
    store,
  };
}

function makeHeartbeat(opts?: {
  internalAddress?: string;
  heartbeatTtlMs?: number;
  heartbeatIntervalMs?: number;
  redisEnabled?: boolean;
}) {
  const redis = makeRedisStub();
  const strapi = makeStrapi({
    config: {
      redis: {
        enabled: opts?.redisEnabled ?? true,
        url: 'redis://localhost:6379',
        internalAddress: opts?.internalAddress ?? 'http://localhost:1337',
        heartbeatTtlMs: opts?.heartbeatTtlMs ?? 30_000,
        heartbeatIntervalMs: opts?.heartbeatIntervalMs ?? 10_000,
      },
    },
    services: {
      redis: {
        get: async () => redis,
        key: (...parts: string[]) => 'mcp:' + parts.join(':'),
      },
      'instance-id': { get: () => 'inst-test' },
    },
  });
  return { hb: heartbeatFactory({ strapi }), redis };
}

afterEach(() => {
  // ensure no leaked interval timers from start() runs
  jest.useRealTimers();
});

describe('heartbeat.start', () => {
  it('writes the key immediately on start', async () => {
    const { hb, redis } = makeHeartbeat();
    await hb.start();
    expect(redis.set).toHaveBeenCalledWith(
      'mcp:inst:inst-test',
      expect.any(String),
      'EX',
      30
    );
    hb.stop();
  });

  it('does nothing when redis is disabled', async () => {
    const { hb, redis } = makeHeartbeat({ redisEnabled: false });
    await hb.start();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('does nothing when internalAddress is unset (rate-limit-only mode)', async () => {
    const strapi = makeStrapi({
      config: { redis: { enabled: true, url: 'redis://x' } },
      services: {
        redis: { get: async () => ({}), key: () => '' },
        'instance-id': { get: () => 'inst' },
      },
    });
    const hb = heartbeatFactory({ strapi });
    await hb.start();
    // No way to inspect direct — just confirm no throw and stop() is a no-op
    hb.stop();
  });
});

describe('heartbeat.isAlive', () => {
  it('returns true when the key exists', async () => {
    const { hb, redis } = makeHeartbeat();
    redis.store.set('mcp:inst:other', { value: '123', expiresAt: Date.now() + 60_000 });
    expect(await hb.isAlive('other')).toBe(true);
  });

  it('returns false when the key is missing', async () => {
    const { hb } = makeHeartbeat();
    expect(await hb.isAlive('does-not-exist')).toBe(false);
  });

  it('returns true (fail-open) when redis is disabled in config', async () => {
    const { hb } = makeHeartbeat({ redisEnabled: false });
    expect(await hb.isAlive('anything')).toBe(true);
  });

  it('returns true (fail-open) when GET throws', async () => {
    const redis = {
      set: jest.fn(),
      get: jest.fn(async () => {
        throw new Error('redis down');
      }),
    };
    const strapi = makeStrapi({
      config: {
        redis: {
          enabled: true,
          url: 'redis://x',
          internalAddress: 'http://localhost:1337',
        },
      },
      services: {
        redis: { get: async () => redis, key: (...p: string[]) => 'mcp:' + p.join(':') },
        'instance-id': { get: () => 'inst' },
      },
    });
    expect(await heartbeatFactory({ strapi }).isAlive('any')).toBe(true);
  });
});
