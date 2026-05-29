'use strict';

import sessionStoreFactory from '../../server/src/services/session-store';
import type { Session, SessionPrincipal } from '../../server/src/services/session-store';
import { makeStrapi } from '../helpers/strapi-mock';

function makeFakeSession(id: string, principal: SessionPrincipal): Session {
  const transport = { close: jest.fn(async () => undefined) };
  return {
    id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transport: transport as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mcpServer: {} as any,
    principal,
    scopes: ['strapi:content:read'],
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };
}

function makeStoreWithDirectory(active = false) {
  const directory = {
    isActive: jest.fn(async () => active),
    register: jest.fn(async () => undefined),
    lookup: jest.fn(async () => null),
    unregister: jest.fn(async () => undefined),
    countForPrincipal: jest.fn(async () => 0),
    sessionsForPrincipal: jest.fn(async () => []),
  };
  const strapi = makeStrapi({
    services: {
      'session-directory': directory,
      'instance-id': { get: () => 'inst-A' },
    },
  });
  return { store: sessionStoreFactory({ strapi }), directory };
}

// The session-store keeps a process-level Map. Reset between tests so order
// doesn't matter and cap tests don't leak state.
beforeEach(async () => {
  const { store } = makeStoreWithDirectory(false);
  await store.closeAll();
});

describe('session-store (no Redis directory)', () => {
  it('put + locate returns the session', async () => {
    const { store } = makeStoreWithDirectory(false);
    const principal: SessionPrincipal = { adminUserId: '1', clientId: 'cid', jti: 'j1' };
    const s = makeFakeSession('s1', principal);
    await store.put(s);
    const loc = await store.locate('s1');
    expect(loc?.kind).toBe('local');
    if (loc?.kind === 'local') expect(loc.session.id).toBe('s1');
  });

  it('locate updates lastSeenAt on hit', async () => {
    const { store } = makeStoreWithDirectory(false);
    const s = makeFakeSession('s2', { adminUserId: '1', clientId: 'cid', jti: 'j' });
    s.lastSeenAt = 0;
    await store.put(s);
    const before = s.lastSeenAt;
    await store.locate('s2');
    expect(s.lastSeenAt).toBeGreaterThan(before);
  });

  it('locate returns undefined for unknown id when directory inactive', async () => {
    const { store } = makeStoreWithDirectory(false);
    expect(await store.locate('nope')).toBeUndefined();
  });

  it('close removes the session and calls transport.close()', async () => {
    const { store } = makeStoreWithDirectory(false);
    const s = makeFakeSession('s3', { adminUserId: '1', clientId: 'cid', jti: 'j' });
    await store.put(s);
    await store.close('s3');
    expect(s.transport.close).toHaveBeenCalled();
    expect(await store.locate('s3')).toBeUndefined();
  });

  it('canCreate enforces maxPerPrincipal (local)', async () => {
    const { store } = makeStoreWithDirectory(false);
    const principal: SessionPrincipal = { adminUserId: '1', clientId: 'cid', jti: 'j' };
    for (let i = 0; i < 10; i++) {
      await store.put(makeFakeSession(`s${i}`, principal));
    }
    expect(await store.canCreate(principal)).toBe(false);
  });

  it('canCreate enforces maxTotal cap', async () => {
    const { store } = makeStoreWithDirectory(false);
    for (let i = 0; i < 1000; i++) {
      await store.put(
        makeFakeSession(`s${i}`, { adminUserId: String(i), clientId: 'cid', jti: 'j' })
      );
    }
    expect(
      await store.canCreate({ adminUserId: 'new', clientId: 'cid', jti: 'j' })
    ).toBe(false);
  });

  it('closeForPrincipalLocal closes all sessions for a user', async () => {
    const { store } = makeStoreWithDirectory(false);
    await store.put(makeFakeSession('a', { adminUserId: '1', clientId: 'c1', jti: 'j' }));
    await store.put(makeFakeSession('b', { adminUserId: '1', clientId: 'c2', jti: 'j' }));
    await store.put(makeFakeSession('c', { adminUserId: '2', clientId: 'c1', jti: 'j' }));
    await store.closeForPrincipalLocal('1');
    expect(await store.locate('a')).toBeUndefined();
    expect(await store.locate('b')).toBeUndefined();
    expect((await store.locate('c'))?.kind).toBe('local');
  });
});

describe('session-store (Redis directory active)', () => {
  it('locate falls back to directory.lookup on local miss', async () => {
    const { store, directory } = makeStoreWithDirectory(true);
    directory.lookup.mockResolvedValueOnce({
      instance: 'inst-B',
      address: 'http://10.0.0.5:1337',
      adminUserId: '1',
      clientId: 'cid',
      createdAt: 0,
      expiresAt: 0,
    });
    const loc = await store.locate('remote-sid');
    expect(loc?.kind).toBe('remote');
    if (loc?.kind === 'remote') {
      expect(loc.address).toBe('http://10.0.0.5:1337');
      expect(loc.instance).toBe('inst-B');
    }
  });

  it('locate treats matching-instance directory entry as stale and unregisters', async () => {
    const { store, directory } = makeStoreWithDirectory(true);
    directory.lookup.mockResolvedValueOnce({
      instance: 'inst-A', // matches our own
      address: 'http://localhost:1337',
      adminUserId: '1',
      clientId: 'cid',
      createdAt: 0,
      expiresAt: 0,
    });
    const loc = await store.locate('stale-sid');
    expect(loc).toBeUndefined();
    expect(directory.unregister).toHaveBeenCalledWith('stale-sid', expect.any(Object));
  });

  it('canCreate consults directory countForPrincipal when active', async () => {
    const { store, directory } = makeStoreWithDirectory(true);
    directory.countForPrincipal.mockResolvedValueOnce(10); // at cap
    expect(
      await store.canCreate({ adminUserId: '1', clientId: 'cid', jti: 'j' })
    ).toBe(false);
  });
});
