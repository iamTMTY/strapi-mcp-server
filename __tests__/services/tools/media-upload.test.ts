'use strict';

import {
  createMediaTools,
  checkFileType,
  isPublicAddress,
} from '../../../server/src/services/tools/media';
import { makeStrapi } from '../../helpers/strapi-mock';

function setup(opts?: {
  allowSvg?: boolean;
  maxBytes?: number;
  scopes?: string[];
  allowed?: boolean;
}) {
  const pm = {
    isAllowed: opts?.allowed ?? true,
    action: 'plugin::upload.read',
    ability: { cannot: () => false },
    toSubject: (x: unknown) => x,
    sanitizeQuery: jest.fn(async (q: unknown) => q),
    addPermissionsQueryTo: jest.fn((q: unknown) => q),
    sanitizeOutput: jest.fn(async (d: unknown) => d),
  };
  const permissions = { uploadManager: jest.fn(async () => pm) };
  const strapi = makeStrapi({
    config: {
      upload: {
        maxBytes: opts?.maxBytes ?? 1024,
        mimeAllowlist: ['image/png', 'image/jpeg', 'application/pdf'],
        allowSvg: opts?.allowSvg ?? false,
      },
    },
    services: { permissions },
  });
  const uploadSvc = {
    findPage: jest.fn(async () => ({
      results: [{ id: 1, name: 'a.png', hash: 'h', provider: 'local', url: '/uploads/a.png' }],
      pagination: { page: 1, pageSize: 25, total: 1, pageCount: 1 },
    })),
    upload: jest.fn(async () => [{ id: 2, name: 'a.png', url: '/uploads/a.png', hash: 'h' }]),
  };
  // In-memory folder table: { id, name, parent }.
  const folders: Array<{ id: number; name: string; parent: number | null }> = [];
  const folderSvc = {
    create: jest.fn(async ({ name, parent }: { name: string; parent: number | null }) => {
      const f = { id: folders.length + 1, name, parent };
      folders.push(f);
      return f;
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = strapi as any;
  s.db.query = jest.fn(() => ({
    findOne: async ({ where }: { where: { name: string; parent: number | null } }) =>
      folders.find((f) => f.name === where.name && f.parent === where.parent) ?? null,
    count: async ({ where }: { where: { id: number } }) =>
      folders.filter((f) => f.id === where.id).length,
  }));
  const basePlugin = s.plugin;
  s.plugin = jest.fn((name: string) =>
    name === 'upload'
      ? { service: (svc: string) => (svc === 'folder' ? folderSvc : uploadSvc) }
      : basePlugin(name)
  );
  const tools = createMediaTools(strapi);
  const auth = {
    clientId: 'cid',
    principal: { user: { id: 1 }, isSuperAdmin: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scopes: (opts?.scopes ?? ['strapi:media:write', 'strapi:media:read']) as any,
  };
  const call = (name: string, args: unknown) =>
    tools.find((t) => t.name === name)!.handler(args, auth);
  return { call, uploadSvc, pm, folders, folderSvc };
}

const PNG_BASE64 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da636060000000000500011d0a2db40000000049454e44ae426082',
  'hex'
).toString('base64');

const upload = (args: unknown, opts?: Parameters<typeof setup>[0]) =>
  setup(opts).call('strapi_media_upload', args);

describe('media.upload — input schema validation', () => {
  it('rejects invalid filename (path traversal)', async () => {
    await expect(
      upload({ filename: '../../etc/passwd', mime: 'image/png', source: { base64: PNG_BASE64 } })
    ).rejects.toThrow(/invalid filename/);
  });

  it('rejects filename with slashes', async () => {
    await expect(
      upload({ filename: 'subdir/file.png', mime: 'image/png', source: { base64: PNG_BASE64 } })
    ).rejects.toThrow(/invalid filename/);
  });

  it('rejects malformed mime', async () => {
    await expect(
      upload({ filename: 'a.png', mime: 'not-a-mime', source: { base64: PNG_BASE64 } })
    ).rejects.toThrow(/invalid mime/);
  });

  it('rejects when source is neither base64 nor url', async () => {
    await expect(
      upload({ filename: 'a.png', mime: 'image/png', source: { something: 'else' } })
    ).rejects.toBeDefined();
  });
});

describe('media.upload — server-side guards', () => {
  it('rejects MIME not in allowlist', async () => {
    await expect(
      upload({ filename: 'a.gif', mime: 'image/gif', source: { base64: PNG_BASE64 } })
    ).rejects.toThrow(/mime not allowed/);
  });

  it('rejects SVG when allowSvg=false (default)', async () => {
    await expect(
      upload({ filename: 'a.svg', mime: 'image/svg+xml', source: { base64: 'PHN2Zy8+' } })
    ).rejects.toThrow(/SVG uploads disabled|mime not allowed/);
  });

  it('rejects file exceeding maxBytes', async () => {
    await expect(
      upload(
        { filename: 'a.png', mime: 'image/png', source: { base64: PNG_BASE64 } },
        { maxBytes: 4 }
      )
    ).rejects.toThrow(/file too large/);
  });

  it('rejects empty file', async () => {
    await expect(
      upload({ filename: 'a.png', mime: 'image/png', source: { base64: '' } })
    ).rejects.toBeDefined();
  });

  it('rejects when scope is missing', async () => {
    await expect(
      upload(
        { filename: 'a.png', mime: 'image/png', source: { base64: PNG_BASE64 } },
        { scopes: ['strapi:content:read'] }
      )
    ).rejects.toMatchObject({ code: 'insufficient_scope' });
  });

  it('rejects when the role lacks Media Library create permission', async () => {
    await expect(
      upload(
        { filename: 'a.png', mime: 'image/png', source: { base64: PNG_BASE64 } },
        { allowed: false }
      )
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects HTML disguised as a PNG (extension mismatch)', async () => {
    await expect(
      upload({ filename: 'x.html', mime: 'image/png', source: { base64: PNG_BASE64 } })
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects content that does not match the declared type', async () => {
    const html = Buffer.from('<script>alert(1)</script>').toString('base64');
    await expect(
      upload({ filename: 'x.png', mime: 'image/png', source: { base64: html } })
    ).rejects.toThrow(/file content is not image\/png/);
  });

  it('refuses URLs pointing at private addresses', async () => {
    await expect(
      upload({
        filename: 'a.png',
        mime: 'image/png',
        source: { url: 'http://169.254.169.254/latest/meta-data' },
      })
    ).rejects.toThrow(/non-public address/);
    await expect(
      upload({ filename: 'a.png', mime: 'image/png', source: { url: 'http://[::1]:1337/x.png' } })
    ).rejects.toThrow(/non-public address/);
  });

  it('uploads a valid PNG as the calling admin', async () => {
    const { call, uploadSvc } = setup();
    await call('strapi_media_upload', {
      filename: 'a.png',
      mime: 'image/png',
      source: { base64: PNG_BASE64 },
    });
    expect((uploadSvc.upload.mock.calls[0] as unknown[])[1]).toEqual({ user: { id: 1 } });
  });
});

describe('media.list', () => {
  it('rejects when scope is missing', async () => {
    const { call } = setup({ scopes: ['strapi:content:read'] });
    await expect(call('strapi_media_list', {})).rejects.toMatchObject({
      code: 'insufficient_scope',
    });
  });

  it('rejects when the role lacks Media Library read permission', async () => {
    const { call } = setup({ allowed: false });
    await expect(call('strapi_media_list', {})).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('applies permission filters and never returns provider internals', async () => {
    const { call, pm } = setup();
    const out = JSON.parse((await call('strapi_media_list', { mime: 'image/' })).content[0].text);
    expect(pm.addPermissionsQueryTo).toHaveBeenCalled();
    expect(out.results[0]).toEqual({ id: 1, name: 'a.png', url: '/uploads/a.png' });
  });
});

describe('checkFileType / isPublicAddress', () => {
  it('accepts matching extension + magic bytes', () => {
    expect(() =>
      checkFileType('a.png', 'image/png', Buffer.from(PNG_BASE64, 'base64'))
    ).not.toThrow();
  });

  it('blocks executable extensions for unknown types', () => {
    expect(() => checkFileType('a.html', 'video/mp4', Buffer.from('x'))).toThrow(/not allowed/);
    expect(() => checkFileType('a.mp4', 'video/mp4', Buffer.from('x'))).not.toThrow();
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:10.0.0.1',
    '0.0.0.0',
  ])('treats %s as non-public', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('treats %s as public', (ip) =>
    expect(isPublicAddress(ip)).toBe(true)
  );
});

describe('media folders', () => {
  const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

  it('create_folder works like mkdir -p and is idempotent', async () => {
    const { call, folders, folderSvc } = setup();
    const first = parse(await call('strapi_media_create_folder', { path: 'templates/thumbnails' }));
    expect(first).toEqual({
      id: 2,
      path: 'templates/thumbnails',
      created: ['templates', 'templates/thumbnails'],
    });
    expect(folders).toEqual([
      { id: 1, name: 'templates', parent: null },
      { id: 2, name: 'thumbnails', parent: 1 },
    ]);
    const again = parse(
      await call('strapi_media_create_folder', { path: '/templates/ thumbnails/' })
    );
    expect(again).toEqual({ id: 2, path: 'templates/thumbnails', created: [] });
    expect(folderSvc.create).toHaveBeenCalledTimes(2);
  });

  it('create_folder requires Media Library create permission', async () => {
    const { call } = setup({ allowed: false });
    await expect(call('strapi_media_create_folder', { path: 'a' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('upload with folderPath creates the folders and uploads into the leaf', async () => {
    const { call, uploadSvc } = setup();
    await call('strapi_media_upload', {
      filename: 'a.png',
      mime: 'image/png',
      source: { base64: PNG_BASE64 },
      folderPath: 'templates/thumbnails',
    });
    const arg = (uploadSvc.upload.mock.calls[0] as unknown[])[0] as {
      data: { fileInfo: { folder: number } };
    };
    expect(arg.data.fileInfo.folder).toBe(2);
  });

  it('list with folderPath only resolves — a missing folder is not_found, not created', async () => {
    const { call, folderSvc } = setup();
    await expect(call('strapi_media_list', { folderPath: 'nope/deeper' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(folderSvc.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown folderId and folderId + folderPath together', async () => {
    const { call } = setup();
    const base = { filename: 'a.png', mime: 'image/png', source: { base64: PNG_BASE64 } };
    await expect(call('strapi_media_upload', { ...base, folderId: 99 })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      call('strapi_media_upload', { ...base, folderId: 1, folderPath: 'x' })
    ).rejects.toMatchObject({
      code: 'bad_request',
    });
  });
});
