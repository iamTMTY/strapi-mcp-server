'use strict';

import { writeFileSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import uploadsFactory, { uploadSizeGuard } from '../../server/src/controllers/uploads';
import { makeStrapi } from '../helpers/strapi-mock';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function tempFile(name: string, content: Buffer): string {
  const p = join(mkdtempSync(join(tmpdir(), 'mcp-ut-')), name);
  writeFileSync(p, content);
  return p;
}

function setup(
  opts: { claim?: unknown; clientScopes?: string[] | null; principal?: unknown } = {}
) {
  const ticketRow = {
    id: 1,
    adminUserId: '1',
    clientId: 'cid',
    folderId: null,
    alternativeText: 'alt',
    caption: null,
  };
  const uploadSvc = {
    upload: jest.fn(async () => [{ id: 9, name: 'a.png', url: '/u/a.png', hash: 'h' }]),
  };
  const pm = { isAllowed: true, sanitizeOutput: async (d: unknown) => d };
  const strapi = makeStrapi({
    services: {
      'upload-tickets': {
        claim: jest.fn(async () => (opts.claim === undefined ? ticketRow : opts.claim)),
      },
      permissions: {
        loadPrincipal: async () =>
          opts.principal === undefined ? { user: { id: 1 } } : opts.principal,
        uploadManager: async () => pm,
      },
      clients: {
        findActive: async () =>
          opts.clientScopes === null
            ? null
            : { scopes: opts.clientScopes ?? ['strapi:media:write'] },
      },
      audit: { record: jest.fn() },
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = strapi as any;
  const base = s.plugin;
  s.plugin = jest.fn((name: string) =>
    name === 'upload' ? { service: () => uploadSvc } : base(name)
  );
  return { controller: uploadsFactory({ strapi }), uploadSvc, strapi };
}

function ctx(files?: Record<string, unknown>) {
  return {
    params: { ticket: 't' },
    state: {} as Record<string, unknown>,
    request: { files, header: {} },
    accepts: () => 'json',
    set: jest.fn(),
    status: 0,
    body: undefined as unknown,
  };
}

describe('uploads.receive', () => {
  it('stores a valid file as the ticket owner with bound metadata, and cleans the temp file', async () => {
    const { controller, uploadSvc } = setup();
    const filepath = tempFile('Your HR Team.png', PNG);
    const c = ctx({
      file: {
        filepath,
        originalFilename: 'Your HR Team.png',
        mimetype: 'application/octet-stream',
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.receive(c as any);
    expect(c.status).toBe(201);
    expect(c.body).toEqual({ id: 9, name: 'a.png', url: '/u/a.png' });
    const [arg, opts] = uploadSvc.upload.mock.calls[0] as unknown as [
      { data: { fileInfo: Record<string, unknown> }; files: { mimetype: string } },
      unknown,
    ];
    expect(arg.files.mimetype).toBe('image/png');
    expect(arg.data.fileInfo.alternativeText).toBe('alt');
    expect(opts).toEqual({ user: { id: 1 } });
    expect(existsSync(filepath)).toBe(false);
  });

  it.each([
    [null, 404],
    ['gone', 410],
  ])('ticket %s → %i', async (claim, status) => {
    const { controller } = setup({ claim });
    const c = ctx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.receive(c as any);
    expect(c.status).toBe(status);
  });

  it('403s when the client lost media:write or was disabled since issue', async () => {
    for (const clientScopes of [['strapi:media:read'], null]) {
      const { controller } = setup({ clientScopes });
      const c = ctx({ file: { filepath: tempFile('a.png', PNG), originalFilename: 'a.png' } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await controller.receive(c as any);
      expect(c.status).toBe(403);
    }
  });

  it('400s on content that does not match the extension', async () => {
    const { controller, uploadSvc } = setup();
    const c = ctx({
      file: {
        filepath: tempFile('evil.png', Buffer.from('<script>')),
        originalFilename: 'evil.png',
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.receive(c as any);
    expect(c.status).toBe(400);
    expect(uploadSvc.upload).not.toHaveBeenCalled();
  });

  it('400s without exactly one file', async () => {
    const { controller } = setup();
    const c = ctx({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.receive(c as any);
    expect(c.status).toBe(400);
  });
});

describe('uploadSizeGuard', () => {
  const run = async (headers: Record<string, string>, path = '/mcp/uploads/t') => {
    const next = jest.fn();
    const c = {
      method: 'POST',
      path,
      get: (h: string) => headers[h] ?? '',
      status: 0,
      body: undefined,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await uploadSizeGuard(makeStrapi())(c as any, next);
    return { status: c.status, next };
  };

  it('413s before parsing when Content-Length exceeds the cap', async () => {
    expect((await run({ 'content-length': String(50 * 1024 * 1024) })).status).toBe(413);
  });

  it('411s without Content-Length', async () => {
    expect((await run({})).status).toBe(411);
  });

  it('passes normal uploads and other routes through', async () => {
    expect((await run({ 'content-length': '1000' })).next).toHaveBeenCalled();
    expect((await run({}, '/api/articles')).next).toHaveBeenCalled();
  });
});
