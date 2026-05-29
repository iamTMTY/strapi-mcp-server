'use strict';

import rateLimiterFactory from '../../server/src/services/rate-limiter';
import { makeStrapi } from '../helpers/strapi-mock';

function makeLimiter(opts?: {
  perPrincipal?: { capacity: number; refillPerSec: number };
  perIp?: { capacity: number; refillPerSec: number };
  ratelimitPerHour?: number;
  redis?: ReturnType<typeof makeRedisStub> | null;
}) {
  const services: Record<string, unknown> = {};
  if (opts?.redis) {
    services.redis = {
      get: async () => opts.redis,
      key: (...parts: string[]) => 'mcp:' + parts.join(':'),
    };
  } else {
    services.redis = { get: async () => null, key: (...parts: string[]) => 'mcp:' + parts.join(':') };
  }
  const strapi = makeStrapi({
    config: {
      rateLimit: {
        perPrincipal: opts?.perPrincipal ?? { capacity: 3, refillPerSec: 1 },
        perIp: opts?.perIp ?? { capacity: 5, refillPerSec: 1 },
      },
      oauth: {
        mode: 'embedded',
        accessTokenTtlSec: 600,
        refreshTokenTtlSec: 86400,
        authCodeTtlSec: 60,
        ssoCookieTtlSec: 900,
        dcr: { enabled: false, ratelimitPerHour: opts?.ratelimitPerHour ?? 5 },
        consent: { rememberDays: 0 },
        introspection: { allowedIps: ['127.0.0.1'] },
      },
      // Enable the Redis path only when caller passes a redis stub.
      ...(opts?.redis ? { redis: { enabled: true, url: 'redis://localhost:6379' } } : {}),
    },
    services,
  });
  return rateLimiterFactory({ strapi });
}

// Minimal in-process Redis-shape stub that satisfies the eval()-based Lua bucket
// path. Implements the token-bucket math in JS so we test the integration shape
// even without a real Redis.
function makeRedisStub() {
  const state = new Map<string, { tokens: number; lastRefill: number }>();
  return {
    eval: jest.fn(
      async (
        _script: string,
        _numKeys: number,
        key: string,
        capacityStr: string,
        refillStr: string,
        nowStr: string,
        _idleTtlMsStr: string
      ): Promise<number> => {
        const capacity = Number(capacityStr);
        const refill = Number(refillStr);
        const now = Number(nowStr);
        const cur = state.get(key) ?? { tokens: capacity, lastRefill: now };
        const elapsed = Math.max(0, (now - cur.lastRefill) / 1000);
        let tokens = Math.min(capacity, cur.tokens + elapsed * refill);
        let wait = 0;
        if (tokens < 1) {
          wait = Math.max(1, Math.ceil((1 - tokens) / refill));
        } else {
          tokens -= 1;
        }
        state.set(key, { tokens, lastRefill: now });
        return wait;
      }
    ),
    state,
  };
}

describe('rate-limiter (in-memory) — per-principal', () => {
  it('allows up to capacity, then 429s', async () => {
    const rl = makeLimiter({ perPrincipal: { capacity: 3, refillPerSec: 1 }, perIp: { capacity: 100, refillPerSec: 1 } });
    rl.reset();
    expect(await rl.check('user-1', '1.1.1.1')).toBe(0);
    expect(await rl.check('user-1', '1.1.1.1')).toBe(0);
    expect(await rl.check('user-1', '1.1.1.1')).toBe(0);
    const wait = await rl.check('user-1', '1.1.1.1');
    expect(wait).toBeGreaterThan(0);
  });

  it('tracks principals independently', async () => {
    const rl = makeLimiter({ perPrincipal: { capacity: 1, refillPerSec: 0.001 }, perIp: { capacity: 100, refillPerSec: 1 } });
    rl.reset();
    expect(await rl.check('user-1', '1.1.1.1')).toBe(0);
    expect(await rl.check('user-1', '1.1.1.1')).toBeGreaterThan(0);
    // user-2 still has its own bucket
    expect(await rl.check('user-2', '1.1.1.1')).toBe(0);
  });
});

describe('rate-limiter (in-memory) — per-IP', () => {
  it('limits IP independently of principal', async () => {
    const rl = makeLimiter({ perPrincipal: { capacity: 100, refillPerSec: 100 }, perIp: { capacity: 2, refillPerSec: 0.001 } });
    rl.reset();
    expect(await rl.check('user-1', '1.2.3.4')).toBe(0);
    expect(await rl.check('user-2', '1.2.3.4')).toBe(0);
    expect(await rl.check('user-3', '1.2.3.4')).toBeGreaterThan(0);
  });
});

describe('rate-limiter (in-memory) — checkDcr', () => {
  it('uses ratelimitPerHour as capacity', async () => {
    const rl = makeLimiter({ ratelimitPerHour: 3 });
    rl.reset();
    expect(await rl.checkDcr('5.5.5.5')).toBe(0);
    expect(await rl.checkDcr('5.5.5.5')).toBe(0);
    expect(await rl.checkDcr('5.5.5.5')).toBe(0);
    expect(await rl.checkDcr('5.5.5.5')).toBeGreaterThan(0);
  });

  it('returns 0 when ip is undefined', async () => {
    const rl = makeLimiter({ ratelimitPerHour: 1 });
    expect(await rl.checkDcr(undefined)).toBe(0);
  });
});

describe('rate-limiter (Redis) — happy path via Lua stub', () => {
  it('runs Lua script with correct arguments', async () => {
    const redis = makeRedisStub();
    const rl = makeLimiter({
      perPrincipal: { capacity: 2, refillPerSec: 1 },
      perIp: { capacity: 100, refillPerSec: 1 },
      redis,
    });
    rl.reset();
    expect(await rl.check('user-1', '9.9.9.9')).toBe(0);
    expect(await rl.check('user-1', '9.9.9.9')).toBe(0);
    expect(await rl.check('user-1', '9.9.9.9')).toBeGreaterThan(0);
    expect(redis.eval).toHaveBeenCalled();
  });

  it('falls open when Redis throws (degraded mode, never 429s on transient error)', async () => {
    const redis = {
      eval: jest.fn(async () => {
        throw new Error('redis down');
      }),
    };
    const rl = makeLimiter({ perPrincipal: { capacity: 1, refillPerSec: 1 }, redis });
    rl.reset();
    // even after capacity is exceeded, Redis errors are treated as "0 wait"
    expect(await rl.check('user-1', '9.9.9.9')).toBe(0);
    expect(await rl.check('user-1', '9.9.9.9')).toBe(0);
  });

  it('checkDcr uses Redis too when enabled', async () => {
    const redis = makeRedisStub();
    const rl = makeLimiter({ ratelimitPerHour: 2, redis });
    rl.reset();
    await rl.checkDcr('7.7.7.7');
    await rl.checkDcr('7.7.7.7');
    const wait = await rl.checkDcr('7.7.7.7');
    expect(wait).toBeGreaterThan(0);
    expect(redis.eval).toHaveBeenCalled();
  });
});
