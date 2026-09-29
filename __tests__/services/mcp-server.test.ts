'use strict';

import { z } from 'zod';
import mcpServerFactory from '../../server/src/services/mcp-server';
import toolRegistryFactory from '../../server/src/services/tool-registry';
import { ALL_SCOPES } from '../../server/src/services/oauth/scopes';
import { makeStrapi } from '../helpers/strapi-mock';

const registry = toolRegistryFactory({ strapi: {} as never });
const allow = { can: new Proxy({}, { get: () => () => true }) };

function build(config: Record<string, unknown> = {}) {
  const audit = { record: jest.fn() };
  const strapi = makeStrapi({
    config: config as never,
    services: {
      permissions: {
        listAllowedUids: () => ['api::a.a'],
        contentChecker: async () => allow,
        uploadManager: async () => ({ isAllowed: true }),
      },
      'tool-registry': registry,
      audit,
    },
  });
  const auth = {
    principal: { user: { id: 1 } },
    scopes: [...ALL_SCOPES],
    clientId: 'c',
    adminUserId: '1',
  };
  const server = mcpServerFactory({ strapi }).create(auth as never);
  const call = async (method: string, params: unknown) => {
    const { mcpServer } = await server;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (mcpServer.server as any)._requestHandlers.get(method);
    return handler({ method, params }, { authInfo: { extra: { mcpAuth: auth } } });
  };
  return { call, audit };
}

beforeEach(() => registry.clear());

describe('tool registry (extension point)', () => {
  it('rejects bad names, reserved prefix and unknown scopes', () => {
    const base = {
      title: 'T',
      description: 'd',
      scope: 'strapi:content:read' as const,
      requires: 'content.read' as const,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
      run: async () => ({}),
    };
    expect(() => registry.register({ ...base, name: 'Bad Name' })).toThrow(/must match/);
    expect(() => registry.register({ ...base, name: 'strapi_x' })).toThrow(/reserved/);
    expect(() => registry.register({ ...base, name: 'acme_x', scope: 'nope' as never })).toThrow(
      /unknown scope/
    );
  });

  it('registered tools are listed and run like built-ins, with structuredContent', async () => {
    registry.register({
      name: 'acme_echo',
      title: 'Echo',
      description: 'Echo back',
      scope: 'strapi:content:read',
      requires: 'content.read',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ msg: z.string() }),
      run: async ({ msg }, auth) => ({ msg, by: auth.principal.user.id }),
    });
    const { call } = build();
    const { tools } = await call('tools/list', {});
    expect(tools.map((t: { name: string }) => t.name)).toContain('acme_echo');
    const res = await call('tools/call', { name: 'acme_echo', arguments: { msg: 'hi' } });
    expect(res.structuredContent).toEqual({ msg: 'hi', by: 1 });
    expect(JSON.parse(res.content[0].text)).toEqual({ msg: 'hi', by: 1 });
  });
});

describe('tool execution', () => {
  it('times out slow tools with a stable error code', async () => {
    registry.register({
      name: 'acme_slow',
      title: 'Slow',
      description: 'never finishes',
      scope: 'strapi:content:read',
      requires: 'content.read',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
      run: () => new Promise(() => undefined),
    });
    const { call } = build({ requestTimeoutMs: 20 });
    const res = await call('tools/call', { name: 'acme_slow', arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('timeout');
  });

  it('skips auditing successful reads when audit.recordReads is false, but keeps errors', async () => {
    registry.register({
      name: 'acme_read',
      title: 'Read',
      description: 'r',
      scope: 'strapi:content:read',
      requires: 'content.read',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ fail: z.boolean() }),
      run: async ({ fail }) => {
        if (fail) throw Object.assign(new Error('nope'), { code: 'bad_request' });
        return {};
      },
    });
    const { call, audit } = build({
      audit: {
        retentionDays: 90,
        redactKeyPatterns: [],
        drainIntervalMs: 1000,
        drainBatchSize: 50,
        recordReads: false,
      },
    });
    await call('tools/call', { name: 'acme_read', arguments: { fail: false } });
    expect(audit.record).not.toHaveBeenCalled();
    await call('tools/call', { name: 'acme_read', arguments: { fail: true } });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ resultStatus: 'error', errorCode: 'bad_request' })
    );
  });
});
