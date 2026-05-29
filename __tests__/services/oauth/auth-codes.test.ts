'use strict';

import authCodesFactory from '../../../server/src/services/oauth/auth-codes';
import type { AuthCodeRow } from '../../../server/src/services/oauth/auth-codes';
import { makeStrapi, mockQuery } from '../../helpers/strapi-mock';

function makeAuthCodes(rows: AuthCodeRow[] = []) {
  const query = mockQuery({
    create: jest.fn(async ({ data }) => {
      const row = { id: rows.length + 1, ...data } as AuthCodeRow;
      rows.push(row);
      return row;
    }),
    findOne: jest.fn(async ({ where }: { where: Partial<AuthCodeRow> }) => {
      if ('codeHash' in where) {
        return rows.find((r) => r.codeHash === where.codeHash) ?? null;
      }
      if ('id' in where) {
        return rows.find((r) => r.id === where.id) ?? null;
      }
      return null;
    }),
    update: jest.fn(async ({ where, data }: { where: { id: number; used?: boolean }; data: Partial<AuthCodeRow> }) => {
      const row = rows.find((r) => r.id === where.id && (where.used === undefined || r.used === where.used));
      if (row) Object.assign(row, data);
      return row;
    }),
  });
  const strapi = makeStrapi({
    query: { 'plugin::mcp-server.oauth-auth-code': query },
  });
  return { svc: authCodesFactory({ strapi }), rows };
}

describe('auth-codes.issue', () => {
  it('returns a base64url code and stores hash', async () => {
    const { svc, rows } = makeAuthCodes();
    const code = await svc.issue({
      clientId: 'cid',
      adminUserId: '1',
      scope: 'strapi:content:read',
      redirectUri: 'http://localhost/callback',
      codeChallenge: 'challenge',
      resource: 'http://localhost:1337/mcp',
    });
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(rows).toHaveLength(1);
    expect(rows[0].codeHash).not.toBe(code); // raw code never stored
    expect(rows[0].used).toBe(false);
  });
});

describe('auth-codes.consume', () => {
  it('returns the row on first use and marks it used', async () => {
    const { svc, rows } = makeAuthCodes();
    const code = await svc.issue({
      clientId: 'cid',
      adminUserId: '1',
      scope: 'strapi:content:read',
      redirectUri: 'http://localhost/callback',
      codeChallenge: 'cc',
      resource: 'http://localhost:1337/mcp',
    });
    const out = await svc.consume(code);
    expect(out).not.toBe('replayed');
    expect(out).not.toBeNull();
    if (out && out !== 'replayed') expect(out.adminUserId).toBe('1');
    expect(rows[0].used).toBe(true);
  });

  it('returns "replayed" on second use of the same code', async () => {
    const { svc } = makeAuthCodes();
    const code = await svc.issue({
      clientId: 'cid',
      adminUserId: '1',
      scope: 'strapi:content:read',
      redirectUri: 'http://localhost/callback',
      codeChallenge: 'cc',
      resource: 'http://localhost:1337/mcp',
    });
    await svc.consume(code);
    expect(await svc.consume(code)).toBe('replayed');
  });

  it('returns null for unknown code', async () => {
    const { svc } = makeAuthCodes();
    expect(await svc.consume('does-not-exist')).toBeNull();
  });

  it('returns null when code is expired', async () => {
    const { svc, rows } = makeAuthCodes();
    const code = await svc.issue({
      clientId: 'cid',
      adminUserId: '1',
      scope: 'strapi:content:read',
      redirectUri: 'http://localhost/callback',
      codeChallenge: 'cc',
      resource: 'http://localhost:1337/mcp',
    });
    rows[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(await svc.consume(code)).toBeNull();
  });
});
