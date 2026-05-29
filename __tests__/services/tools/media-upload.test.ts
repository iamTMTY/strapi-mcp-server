'use strict';

import { createMediaTools } from '../../../server/src/services/tools/media';
import { makeStrapi } from '../../helpers/strapi-mock';
import type { ToolDef } from '../../../server/src/services/tools/content';

function makeUploadTool(opts?: {
  allowSvg?: boolean;
  maxBytes?: number;
  scopes?: string[];
}): ToolDef {
  const strapi = makeStrapi({
    config: {
      upload: {
        maxBytes: opts?.maxBytes ?? 1024,
        mimeAllowlist: ['image/png', 'image/jpeg', 'application/pdf'],
        allowSvg: opts?.allowSvg ?? false,
      },
    },
    services: {},
  });
  const tools = createMediaTools({
    strapi,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    principal: { user: { id: 1 }, permissions: [], isSuperAdmin: false } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scopes: (opts?.scopes ?? ['strapi:media:write', 'strapi:media:read']) as any,
  });
  return tools.find((t) => t.name === 'strapi.media.upload')!;
}

const PNG_BASE64 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da636060000000000500011d0a2db40000000049454e44ae426082',
  'hex'
).toString('base64');

describe('media.upload — input schema validation', () => {
  const tool = makeUploadTool();

  it('rejects invalid filename (path traversal)', async () => {
    await expect(
      tool.handler({
        filename: '../../etc/passwd',
        mime: 'image/png',
        source: { base64: PNG_BASE64 },
      })
    ).rejects.toThrow(/invalid filename/);
  });

  it('rejects filename with slashes', async () => {
    await expect(
      tool.handler({
        filename: 'subdir/file.png',
        mime: 'image/png',
        source: { base64: PNG_BASE64 },
      })
    ).rejects.toThrow(/invalid filename/);
  });

  it('rejects malformed mime', async () => {
    await expect(
      tool.handler({ filename: 'a.png', mime: 'not-a-mime', source: { base64: PNG_BASE64 } })
    ).rejects.toThrow(/invalid mime/);
  });

  it('rejects when source is neither base64 nor url', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool.handler({ filename: 'a.png', mime: 'image/png', source: { something: 'else' } as any })
    ).rejects.toBeDefined();
  });
});

describe('media.upload — server-side guards', () => {
  it('rejects MIME not in allowlist', async () => {
    const tool = makeUploadTool();
    await expect(
      tool.handler({
        filename: 'a.gif',
        mime: 'image/gif', // not in our test allowlist
        source: { base64: PNG_BASE64 },
      })
    ).rejects.toThrow(/mime not allowed/);
  });

  it('rejects SVG when allowSvg=false (default)', async () => {
    const tool = makeUploadTool();
    await expect(
      tool.handler({
        filename: 'a.svg',
        mime: 'image/svg+xml',
        source: { base64: 'PHN2Zy8+' }, // <svg/>
      })
    ).rejects.toThrow(/SVG uploads disabled|mime not allowed/);
  });

  it('rejects file exceeding maxBytes', async () => {
    const tool = makeUploadTool({ maxBytes: 4 });
    await expect(
      tool.handler({
        filename: 'a.png',
        mime: 'image/png',
        source: { base64: PNG_BASE64 }, // decoded is ~70 bytes, > 4
      })
    ).rejects.toThrow(/file too large/);
  });

  it('rejects empty file', async () => {
    const tool = makeUploadTool();
    await expect(
      tool.handler({
        filename: 'a.png',
        mime: 'image/png',
        source: { base64: '' },
      })
    ).rejects.toBeDefined();
  });

  it('rejects when scope is missing', async () => {
    const tool = makeUploadTool({ scopes: ['strapi:content:read'] });
    await expect(
      tool.handler({
        filename: 'a.png',
        mime: 'image/png',
        source: { base64: PNG_BASE64 },
      })
    ).rejects.toMatchObject({ code: 'insufficient_scope' });
  });
});

describe('media.list — scope enforcement', () => {
  it('rejects when scope is missing', async () => {
    const strapi = makeStrapi();
    const tools = createMediaTools({
      strapi,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      principal: { user: { id: 1 }, permissions: [], isSuperAdmin: false } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scopes: ['strapi:content:read'] as any, // missing media:read
    });
    const list = tools.find((t) => t.name === 'strapi.media.list')!;
    await expect(list.handler({ page: 1, pageSize: 10 })).rejects.toMatchObject({ code: 'insufficient_scope' });
  });
});
