'use strict';

import registerFactory from '../../../server/src/controllers/oauth/register';
import { makeStrapi } from '../../helpers/strapi-mock';

interface FakeCtx {
  status?: number;
  body?: unknown;
  ip?: string;
  request: {
    ip?: string;
    body?: unknown;
    header: Record<string, string | undefined>;
  };
  response: { set: jest.Mock };
}

function ctx(body: unknown, ip = '1.1.1.1'): FakeCtx {
  return {
    ip,
    request: { ip, body, header: { 'user-agent': 'jest' } },
    response: { set: jest.fn() },
  };
}

function makeController(opts?: {
  dcrEnabled?: boolean;
  externalMode?: boolean;
  rateLimitWait?: number;
}) {
  const audit = { record: jest.fn() };
  const rateLimiter = { checkDcr: jest.fn(async () => opts?.rateLimitWait ?? 0) };
  const clientsCreate = jest.fn(async ({ clientName, redirectUris, scopes, isConfidential }) => ({
    client: {
      clientId: 'generated-id',
      clientName,
      redirectUris,
      scopes,
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: isConfidential ? 'client_secret_post' : 'none',
      isConfidential,
    },
    clientSecret: isConfidential ? 'raw-secret' : undefined,
  }));
  const strapi = makeStrapi({
    config: {
      oauth: {
        mode: opts?.externalMode ? 'external' : 'embedded',
        accessTokenTtlSec: 600,
        refreshTokenTtlSec: 86400,
        authCodeTtlSec: 60,
        ssoCookieTtlSec: 900,
        dcr: { enabled: opts?.dcrEnabled ?? true, ratelimitPerHour: 60 },
        consent: { rememberDays: 0 },
        introspection: { allowedIps: ['127.0.0.1'] },
        ...(opts?.externalMode
          ? { external: { issuer: 'https://idp.example.com', jwksUri: 'https://idp.example.com/jwks' } }
          : {}),
      },
    },
    services: {
      audit,
      'rate-limiter': rateLimiter,
      clients: { create: clientsCreate },
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { controller: registerFactory({ strapi } as any), audit, rateLimiter, clientsCreate };
}

describe('oauth/register controller', () => {
  it('400s when client_name + redirect_uris are missing', async () => {
    const { controller } = makeController();
    const c = ctx({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.register(c as any);
    expect(c.status).toBe(400);
    expect((c.body as Record<string, string>).error).toBe('invalid_client_metadata');
  });

  it('403s when DCR is disabled', async () => {
    const { controller } = makeController({ dcrEnabled: false });
    const c = ctx({ client_name: 'x', redirect_uris: ['http://localhost/cb'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.register(c as any);
    expect(c.status).toBe(403);
    expect((c.body as Record<string, string>).error).toBe('dcr_disabled');
  });

  it('404s in external mode (DCR endpoint is hidden when external AS owns auth)', async () => {
    const { controller } = makeController({ externalMode: true });
    const c = ctx({ client_name: 'x', redirect_uris: ['http://localhost/cb'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.register(c as any);
    expect(c.status).toBe(404);
  });

  it('429s when rate-limit exceeded, sets Retry-After, audits', async () => {
    const { controller, audit } = makeController({ rateLimitWait: 42 });
    const c = ctx({ client_name: 'x', redirect_uris: ['http://localhost/cb'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.register(c as any);
    expect(c.status).toBe(429);
    expect(c.response.set).toHaveBeenCalledWith('Retry-After', '42');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        resultStatus: 'error',
        errorCode: 'too_many_requests',
        tool: 'oauth.dcr.register',
      })
    );
  });

  it('201s on happy path with all four scopes when scope param omitted', async () => {
    const { controller, clientsCreate } = makeController();
    const c = ctx({ client_name: 'CLI', redirect_uris: ['http://localhost/callback'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.register(c as any);
    expect(c.status).toBe(201);
    expect(clientsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: expect.arrayContaining([
          'strapi:content:read',
          'strapi:content:write',
          'strapi:media:read',
          'strapi:media:write',
        ]),
      })
    );
  });

  it('honors token_endpoint_auth_method to flip confidential', async () => {
    const { controller, clientsCreate } = makeController();
    const c = ctx({
      client_name: 'Server',
      redirect_uris: ['https://app.example.com/cb'],
      token_endpoint_auth_method: 'client_secret_post',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.register(c as any);
    expect(clientsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ isConfidential: true })
    );
    expect(c.status).toBe(201);
    expect((c.body as Record<string, unknown>).client_secret).toBe('raw-secret');
  });

  it('emits an ok audit entry on success', async () => {
    const { controller, audit } = makeController();
    const c = ctx({ client_name: 'X', redirect_uris: ['http://localhost/cb'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.register(c as any);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ resultStatus: 'ok', tool: 'oauth.dcr.register' })
    );
  });

  it('400s when clients.create throws (e.g. invalid redirect URI)', async () => {
    const { controller } = makeController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const strapi: any = (controller as any).constructor; // not used; we already mocked clientsCreate
    // Just re-build with a throwing create
    const audit = { record: jest.fn() };
    const rl = { checkDcr: jest.fn(async () => 0) };
    const throwingClients = { create: jest.fn(async () => { throw new Error('invalid redirectUri'); }) };
    const s = makeStrapi({
      config: { oauth: { mode: 'embedded', dcr: { enabled: true, ratelimitPerHour: 60 } } as never },
      services: { audit, 'rate-limiter': rl, clients: throwingClients },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctl = registerFactory({ strapi: s } as any);
    const c = ctx({ client_name: 'x', redirect_uris: ['javascript:foo'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctl.register(c as any);
    expect(c.status).toBe(400);
    expect((c.body as Record<string, string>).error).toBe('invalid_client_metadata');
  });
});
