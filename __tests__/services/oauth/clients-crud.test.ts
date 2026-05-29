'use strict';

import clientsFactory from '../../../server/src/services/oauth/clients';
import { makeStrapi, mockQuery } from '../../helpers/strapi-mock';

function makeClients() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = [];
  const query = mockQuery({
    create: jest.fn(async ({ data }) => {
      const row = { id: rows.length + 1, ...data };
      rows.push(row);
      return row;
    }),
    findOne: jest.fn(async ({ where }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rows.find((r: any) => {
        if (where.clientId && r.clientId !== where.clientId) return false;
        if (where.disabled !== undefined && r.disabled !== where.disabled) return false;
        return true;
      }) ?? null;
    }),
  });
  const strapi = makeStrapi({
    query: { 'plugin::mcp-server.oauth-client': query },
  });
  return { svc: clientsFactory({ strapi }), rows };
}

describe('clients.create', () => {
  it('creates a public client (no secret returned)', async () => {
    const { svc } = makeClients();
    const { client, clientSecret } = await svc.create({
      clientName: 'My CLI',
      redirectUris: ['http://localhost/callback'],
      scopes: ['strapi:content:read'],
      isConfidential: false,
    });
    expect(clientSecret).toBeUndefined();
    expect(client.clientName).toBe('My CLI');
    expect(client.tokenEndpointAuthMethod).toBe('none');
    expect(client.isConfidential).toBe(false);
  });

  it('creates a confidential client and returns the raw secret exactly once', async () => {
    const { svc, rows } = makeClients();
    const { client, clientSecret } = await svc.create({
      clientName: 'Server',
      redirectUris: ['https://app.example.com/cb'],
      scopes: ['strapi:content:read', 'strapi:content:write'],
      isConfidential: true,
    });
    expect(typeof clientSecret).toBe('string');
    expect(clientSecret!.length).toBeGreaterThan(20);
    expect(client.isConfidential).toBe(true);
    // The raw secret must not be stored — only the hash
    expect(rows[0].clientSecretHash).toBeDefined();
    expect(rows[0].clientSecretHash).not.toBe(clientSecret);
  });

  it('issues a unique client_id per call', async () => {
    const { svc } = makeClients();
    const a = await svc.create({
      clientName: 'A',
      redirectUris: ['http://localhost/callback'],
      scopes: ['strapi:content:read'],
      isConfidential: false,
    });
    const b = await svc.create({
      clientName: 'B',
      redirectUris: ['http://localhost/callback'],
      scopes: ['strapi:content:read'],
      isConfidential: false,
    });
    expect(a.client.clientId).not.toBe(b.client.clientId);
  });

  it('rejects empty redirect URI list', async () => {
    const { svc } = makeClients();
    await expect(
      svc.create({
        clientName: 'x',
        redirectUris: [],
        scopes: ['strapi:content:read'],
        isConfidential: false,
      })
    ).rejects.toThrow(/redirectUris/);
  });

  it('rejects http:// for non-loopback hosts', async () => {
    const { svc } = makeClients();
    await expect(
      svc.create({
        clientName: 'x',
        redirectUris: ['http://app.example.com/cb'],
        scopes: ['strapi:content:read'],
        isConfidential: false,
      })
    ).rejects.toThrow(/loopback/);
  });

  it('rejects javascript: scheme', async () => {
    const { svc } = makeClients();
    await expect(
      svc.create({
        clientName: 'x',
        // eslint-disable-next-line no-script-url
        redirectUris: ['javascript:alert(1)'],
        scopes: ['strapi:content:read'],
        isConfidential: false,
      })
    ).rejects.toThrow();
  });

  it('rejects redirect URI with fragment', async () => {
    const { svc } = makeClients();
    await expect(
      svc.create({
        clientName: 'x',
        redirectUris: ['https://app.example.com/cb#token'],
        scopes: ['strapi:content:read'],
        isConfidential: false,
      })
    ).rejects.toThrow(/fragment/);
  });

  it('rejects when no valid scope is requested', async () => {
    const { svc } = makeClients();
    await expect(
      svc.create({
        clientName: 'x',
        redirectUris: ['http://localhost/cb'],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scopes: ['totally-bogus-scope'] as any,
        isConfidential: false,
      })
    ).rejects.toThrow(/valid scope/);
  });

  it('keeps only valid scopes and drops unknowns silently', async () => {
    const { svc } = makeClients();
    const { client } = await svc.create({
      clientName: 'x',
      redirectUris: ['http://localhost/cb'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scopes: ['strapi:content:read', 'fake-scope'] as any,
      isConfidential: false,
    });
    expect(client.scopes).toEqual(['strapi:content:read']);
  });
});

describe('clients.findActive', () => {
  it('returns null when not found', async () => {
    const { svc } = makeClients();
    expect(await svc.findActive('does-not-exist')).toBeNull();
  });

  it('returns the row for an active client', async () => {
    const { svc } = makeClients();
    const { client } = await svc.create({
      clientName: 'x',
      redirectUris: ['http://localhost/cb'],
      scopes: ['strapi:content:read'],
      isConfidential: false,
    });
    const found = await svc.findActive(client.clientId);
    expect(found?.clientId).toBe(client.clientId);
  });
});
