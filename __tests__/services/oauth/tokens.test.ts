'use strict';

import { generateKeyPair, exportJWK, SignJWT, type KeyLike, type JWK } from 'jose';
import tokensFactory from '../../../server/src/services/oauth/tokens';
import { makeStrapi, mockQuery } from '../../helpers/strapi-mock';

interface FakeRefreshRow {
  id: number;
  tokenHash: string;
  familyId: string;
  parentJti: string | null;
  clientId: string;
  adminUserId: string;
  scope: string;
  rotatedTo: string | null;
  revoked: boolean;
  expiresAt: string;
}

let key: { privateKey: KeyLike; publicJwk: JWK; alg: string; kid: string };

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  key = { privateKey: pair.privateKey, publicJwk, alg: 'RS256', kid: 'test-kid' };
});

function makeTokens(opts?: {
  resourceUrl?: string;
  external?: { issuer: string; jwksUri: string; enforceScopes?: boolean };
  mode?: 'embedded' | 'external';
  refreshTable?: FakeRefreshRow[];
  revokedJtis?: string[];
}) {
  const refreshTable = opts?.refreshTable ?? [];
  const revokedJtis = new Set(opts?.revokedJtis ?? []);

  const signingKeysSvc = {
    getActiveKey: async () => key,
    publicJwks: async () => ({ keys: [{ ...key.publicJwk, kid: key.kid, alg: key.alg }] }),
  };

  const refreshQuery = mockQuery({
    create: jest.fn(async ({ data }) => {
      const row = { id: refreshTable.length + 1, ...data } as FakeRefreshRow;
      refreshTable.push(row);
      return row;
    }),
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      refreshTable.find((r) => r.tokenHash === where.tokenHash) ?? null
    ),
    update: jest.fn(async ({ where, data }: { where: { id: number }; data: Partial<FakeRefreshRow> }) => {
      const row = refreshTable.find((r) => r.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<FakeRefreshRow> }) => {
      const familyId = where.familyId as string;
      let n = 0;
      for (const r of refreshTable) {
        if (r.familyId === familyId) {
          Object.assign(r, data);
          n++;
        }
      }
      return { count: n };
    }),
  });

  const revQuery = mockQuery({
    findOne: jest.fn(async ({ where }: { where: { jti: string } }) =>
      revokedJtis.has(where.jti) ? { jti: where.jti } : null
    ),
    create: jest.fn(async ({ data }: { data: { jti: string } }) => {
      revokedJtis.add(data.jti);
      return data;
    }),
  });

  const strapi = makeStrapi({
    config: {
      resourceUrl: opts?.resourceUrl ?? 'http://localhost:1337/mcp',
      oauth: {
        mode: opts?.mode ?? 'embedded',
        accessTokenTtlSec: 600,
        refreshTokenTtlSec: 86400,
        authCodeTtlSec: 60,
        ssoCookieTtlSec: 900,
        dcr: { enabled: false, ratelimitPerHour: 60 },
        consent: { rememberDays: 0 },
        introspection: { allowedIps: ['127.0.0.1'] },
        ...(opts?.external ? { external: opts.external } : {}),
      },
    },
    services: { 'signing-keys': signingKeysSvc },
    query: {
      'plugin::mcp-server.oauth-refresh-token': refreshQuery,
      'plugin::mcp-server.oauth-revocation': revQuery,
      'plugin::mcp-server.oauth-auth-code': mockQuery(),
    },
  });
  return { tokens: tokensFactory({ strapi }), refreshTable, revokedJtis, strapi };
}

describe('tokens.mint (embedded)', () => {
  it('mints an access + refresh pair with required claims', async () => {
    const { tokens, refreshTable } = makeTokens();
    const result = await tokens.mint({
      adminUserId: '1',
      clientId: 'cid',
      scope: ['strapi:content:read'],
    });
    expect(result.accessToken.split('.').length).toBe(3); // header.payload.sig
    expect(typeof result.refreshToken).toBe('string');
    expect(result.refreshToken.length).toBeGreaterThan(30);
    expect(refreshTable).toHaveLength(1);
    expect(refreshTable[0].adminUserId).toBe('1');
    expect(refreshTable[0].clientId).toBe('cid');
  });

  it('verifies its own minted token successfully', async () => {
    const { tokens } = makeTokens();
    const { accessToken } = await tokens.mint({
      adminUserId: '42',
      clientId: 'cid',
      scope: ['strapi:content:read', 'strapi:media:read'],
    });
    const claims = await tokens.verifyAccessToken(accessToken);
    expect(claims.sub).toBe('42');
    expect(claims.clientId).toBe('cid');
    expect(claims.scope).toContain('strapi:content:read');
  });
});

describe('tokens.verifyAccessToken (embedded)', () => {
  it('rejects expired tokens with "expired"', async () => {
    const { tokens } = makeTokens();
    const expired = await new SignJWT({ scope: 'strapi:content:read', client_id: 'cid', jti: 'j1' })
      .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'at+jwt' })
      .setIssuer('http://localhost:1337')
      .setSubject('1')
      .setAudience('http://localhost:1337/mcp')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key.privateKey);
    await expect(tokens.verifyAccessToken(expired)).rejects.toThrow('expired');
  });

  it('rejects tokens with wrong issuer', async () => {
    const { tokens } = makeTokens();
    const bad = await new SignJWT({ scope: 'strapi:content:read', client_id: 'cid', jti: 'j2' })
      .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'at+jwt' })
      .setIssuer('http://attacker.example.com')
      .setSubject('1')
      .setAudience('http://localhost:1337/mcp')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(key.privateKey);
    await expect(tokens.verifyAccessToken(bad)).rejects.toThrow('invalid_token');
  });

  it('rejects tokens with wrong audience', async () => {
    const { tokens } = makeTokens();
    const bad = await new SignJWT({ scope: 'strapi:content:read', client_id: 'cid', jti: 'j3' })
      .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'at+jwt' })
      .setIssuer('http://localhost:1337')
      .setSubject('1')
      .setAudience('http://other.example.com/mcp')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(key.privateKey);
    await expect(tokens.verifyAccessToken(bad)).rejects.toThrow('invalid_token');
  });

  it('rejects revoked jti', async () => {
    const { tokens } = makeTokens({ revokedJtis: ['j-revoked'] });
    const tok = await new SignJWT({ scope: 'strapi:content:read', client_id: 'cid', jti: 'j-revoked' })
      .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'at+jwt' })
      .setIssuer('http://localhost:1337')
      .setSubject('1')
      .setAudience('http://localhost:1337/mcp')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(key.privateKey);
    await expect(tokens.verifyAccessToken(tok)).rejects.toThrow('invalid_token');
  });

  it('rejects token with no jti', async () => {
    const { tokens } = makeTokens();
    const tok = await new SignJWT({ scope: 'strapi:content:read', client_id: 'cid' })
      .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'at+jwt' })
      .setIssuer('http://localhost:1337')
      .setSubject('1')
      .setAudience('http://localhost:1337/mcp')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(key.privateKey);
    await expect(tokens.verifyAccessToken(tok)).rejects.toThrow('invalid_token');
  });
});

describe('tokens.consumeRefresh — rotation + family revocation', () => {
  it('returns the row on first use', async () => {
    const { tokens } = makeTokens();
    const minted = await tokens.mint({ adminUserId: '1', clientId: 'cid', scope: ['strapi:content:read'] });
    const row = await tokens.consumeRefresh(minted.refreshToken);
    expect(row).not.toBeNull();
    expect(row?.adminUserId).toBe('1');
  });

  it('returns null on reuse AND revokes the entire family', async () => {
    const { tokens, refreshTable } = makeTokens();
    const minted = await tokens.mint({ adminUserId: '1', clientId: 'cid', scope: ['strapi:content:read'] });
    // simulate prior rotation — mark first row as rotated
    refreshTable[0].rotatedTo = 'some-new-hash';
    const reused = await tokens.consumeRefresh(minted.refreshToken);
    expect(reused).toBeNull();
    // family revoked → row.revoked should now be true
    expect(refreshTable[0].revoked).toBe(true);
  });

  it('returns null for an unknown refresh token', async () => {
    const { tokens } = makeTokens();
    expect(await tokens.consumeRefresh('does-not-exist')).toBeNull();
  });

  it('returns null when refresh token is expired', async () => {
    const { tokens, refreshTable } = makeTokens();
    const minted = await tokens.mint({ adminUserId: '1', clientId: 'cid', scope: ['strapi:content:read'] });
    // force expiry in the past
    refreshTable[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(await tokens.consumeRefresh(minted.refreshToken)).toBeNull();
  });

  it('returns null when refresh token is already revoked', async () => {
    const { tokens, refreshTable } = makeTokens();
    const minted = await tokens.mint({ adminUserId: '1', clientId: 'cid', scope: ['strapi:content:read'] });
    refreshTable[0].revoked = true;
    expect(await tokens.consumeRefresh(minted.refreshToken)).toBeNull();
  });
});

describe('tokens.revokeAccessJti', () => {
  it('adds the jti to the revocation list', async () => {
    const { tokens, strapi } = makeTokens();
    await tokens.revokeAccessJti('j-target', new Date(Date.now() + 3600 * 1000));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = (strapi.db.query as any)('plugin::mcp-server.oauth-revocation');
    expect(query.create).toHaveBeenCalledWith({
      data: { jti: 'j-target', expiresAt: expect.any(Date) },
    });
  });
});

describe('tokens.verifyAccessToken (external)', () => {
  it('returns invalid_token when external mode is set but external config missing', async () => {
    const { tokens } = makeTokens({ mode: 'external' /* no external block */ });
    await expect(tokens.verifyAccessToken('any-token')).rejects.toThrow('invalid_token');
  });
});
