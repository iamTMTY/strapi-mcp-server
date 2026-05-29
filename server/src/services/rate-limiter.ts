'use strict';

import type { Core } from '@strapi/strapi';
import { getConfig, type RateBucketConfig } from '../config';
import type { RedisLike } from './redis';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const principalBuckets = new Map<string, Bucket>();
const ipBuckets = new Map<string, Bucket>();
const dcrBuckets = new Map<string, Bucket>();
let lastReap = Date.now();

// Token-bucket take, in Lua so refill + decrement are atomic. Returns 0 when
// the request is allowed, otherwise the integer seconds the caller should
// wait before retrying (ceil((1 - tokens) / refill)). Bucket state lives in
// a small hash and is allowed to expire when idle.
const TAKE_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local idle_ttl = tonumber(ARGV[4])

local b = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens = tonumber(b[1])
local last = tonumber(b[2])
if tokens == nil then
  tokens = capacity
  last = now
end

local elapsed = (now - last) / 1000.0
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * refill)

local wait = 0
if tokens < 1 then
  wait = math.ceil((1 - tokens) / refill)
  if wait < 1 then wait = 1 end
else
  tokens = tokens - 1
end

redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', now)
redis.call('PEXPIRE', key, idle_ttl)
return wait
`;

function takeLocal(map: Map<string, Bucket>, key: string, cfg: RateBucketConfig): number {
  const now = Date.now();
  let b = map.get(key);
  if (!b) {
    b = { tokens: cfg.capacity, lastRefill: now };
    map.set(key, b);
  }
  const elapsed = (now - b.lastRefill) / 1000;
  b.tokens = Math.min(cfg.capacity, b.tokens + elapsed * cfg.refillPerSec);
  b.lastRefill = now;
  if (b.tokens < 1) {
    const wait = (1 - b.tokens) / cfg.refillPerSec;
    return Math.max(1, Math.ceil(wait));
  }
  b.tokens -= 1;
  return 0;
}

async function takeRedis(
  redis: RedisLike,
  key: string,
  cfg: RateBucketConfig
): Promise<number> {
  // Idle TTL = 10 minutes — same as the in-memory reaper. Lets idle keys
  // expire on their own rather than holding state forever.
  const idleTtlMs = 10 * 60 * 1000;
  try {
    const result = await redis.eval(
      TAKE_LUA,
      1,
      key,
      cfg.capacity,
      cfg.refillPerSec,
      Date.now(),
      idleTtlMs
    );
    return typeof result === 'number' ? result : Number(result) || 0;
  } catch {
    // Redis hiccup: fail-open for rate limiting (a brief gap is better than
    // a hard outage). The next request will re-try the script.
    return 0;
  }
}

function reapLocal(): void {
  const now = Date.now();
  if (now - lastReap < 5 * 60 * 1000) return;
  lastReap = now;
  for (const map of [principalBuckets, ipBuckets, dcrBuckets]) {
    for (const [k, b] of map.entries()) {
      if (now - b.lastRefill > 10 * 60 * 1000) map.delete(k);
    }
  }
}

export default ({ strapi }: { strapi: Core.Strapi }) => {
  async function redisClient(): Promise<RedisLike | null> {
    const cfg = getConfig(strapi);
    if (!cfg.redis?.enabled) return null;
    return strapi.plugin('mcp-server').service('redis').get();
  }

  function redisKey(...parts: string[]): string {
    return strapi.plugin('mcp-server').service('redis').key('rl', ...parts);
  }

  return {
    /**
     * Check both buckets (principal and IP). Returns 0 when allowed; otherwise
     * the number of seconds the client should wait before retrying (`Retry-After`).
     *
     * When `redis.enabled === true` the buckets are cluster-wide; otherwise
     * each Node process has its own.
     */
    async check(principalId: string | undefined, ip: string | undefined): Promise<number> {
      const cfg = getConfig(strapi);
      const redis = await redisClient();
      if (!redis) {
        reapLocal();
        if (principalId) {
          const wait = takeLocal(principalBuckets, principalId, cfg.rateLimit.perPrincipal);
          if (wait > 0) return wait;
        }
        if (ip) {
          const wait = takeLocal(ipBuckets, ip, cfg.rateLimit.perIp);
          if (wait > 0) return wait;
        }
        return 0;
      }

      if (principalId) {
        const wait = await takeRedis(redis, redisKey('p', principalId), cfg.rateLimit.perPrincipal);
        if (wait > 0) return wait;
      }
      if (ip) {
        const wait = await takeRedis(redis, redisKey('ip', ip), cfg.rateLimit.perIp);
        if (wait > 0) return wait;
      }
      return 0;
    },

    /**
     * Per-IP rate limit for `POST /oauth/register`. Separate bucket from the
     * normal per-IP limit because DCR has no principal at request time and
     * we want a different (typically tighter) ceiling on registrations than
     * on tool calls. Driven by `oauth.dcr.ratelimitPerHour`.
     */
    async checkDcr(ip: string | undefined): Promise<number> {
      if (!ip) return 0;
      const cfg = getConfig(strapi);
      const capacity = Math.max(1, cfg.oauth.dcr.ratelimitPerHour);
      const refillPerSec = capacity / 3600;
      const bucketCfg: RateBucketConfig = { capacity, refillPerSec };
      const redis = await redisClient();
      if (!redis) {
        reapLocal();
        return takeLocal(dcrBuckets, ip, bucketCfg);
      }
      return takeRedis(redis, redisKey('dcr', ip), bucketCfg);
    },

    reset(): void {
      principalBuckets.clear();
      ipBuckets.clear();
      dcrBuckets.clear();
    },
  };
};
