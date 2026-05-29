'use strict';

import directoryFactory from '../../server/src/services/session-directory';
import { makeStrapi } from '../helpers/strapi-mock';

/**
 * Minimal in-process Redis stub implementing the surface session-directory uses:
 * HSET, HGETALL, DEL, EXPIRE, SADD, SREM, SCARD, SMEMBERS.
 */
function makeRedisStub() {
  const hashes = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();
  return {
    hset: jest.fn(async (key: string, field: string, value: string) => {
      const h = hashes.get(key) ?? {};
      h[field] = value;
      hashes.set(key, h);
      return 1;
    }),
    hgetall: jest.fn(async (key: string) => hashes.get(key) ?? {}),
    del: jest.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) {
        if (hashes.delete(k)) n++;
      }
      return n;
    }),
    expire: jest.fn(async () => 1),
    sadd: jest.fn(async (key: string, ...members: string[]) => {
      const s = sets.get(key) ?? new Set<string>();
      members.forEach((m) => s.add(m));
      sets.set(key, s);
      return members.length;
    }),
    srem: jest.fn(async (key: string, ...members: string[]) => {
      const s = sets.get(key);
      if (!s) return 0;
      let n = 0;
      for (const m of members) if (s.delete(m)) n++;
      return n;
    }),
    smembers: jest.fn(async (key: string) => Array.from(sets.get(key) ?? [])),
    scard: jest.fn(async (key: string) => (sets.get(key)?.size ?? 0)),
    get: jest.fn(),
    set: jest.fn(),
    eval: jest.fn(),
    publish: jest.fn(),
    subscribe: jest.fn(),
    on: jest.fn(),
    quit: jest.fn(),
    state: { hashes, sets },
  };
}

function makeDirectory(opts?: { internalAddress?: string; heartbeatAlive?: boolean }) {
  const redis = makeRedisStub();
  const heartbeat = {
    isAlive: jest.fn(async () => opts?.heartbeatAlive ?? true),
  };
  const strapi = makeStrapi({
    config: {
      redis: {
        enabled: true,
        url: 'redis://localhost:6379',
        internalAddress: opts?.internalAddress ?? 'http://localhost:1337',
      },
    },
    services: {
      redis: {
        get: async () => redis,
        key: (...parts: string[]) => 'mcp:' + parts.join(':'),
      },
      heartbeat,
    },
  });
  return { dir: directoryFactory({ strapi }), redis, heartbeat };
}

describe('session-directory.isActive', () => {
  it('false when redis not enabled', async () => {
    const strapi = makeStrapi({
      services: { redis: { get: async () => null, key: () => '' }, heartbeat: { isAlive: async () => true } },
    });
    expect(await directoryFactory({ strapi }).isActive()).toBe(false);
  });

  it('false when internalAddress missing', async () => {
    const strapi = makeStrapi({
      config: { redis: { enabled: true, url: 'redis://x' } }, // no internalAddress
      services: {
        redis: { get: async () => ({}), key: () => '' },
        heartbeat: { isAlive: async () => true },
      },
    });
    expect(await directoryFactory({ strapi }).isActive()).toBe(false);
  });

  it('true when both enabled and internalAddress present', async () => {
    const { dir } = makeDirectory();
    expect(await dir.isActive()).toBe(true);
  });
});

describe('session-directory.register + lookup', () => {
  it('round-trips a session entry', async () => {
    const { dir } = makeDirectory();
    await dir.register({
      id: 'sid-1',
      instance: 'inst-A',
      address: 'http://localhost:1337',
      adminUserId: '1',
      clientId: 'cid',
      createdAt: 100,
      expiresAt: 200,
    });
    const got = await dir.lookup('sid-1');
    expect(got?.instance).toBe('inst-A');
    expect(got?.adminUserId).toBe('1');
    expect(got?.address).toBe('http://localhost:1337');
  });

  it('lookup returns null for unknown id', async () => {
    const { dir } = makeDirectory();
    expect(await dir.lookup('nope')).toBeNull();
  });

  it('lookup returns null when heartbeat says owner is dead, and unregisters the entry', async () => {
    const { dir, heartbeat, redis } = makeDirectory({ heartbeatAlive: true });
    await dir.register({
      id: 'sid-dead',
      instance: 'inst-X',
      address: 'http://10.0.0.9:1337',
      adminUserId: '1',
      clientId: 'cid',
      createdAt: 100,
      expiresAt: 200,
    });
    heartbeat.isAlive.mockResolvedValueOnce(false);
    expect(await dir.lookup('sid-dead')).toBeNull();
    // verify the entry was scrubbed
    expect(redis.del).toHaveBeenCalledWith('mcp:sess:sid-dead');
  });
});

describe('session-directory — principal index', () => {
  it('countForPrincipal reflects registered sessions', async () => {
    const { dir } = makeDirectory();
    await dir.register({
      id: 'a',
      instance: 'i',
      address: 'http://x',
      adminUserId: '1',
      clientId: 'cid',
      createdAt: 1,
      expiresAt: 2,
    });
    await dir.register({
      id: 'b',
      instance: 'i',
      address: 'http://x',
      adminUserId: '1',
      clientId: 'cid',
      createdAt: 1,
      expiresAt: 2,
    });
    expect(await dir.countForPrincipal('1', 'cid')).toBe(2);
  });

  it('unregister decrements count', async () => {
    const { dir } = makeDirectory();
    await dir.register({
      id: 'a',
      instance: 'i',
      address: 'http://x',
      adminUserId: '1',
      clientId: 'cid',
      createdAt: 1,
      expiresAt: 2,
    });
    await dir.unregister('a', { adminUserId: '1', clientId: 'cid', jti: '' });
    expect(await dir.countForPrincipal('1', 'cid')).toBe(0);
  });
});
