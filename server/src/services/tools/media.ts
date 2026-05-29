'use strict';

import { z } from 'zod';
import { Buffer } from 'buffer';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'undici';
import type { ToolDef, ToolFactoryArgs } from './content';
import { getConfig } from '../../config';
import { hasScope, type Scope } from '../oauth/scopes';

const MIME_RE = /^[\w.-]+\/[\w.+-]+$/;
const FILENAME_RE = /^[A-Za-z0-9._\- ()]{1,255}$/;
const MAX_BASE64_LEN = 20_000_000; // ~15 MB decoded; matches default 10 MB upload cap with headroom

export function createMediaTools(args: ToolFactoryArgs): ToolDef[] {
  const { strapi, scopes } = args;
  const cfg = getConfig(strapi);

  function requireScope(s: Scope): void {
    if (!hasScope(scopes, s)) {
      const err = new Error('You do not have permission to perform this action.');
      (err as Error & { code?: string }).code = 'insufficient_scope';
      throw err;
    }
  }

  const json = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  });

  return [
    {
      name: 'strapi.media.list',
      description: 'Paginated list of uploaded files.',
      scope: 'strapi:media:read',
      inputSchema: z
        .object({
          page: z.number().int().min(1).max(10000).default(1),
          pageSize: z.number().int().min(1).max(100).default(25),
        })
        .strict(),
      async handler(raw) {
        requireScope('strapi:media:read');
        const schema = this.inputSchema as z.ZodTypeAny;
        const { page, pageSize } = schema.parse(raw) as { page: number; pageSize: number };
        const result = await strapi.db.query('plugin::upload.file').findPage({
          page,
          pageSize,
          orderBy: { id: 'desc' },
        });
        const files = result.results.map((f: Record<string, unknown>) => ({
          id: f.id,
          name: f.name,
          url: f.url,
          mime: f.mime,
          size: f.size,
          hash: f.hash,
          createdAt: f.createdAt,
        }));
        return json({ page, pageSize, count: files.length, total: result.pagination?.total, files });
      },
    },

    {
      name: 'strapi.media.upload',
      description:
        'Upload a single file via base64 or remote URL. Subject to MIME allowlist and size cap.',
      scope: 'strapi:media:write',
      inputSchema: z
        .object({
          filename: z.string().regex(FILENAME_RE, 'invalid filename'),
          mime: z.string().regex(MIME_RE, 'invalid mime'),
          source: z.union([
            z.object({ base64: z.string().min(1).max(MAX_BASE64_LEN) }),
            z.object({ url: z.string().url() }),
          ]),
        })
        .strict(),
      async handler(raw) {
        requireScope('strapi:media:write');
        const schema = this.inputSchema as z.ZodTypeAny;
        const input = schema.parse(raw) as {
          filename: string;
          mime: string;
          source: { base64: string } | { url: string };
        };

        const mime = input.mime.toLowerCase();
        if (!cfg.upload.mimeAllowlist.includes(mime)) {
          throw badRequest(`mime not allowed: ${mime}`);
        }
        if (mime === 'image/svg+xml' && !cfg.upload.allowSvg) {
          throw badRequest('SVG uploads disabled');
        }

        let buf: Buffer;
        if ('base64' in input.source) {
          try {
            buf = Buffer.from(input.source.base64, 'base64');
          } catch {
            throw badRequest('invalid base64');
          }
        } else {
          buf = await fetchBounded(input.source.url, cfg.upload.maxBytes);
        }

        if (buf.byteLength === 0) throw badRequest('empty file');
        if (buf.byteLength > cfg.upload.maxBytes) {
          throw badRequest(`file too large (max ${cfg.upload.maxBytes} bytes)`);
        }

        const dir = await mkdtemp(join(tmpdir(), 'mcp-upload-'));
        const path = join(dir, input.filename);
        try {
          await writeFile(path, buf);
          const uploadSvc = strapi.plugin('upload').service('upload');
          const [file] = (await uploadSvc.upload({
            data: { fileInfo: { name: input.filename } },
            files: {
              filepath: path,
              originalFilename: input.filename,
              mimetype: mime,
              size: buf.byteLength,
            },
          })) as Array<Record<string, unknown>>;
          return json({
            id: file.id,
            name: file.name,
            url: file.url,
            mime: file.mime,
            size: file.size,
          });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    },
  ];
}

function badRequest(message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = 'bad_request';
  return err;
}

async function fetchBounded(url: string, maxBytes: number): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('only http(s) URLs supported');
  }
  const resp = await request(url, {
    method: 'GET',
    maxRedirections: 3,
    headersTimeout: 10_000,
    bodyTimeout: 30_000,
  });
  if (resp.statusCode >= 400) throw badRequest(`remote returned ${resp.statusCode}`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of resp.body) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += b.byteLength;
    if (total > maxBytes) throw badRequest(`remote file exceeds ${maxBytes} bytes`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
