'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { readFile, rm } from 'fs/promises';
import { storeUpload, safeFilename, mimeForUpload } from '../services/tools/media';
import { isProviderError } from '../services/tools/common';
import type { UploadTicketRow } from '../services/upload-tickets';
import { getConfig } from '../config';

export const UPLOAD_PATH_PREFIX = '/mcp/uploads/';

interface MultipartFile {
  filepath: string;
  originalFilename?: string | null;
  mimetype?: string | null;
}

/** Refuse missing or oversized Content-Length on upload POSTs before the body is parsed. */
export function uploadSizeGuard(strapi: Core.Strapi) {
  return async (ctx: Context, next: () => Promise<unknown>): Promise<void> => {
    if (ctx.method === 'POST' && ctx.path.startsWith(UPLOAD_PATH_PREFIX)) {
      const { maxBytes } = getConfig(strapi).upload;
      const length = Number(ctx.get('content-length'));
      if (!Number.isFinite(length) || length <= 0) {
        ctx.status = 411;
        ctx.body = { error: 'length_required' };
        return;
      }
      // Headroom for multipart boundaries and headers on top of the file cap.
      if (length > maxBytes + 64 * 1024) {
        ctx.status = 413;
        ctx.body = { error: 'payload_too_large', maxBytes };
        return;
      }
    }
    await next();
  };
}

const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function htmlEscape(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

function page(ctx: Context, status: number, title: string, bodyHtml: string): void {
  ctx.status = status;
  ctx.type = 'text/html';
  ctx.set('Content-Security-Policy', PAGE_CSP);
  ctx.set('Cache-Control', 'no-store');
  ctx.set('Referrer-Policy', 'no-referrer');
  ctx.body = `<!doctype html><html><head><meta charset="utf-8" /><title>${htmlEscape(title)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:540px;margin:60px auto;color:#1f1f1f;padding:0 16px}
h1{font-size:20px}button{padding:10px 18px;font-size:14px;border-radius:4px;border:0;background:#4945ff;color:#fff;cursor:pointer}
.muted{color:#666;font-size:13px}</style></head><body>${bodyHtml}</body></html>`;
}

/** Browsers get pages; curl and agents get JSON. */
function reply(ctx: Context, status: number, body: Record<string, unknown>, message: string): void {
  if (ctx.accepts('json', 'html') === 'html') {
    page(
      ctx,
      status,
      message,
      `<h1>${htmlEscape(message)}</h1><p class="muted">You can close this tab.</p>`
    );
    return;
  }
  ctx.status = status;
  ctx.set('Cache-Control', 'no-store');
  ctx.body = body;
}

/**
 * One-time upload URLs (see services/upload-tickets). The ticket in the path
 * is the credential; everything after the claim runs as the admin + client
 * that requested it, re-checked now rather than trusted from issue time.
 */
export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async form(ctx: Context): Promise<void> {
    const row = await strapi
      .plugin('mcp-server')
      .service('upload-tickets')
      .peek(String(ctx.params.ticket));
    if (!row) return page(ctx, 404, 'Upload link not found', '<h1>Upload link not found</h1>');
    if (row === 'gone') {
      return page(
        ctx,
        410,
        'Upload link expired',
        '<h1>This upload link was already used or has expired.</h1><p class="muted">Ask your AI assistant for a new one.</p>'
      );
    }
    page(
      ctx,
      200,
      'Upload a file',
      `<h1>Upload a file to Strapi</h1>
<p class="muted">Single use. Expires ${htmlEscape(new Date(row.expiresAt).toISOString())}.</p>
<form method="POST" enctype="multipart/form-data">
  <p><input type="file" name="file" required /></p>
  <button type="submit">Upload</button>
</form>`
    );
  },

  async receive(ctx: Context): Promise<void> {
    const plugin = strapi.plugin('mcp-server');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const files = (ctx.request as any).files as
      | Record<string, MultipartFile | MultipartFile[]>
      | undefined;
    const uploaded = [files?.file ?? []].flat();

    try {
      const claimed = (await plugin.service('upload-tickets').claim(String(ctx.params.ticket))) as
        | UploadTicketRow
        | 'gone'
        | null;
      if (!claimed) return reply(ctx, 404, { error: 'not_found' }, 'Upload link not found');
      if (claimed === 'gone') {
        return reply(
          ctx,
          410,
          { error: 'gone', message: 'Upload URL already used or expired; request a new one.' },
          'This upload link was already used or has expired.'
        );
      }

      const audit = (
        resultStatus: 'ok' | 'error',
        params: Record<string, unknown>,
        errorCode?: string
      ) =>
        plugin.service('audit').record({
          ts: new Date(),
          principalType: 'admin',
          principalId: claimed.adminUserId,
          clientId: claimed.clientId,
          tool: 'strapi_media_request_upload.receive',
          params,
          resultStatus,
          errorCode,
          ip: ctx.ip ?? ctx.request.ip,
          userAgent: ctx.request.header['user-agent'] as string | undefined,
        });

      // Re-check everything as of now: the admin, the client and its scope.
      const principal = await plugin.service('permissions').loadPrincipal(claimed.adminUserId);
      const client = await plugin.service('clients').findActive(claimed.clientId);
      if (!principal || !client || !client.scopes.includes('strapi:media:write')) {
        audit('error', {}, 'forbidden');
        return reply(ctx, 403, { error: 'forbidden' }, 'Upload not permitted');
      }

      if (uploaded.length !== 1) {
        audit('error', { files: uploaded.length }, 'bad_request');
        return reply(
          ctx,
          400,
          { error: 'bad_request', message: 'Send exactly one file in the "file" field.' },
          'Send exactly one file.'
        );
      }
      // Attribute the upload to the admin in Strapi's own request-scoped features.
      ctx.state.user = principal.user;
      const file = uploaded[0];
      const filename = safeFilename(file.originalFilename ?? undefined);
      const mime = mimeForUpload(filename, file.mimetype ?? undefined);
      try {
        const result = await storeUpload(strapi, principal, {
          filename,
          mime,
          buf: await readFile(file.filepath),
          alternativeText: claimed.alternativeText,
          caption: claimed.caption,
          folderId: claimed.folderId,
        });
        audit('ok', { filename, mime, size: result.size });
        return reply(ctx, 201, result, `Uploaded ${filename}`);
      } catch (err) {
        const code = (err as { code?: string }).code;
        audit('error', { filename, mime }, code ?? 'internal_error');
        if (code === 'bad_request' || code === 'forbidden') {
          return reply(
            ctx,
            code === 'forbidden' ? 403 : 400,
            { error: code, message: (err as Error).message },
            (err as Error).message
          );
        }
        strapi.log.error('[mcp-server] one-time upload failed', err as Error);
        if (isProviderError(err)) {
          const message = `The configured upload provider rejected the file: ${(err as Error).message}`;
          return reply(ctx, 502, { error: 'upload_provider_error', message }, message);
        }
        return reply(ctx, 500, { error: 'internal_error' }, 'Upload failed');
      }
    } finally {
      // The body parser leaves temp files behind; the bytes are stored by now.
      await Promise.all(
        uploaded.map((f) => rm(f.filepath, { force: true }).catch(() => undefined))
      );
    }
  },
});
