'use strict';

import { createContentTools } from '../../../server/src/services/tools/content';
import { makeStrapi, mockQuery } from '../../helpers/strapi-mock';

const CONTENT_TYPES = {
  'api::article.article': {
    kind: 'collectionType',
    info: { displayName: 'Article', pluralName: 'articles' },
    options: { draftAndPublish: true },
    attributes: { title: { type: 'string' } },
  },
  'api::page.page': {
    kind: 'singleType',
    info: { displayName: 'Page' },
    attributes: { body: { type: 'text' } },
  },
  'admin::user': { kind: 'collectionType', attributes: {} },
  'plugin::mcp-server.audit-log': { kind: 'collectionType', attributes: {} },
};

function makeTool(name: string, opts?: { isSuperAdmin?: boolean; scopes?: string[] }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakePermissions: any = {
    listAllowedUids: () => ['api::article.article', 'api::page.page'],
    canActionOnUid: jest.fn(async (_principal, uid, _action) => {
      // Internal UIDs are blocked by the service in real life; here we just
      // mirror that.
      return !uid.startsWith('admin::') && !uid.startsWith('plugin::mcp-server.');
    }),
    isInternalUid: (uid: string) =>
      uid.startsWith('admin::') || uid.startsWith('plugin::mcp-server.') || uid.startsWith('strapi::'),
  };
  const strapi = makeStrapi({
    contentTypes: CONTENT_TYPES,
    services: { permissions: fakePermissions },
    query: { 'api::article.article': mockQuery() },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (strapi as any).documents = jest.fn(() => ({
    findMany: jest.fn(async () => [{ documentId: 'doc1' }, { documentId: 'doc2' }]),
    findOne: jest.fn(async () => ({ documentId: 'doc1' })),
    create: jest.fn(async ({ data }) => ({ documentId: 'docN', ...data })),
    update: jest.fn(async ({ data }) => ({ documentId: 'doc1', ...data })),
  }));
  const tools = createContentTools({
    strapi,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    principal: { user: { id: 1 }, permissions: [], isSuperAdmin: !!opts?.isSuperAdmin } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scopes: (opts?.scopes ?? [
      'strapi:content:read',
      'strapi:content:write',
    ]) as any,
  });
  return tools.find((t) => t.name === name)!;
}

describe('content tools — scope enforcement', () => {
  it('list_types requires strapi:content:read', async () => {
    const tool = makeTool('strapi.content.list_types', { scopes: ['strapi:media:read'] });
    await expect(tool.handler({})).rejects.toMatchObject({ code: 'insufficient_scope' });
  });

  it('create_entry requires strapi:content:write', async () => {
    const tool = makeTool('strapi.content.create_entry', { scopes: ['strapi:content:read'] });
    await expect(
      tool.handler({ uid: 'api::article.article', data: { title: 'x' } })
    ).rejects.toMatchObject({ code: 'insufficient_scope' });
  });
});

describe('content tools — UID validation', () => {
  it('rejects internal admin::* in get_schema', async () => {
    const tool = makeTool('strapi.content.get_schema');
    await expect(tool.handler({ uid: 'admin::user' })).rejects.toThrow(/unknown or disallowed uid/);
  });

  it('rejects unknown UIDs in get_schema', async () => {
    const tool = makeTool('strapi.content.get_schema');
    await expect(tool.handler({ uid: 'api::nonsense.thing' })).rejects.toThrow(
      /unknown or disallowed uid/
    );
  });

  it('rejects plugin::mcp-server.* in any tool', async () => {
    const tool = makeTool('strapi.content.list_entries');
    await expect(
      tool.handler({ uid: 'plugin::mcp-server.audit-log' })
    ).rejects.toThrow(/unknown or disallowed uid/);
  });

  it('accepts allowed api::* UID', async () => {
    const tool = makeTool('strapi.content.list_entries');
    const result = await tool.handler({ uid: 'api::article.article' });
    expect(result.content).toBeDefined();
  });
});

describe('content tools — input schema bounds', () => {
  const tool = makeTool('strapi.content.list_entries');

  it('rejects pageSize > 100', async () => {
    await expect(
      tool.handler({ uid: 'api::article.article', pagination: { pageSize: 101 } })
    ).rejects.toBeDefined();
  });

  it('rejects invalid locale format', async () => {
    await expect(
      tool.handler({ uid: 'api::article.article', locale: 'not-a-locale' })
    ).rejects.toBeDefined();
  });

  it('accepts valid bcp47-style locale "en-US"', async () => {
    const r = await tool.handler({ uid: 'api::article.article', locale: 'en-US' });
    expect(r.content).toBeDefined();
  });

  it('rejects invalid status enum', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool.handler({ uid: 'api::article.article', status: 'archived' as any })
    ).rejects.toBeDefined();
  });
});
