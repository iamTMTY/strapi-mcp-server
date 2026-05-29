'use strict';

import type { Core } from '@strapi/strapi';
import { getConfig } from '../config';

// Loose Redis interface — narrow surface we actually use. Avoids forcing a
// hard typed dep on ioredis when Redis is disabled.
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  scard(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  hset(key: string, field: string, value: string): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  quit(): Promise<unknown>;
  status?: string;
}

let client: RedisLike | null = null;
let initializing: Promise<RedisLike | null> | null = null;
let subscriber: RedisLike | null = null;
let initializingSub: Promise<RedisLike | null> | null = null;

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Return the shared Redis client. Returns null when Redis is disabled in
   * config — callers must handle that case and fall back to local state.
   * Multiple concurrent callers during boot share the same connect promise.
   */
  async get(): Promise<RedisLike | null> {
    const cfg = getConfig(strapi);
    if (!cfg.redis?.enabled) return null;
    if (client) return client;
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        // Dynamic require so single-instance deployments don't need ioredis
        // installed at all. If they enable Redis but skipped install, fail
        // loudly with a useful message.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const IORedis = require('ioredis');
        const Ctor = IORedis.default ?? IORedis;
        const instance: RedisLike = new Ctor(cfg.redis!.url, {
          lazyConnect: false,
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
        });
        instance.on('error', (err: unknown) => {
          strapi.log.warn(`[mcp-server] redis error: ${(err as Error).message}`);
        });
        instance.on('connect', () => {
          strapi.log.info('[mcp-server] redis connected');
        });
        client = instance;
        return instance;
      } catch (err) {
        const msg = (err as Error).message;
        strapi.log.error(
          `[mcp-server] redis init failed (${msg}). Install ioredis or set redis.enabled=false.`
        );
        client = null;
        return null;
      } finally {
        initializing = null;
      }
    })();
    return initializing;
  },

  /**
   * Build a namespaced key. All Redis keys flow through here so that
   * deployments with shared Redis can prefix per-tenant.
   */
  key(...parts: string[]): string {
    const cfg = getConfig(strapi);
    const prefix = cfg.redis?.keyPrefix ?? 'mcp:';
    return prefix + parts.join(':');
  },

  /**
   * Return a dedicated subscriber connection. ioredis (and any RESP client)
   * cannot issue normal commands once a connection has called SUBSCRIBE — so
   * pub/sub work uses a second client. Lazy-instantiated like the main one.
   */
  async getSubscriber(): Promise<RedisLike | null> {
    const cfg = getConfig(strapi);
    if (!cfg.redis?.enabled) return null;
    if (subscriber) return subscriber;
    if (initializingSub) return initializingSub;
    initializingSub = (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const IORedis = require('ioredis');
        const Ctor = IORedis.default ?? IORedis;
        const instance: RedisLike = new Ctor(cfg.redis!.url, {
          lazyConnect: false,
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
        });
        instance.on('error', (err: unknown) => {
          strapi.log.warn(`[mcp-server] redis subscriber error: ${(err as Error).message}`);
        });
        subscriber = instance;
        return instance;
      } catch (err) {
        strapi.log.error(
          `[mcp-server] redis subscriber init failed: ${(err as Error).message}`
        );
        subscriber = null;
        return null;
      } finally {
        initializingSub = null;
      }
    })();
    return initializingSub;
  },

  /** Close the shared client + subscriber. Called from destroy(). */
  async disconnect(): Promise<void> {
    for (const c of [client, subscriber]) {
      if (!c) continue;
      try {
        await c.quit();
      } catch {
        // best-effort
      }
    }
    client = null;
    subscriber = null;
  },
});
