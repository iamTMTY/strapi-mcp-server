'use strict';

import { createContentTools } from '../../../server/src/services/tools/content';
import { makeStrapi } from '../../helpers/strapi-mock';

const CONTENT_TYPES = {
  'api::article.article': {
    kind: 'collectionType',
    info: { displayName: 'Article', pluralName: 'articles' },
    options: { draftAndPublish: true },
    pluginOptions: { i18n: { localized: true } },
    attributes: {
      title: { type: 'string' },
      secret: { type: 'string', private: true },
      seo: { type: 'component', component: 'shared.seo' },
    },
  },
  'api::page.page': {
    kind: 'singleType',
    info: { displayName: 'Page' },
    attributes: { body: { type: 'text' } },
  },
  'admin::user': { kind: 'collectionType', attributes: {} },
  'plugin::mcp-server.audit-log': { kind: 'collectionType', attributes: {} },
};

const COMPONENTS = {
  'shared.seo': {
    attributes: { meta: { type: 'string' }, image: { type: 'component', component: 'shared.img' } },
  },
  'shared.img': { attributes: { alt: { type: 'string' } } },
};

/** A permission-checker double: everything allowed unless overridden. */
function makeChecker(
  overrides: { cannot?: Record<string, (e?: unknown) => boolean>; readableFields?: string[] } = {}
) {
  const deny = overrides.cannot ?? {};
  const actions = ['read', 'create', 'update', 'delete', 'publish', 'unpublish', 'discard'];
  return {
    can: Object.fromEntries(
      actions.map((a) => [
        a,
        (_e?: unknown, field?: string) =>
          !(deny[a]?.(_e) ?? false) &&
          (field === undefined ||
            !overrides.readableFields ||
            overrides.readableFields.includes(field)),
      ])
    ),
    cannot: Object.fromEntries(actions.map((a) => [a, (e?: unknown) => deny[a]?.(e) ?? false])),
    validateQuery: jest.fn(async (q: { filters?: Record<string, unknown> }) => {
      if (q.filters && 'password' in q.filters) throw new Error('Invalid key password');
    }),
    sanitizedQuery: Object.fromEntries(
      actions.map((a) => [
        a,
        jest.fn(async (q: Record<string, unknown>) => ({
          ...q,
          filters: { $and: [q.filters ?? {}, { cond: 1 }] },
        })),
      ])
    ),
    sanitizeOutput: jest.fn(async (d: Record<string, unknown> | null) =>
      d ? { ...d, sanitized: true } : d
    ),
    sanitizeCreateInput: jest.fn(async (d: Record<string, unknown>) => ({
      ...d,
      cleanedForCreate: true,
    })),
    sanitizeUpdateInput: jest.fn(() => async (d: Record<string, unknown>) => ({
      ...d,
      cleanedForUpdate: true,
    })),
  };
}

function setup(opts: { scopes?: string[]; checker?: ReturnType<typeof makeChecker> } = {}) {
  const checker = opts.checker ?? makeChecker();
  const permissions = {
    listAllowedUids: () => ['api::article.article', 'api::page.page'],
    isInternalUid: (uid: string) =>
      uid.startsWith('admin::') || uid.startsWith('plugin::mcp-server.'),
    contentChecker: jest.fn(async () => checker),
  };
  const strapi = makeStrapi({ contentTypes: CONTENT_TYPES, services: { permissions } });
  const docApi = {
    findMany: jest.fn(async () => [{ documentId: 'doc1' }, { documentId: 'doc2' }]),
    findFirst: jest.fn(async () => ({ documentId: 'doc1' })),
    findOne: jest.fn(async () => ({ documentId: 'doc1', createdBy: { id: 9 } })),
    count: jest.fn(async () => 42),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      documentId: 'docN',
      ...data,
    })),
    update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      documentId: 'doc1',
      ...data,
    })),
    delete: jest.fn(async () => ({})),
    publish: jest.fn(async () => ({ entries: [{ documentId: 'doc1', publishedAt: 'now' }] })),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = strapi as any;
  s.documents = jest.fn(() => docApi);
  s.components = COMPONENTS;
  s.db.query = jest.fn(() => ({ count: jest.fn(async () => 1) }));
  const localeSvc = {
    getDefaultLocale: async () => 'en',
    find: async () => [{ code: 'en' }, { code: 'zh-Hans' }],
  };
  const populateBuilder = () => ({
    populateFromQuery: () => ({ build: async () => ({ createdBy: {} }) }),
  });
  s.plugin = jest.fn((name: string) => ({
    service: (svc: string) => {
      if (name === 'mcp-server' && svc === 'permissions') return permissions;
      if (name === 'i18n' && svc === 'locales') return localeSvc;
      if (name === 'content-manager' && svc === 'populate-builder') return populateBuilder;
      throw new Error(`unexpected service ${name}.${svc}`);
    },
  }));
  const tools = createContentTools(strapi);
  const auth = {
    clientId: 'cid',
    principal: { user: { id: 7 }, isSuperAdmin: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scopes: (opts.scopes ?? [
      'strapi:content:read',
      'strapi:content:write',
      'strapi:content:publish',
      'strapi:content:delete',
    ]) as any,
  };
  const call = (name: string, args: unknown) =>
    tools.find((t) => t.name === name)!.handler(args, auth);
  const parse = async (p: Promise<{ content: Array<{ text: string }> }>) =>
    JSON.parse((await p).content[0].text);
  return { call, parse, docApi, checker, tools };
}

describe('content tools — scope enforcement', () => {
  it('list_types requires strapi:content:read', async () => {
    const { call } = setup({ scopes: ['strapi:media:read'] });
    await expect(call('strapi_content_list_types', {})).rejects.toMatchObject({
      code: 'insufficient_scope',
    });
  });

  it('create_entry requires strapi:content:write', async () => {
    const { call } = setup({ scopes: ['strapi:content:read'] });
    await expect(
      call('strapi_content_create_entry', { uid: 'api::page.page', data: { body: 'x' } })
    ).rejects.toMatchObject({ code: 'insufficient_scope' });
  });

  it('delete_entry requires strapi:content:delete, not write', async () => {
    const { call } = setup({ scopes: ['strapi:content:read', 'strapi:content:write'] });
    await expect(
      call('strapi_content_delete_entry', { uid: 'api::article.article', documentId: 'doc1' })
    ).rejects.toMatchObject({ code: 'insufficient_scope' });
  });

  it('every tool declares annotations and a title', () => {
    const { tools } = setup();
    for (const t of tools) {
      expect(t.title).toBeTruthy();
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
      expect(t.name).toMatch(/^[a-z_]+$/);
    }
  });
});

describe('content tools — UID validation', () => {
  it('rejects internal admin::* and plugin::mcp-server.*', async () => {
    const { call } = setup();
    await expect(call('strapi_content_get_schema', { uid: 'admin::user' })).rejects.toThrow(
      /unknown or disallowed uid/
    );
    await expect(
      call('strapi_content_list_entries', { uid: 'plugin::mcp-server.audit-log' })
    ).rejects.toThrow(/unknown or disallowed uid/);
  });

  it('rejects unknown UIDs', async () => {
    const { call } = setup();
    await expect(call('strapi_content_get_schema', { uid: 'api::nope.nope' })).rejects.toThrow(
      /unknown or disallowed uid/
    );
  });
});

describe('content tools — RBAC via permission-checker', () => {
  it('forbids reads the role does not have', async () => {
    const { call } = setup({ checker: makeChecker({ cannot: { read: () => true } }) });
    await expect(
      call('strapi_content_list_entries', { uid: 'api::article.article' })
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('list_types hides types the role cannot read', async () => {
    const { call, parse } = setup({ checker: makeChecker({ cannot: { read: () => true } }) });
    expect((await parse(call('strapi_content_list_types', {}))).contentTypes).toEqual([]);
  });

  it('list merges condition filters, sanitizes output and reports the real total', async () => {
    const { call, parse, docApi } = setup();
    const out = await parse(
      call('strapi_content_list_entries', { uid: 'api::article.article', pageSize: 10 })
    );
    const params = (docApi.findMany.mock.calls[0] as unknown[])[0] as {
      filters: unknown;
      limit: number;
    };
    expect(params.filters).toEqual({ $and: [{}, { cond: 1 }] });
    expect(out.results[0].sanitized).toBe(true);
    expect(out.pagination).toEqual({ page: 1, pageSize: 10, total: 42, pageCount: 5 });
  });

  it('turns invalid filters (e.g. private fields) into bad_request instead of silently dropping them', async () => {
    const { call } = setup();
    await expect(
      call('strapi_content_list_entries', {
        uid: 'api::article.article',
        filters: { password: { $startsWith: '$2' } },
      })
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('update is forbidden when the role condition fails on the loaded entry', async () => {
    const checker = makeChecker({
      cannot: { update: (e) => !!e && (e as { createdBy?: { id: number } }).createdBy?.id !== 7 },
    });
    const { call, docApi } = setup({ checker });
    await expect(
      call('strapi_content_update_entry', {
        uid: 'api::article.article',
        documentId: 'doc1',
        data: { title: 'x' },
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(docApi.update).not.toHaveBeenCalled();
  });

  it('create strips non-permitted fields and stamps the creator', async () => {
    const { call, docApi } = setup();
    await call('strapi_content_create_entry', {
      uid: 'api::article.article',
      data: { title: 'x' },
    });
    const data = (
      (docApi.create.mock.calls[0] as unknown[])[0] as { data: Record<string, unknown> }
    ).data;
    expect(data.cleanedForCreate).toBe(true);
    expect(data.createdBy).toBe(7);
  });

  it('get_schema hides private and unreadable fields and resolves nested components', async () => {
    const { call, parse } = setup({ checker: makeChecker({ readableFields: ['title', 'seo'] }) });
    const out = await parse(call('strapi_content_get_schema', { uid: 'api::article.article' }));
    expect(Object.keys(out.attributes)).toEqual(['title', 'seo']);
    expect(Object.keys(out.components).sort()).toEqual(['shared.img', 'shared.seo']);
  });
});

describe('content tools — locales, single types, draft & publish', () => {
  it('accepts script/region locales known to i18n (zh-Hans)', async () => {
    const { call } = setup();
    await expect(
      call('strapi_content_list_entries', { uid: 'api::article.article', locale: 'zh-Hans' })
    ).resolves.toBeDefined();
  });

  it('rejects locales i18n does not know', async () => {
    const { call } = setup();
    await expect(
      call('strapi_content_list_entries', { uid: 'api::article.article', locale: 'fr' })
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects a locale on a non-localized type', async () => {
    const { call } = setup();
    await expect(
      call('strapi_content_get_entry', { uid: 'api::page.page', locale: 'en' })
    ).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('single types resolve their document without documentId', async () => {
    const { call, parse } = setup();
    const out = await parse(call('strapi_content_get_entry', { uid: 'api::page.page' }));
    expect(out.documentId).toBe('doc1');
  });

  it('collection types require documentId', async () => {
    const { call } = setup();
    await expect(
      call('strapi_content_get_entry', { uid: 'api::article.article' })
    ).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('publish refuses types without draft & publish', async () => {
    const { call } = setup();
    await expect(
      call('strapi_content_publish_entry', { uid: 'api::page.page' })
    ).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('publish checks the permission against the draft and returns the published entry', async () => {
    const { call, parse, docApi } = setup();
    const out = await parse(
      call('strapi_content_publish_entry', { uid: 'api::article.article', documentId: 'doc1' })
    );
    expect(docApi.publish).toHaveBeenCalledWith({ documentId: 'doc1', locale: 'en' });
    expect(out.sanitized).toBe(true);
  });

  it('rejects pageSize > 100 and bad status', async () => {
    const { call } = setup();
    await expect(
      call('strapi_content_list_entries', { uid: 'api::article.article', pageSize: 101 })
    ).rejects.toBeDefined();
    await expect(
      call('strapi_content_list_entries', { uid: 'api::article.article', status: 'archived' })
    ).rejects.toBeDefined();
  });
});

describe('content tools — per-action locales and writable fields', () => {
  it('list_types reports locales per action, checked as an entry this admin would create', async () => {
    const seen: unknown[] = [];
    const checker = makeChecker({
      cannot: {
        create: (e) => {
          seen.push(e);
          return (e as { locale?: string } | undefined)?.locale === 'zh-Hans';
        },
      },
    });
    const { call, parse } = setup({ checker });
    const out = await parse(call('strapi_content_list_types', {}));
    const article = out.contentTypes.find((t: { uid: string }) => t.uid === 'api::article.article');
    expect(article.defaultLocale).toBe('en');
    expect(article.locales.create).toEqual(['en']);
    expect(article.locales.read).toEqual(['en', 'zh-Hans']);
    expect(seen).toContainEqual({ locale: 'en', createdBy: { id: 7 } });
    expect(
      out.contentTypes.find((t: { uid: string }) => t.uid === 'api::page.page').locales
    ).toBeUndefined();
  });

  it('get_schema lists writable fields per action', async () => {
    const checker = makeChecker({ readableFields: ['title', 'seo'] });
    const { call, parse } = setup({ checker });
    const out = await parse(call('strapi_content_get_schema', { uid: 'api::article.article' }));
    expect(out.writableFields).toEqual({ create: ['title', 'seo'], update: ['title', 'seo'] });
  });
});
