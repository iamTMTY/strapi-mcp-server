'use strict';

import { z } from 'zod';
import { Buffer } from 'buffer';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, extname } from 'path';
import { BlockList, isIP } from 'net';
import { lookup as dnsLookup, type LookupAddress } from 'dns';
import { request as httpRequest, type IncomingMessage } from 'http';
import { request as httpsRequest } from 'https';
import type { Core } from '@strapi/strapi';
import { getConfig } from '../../config';
import {
  forbidden,
  UPLOAD_ACTIONS,
  type UploadPermissionsManager,
  type PrincipalContext,
} from '../permissions';
import { authorizationServerUrl } from '../oauth/audience';
import { defineTool, badRequest, notFound, type ToolAuth, type ToolDef } from './common';

const MIME_RE = /^[\w.-]+\/[\w.+-]+$/;
const FILENAME_RE = /^[A-Za-z0-9._\- ()]{1,255}$/;
const MAX_BASE64_LEN = 20_000_000; // ~15 MB decoded; the configured maxBytes is the real cap
const FOLDER_UID = 'plugin::upload.folder';
const SORTS = [
  'createdAt:DESC',
  'createdAt:ASC',
  'name:ASC',
  'name:DESC',
  'updatedAt:DESC',
  'updatedAt:ASC',
] as const;

// Same allowlist of fields the official Strapi MCP server exposes — never
// provider internals (hash, provider, provider_metadata, formats, folderPath).
const FILE_FIELDS = [
  'id',
  'documentId',
  'name',
  'alternativeText',
  'caption',
  'url',
  'mime',
  'size',
  'width',
  'height',
  'ext',
  'createdAt',
  'updatedAt',
] as const;

type FileRow = Record<string, unknown> & { folder?: { id: number; name: string } | null };

function pickFile(f: FileRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FILE_FIELDS) if (f[k] !== undefined) out[k] = f[k];
  if (f.folder !== undefined)
    out.folder = f.folder ? { id: f.folder.id, name: f.folder.name } : null;
  return out;
}

export function createMediaTools(strapi: Core.Strapi): ToolDef[] {
  const perms = () => strapi.plugin('mcp-server').service('permissions');
  const uploadSvc = () => strapi.plugin('upload').service('upload');

  async function manager(
    auth: ToolAuth,
    action: (typeof UPLOAD_ACTIONS)[keyof typeof UPLOAD_ACTIONS]
  ): Promise<UploadPermissionsManager> {
    const pm: UploadPermissionsManager = await perms().uploadManager(auth.principal, action);
    if (!pm.isAllowed) throw forbidden();
    return pm;
  }

  /**
   * Mirrors the upload plugin's findEntityAndCheckPermissions: conditions like
   * "is creator" need the creator (with roles) on the subject.
   */
  async function loadFileChecked(
    auth: ToolAuth,
    id: number,
    action: (typeof UPLOAD_ACTIONS)[keyof typeof UPLOAD_ACTIONS]
  ): Promise<{ pm: UploadPermissionsManager; file: FileRow }> {
    const pm = await manager(auth, action);
    const file = (await uploadSvc().findOne(id, ['createdBy', 'folder'])) as FileRow | null;
    if (!file) throw notFound('File not found.');
    const creatorId = (file.createdBy as { id?: number } | undefined)?.id;
    const author = creatorId
      ? await strapi.db
          .query('admin::user')
          .findOne({ where: { id: creatorId }, populate: { roles: true } })
      : null;
    if (pm.ability.cannot(pm.action, pm.toSubject({ ...file, createdBy: author })))
      throw forbidden();
    return { pm, file };
  }

  const idSchema = z
    .number()
    .int()
    .positive()
    .describe('Media file id (numeric; file ids and folder ids are separate sequences).');
  const folderRefSchema = z
    .number()
    .int()
    .positive()
    .describe(
      'Folder id (numeric; separate sequence from file ids). See strapi_media_list_folders.'
    );

  function assertFolderName(name: string): void {
    if (!name || name.length > 255) throw badRequest('Folder name must be 1–255 characters.');
    if (name.includes('/')) throw badRequest('Folder name cannot contain "/".');
    if (name.trim() !== name) throw badRequest('Folder name cannot start or end with whitespace.');
  }

  async function loadFolder(
    id: number
  ): Promise<{ id: number; name: string; path: string; parent: { id: number } | null }> {
    const folder = await strapi.db
      .query(FOLDER_UID)
      .findOne({ where: { id }, populate: { parent: true } });
    if (!folder) throw notFound(`Folder ${id} not found. See strapi_media_list_folders.`);
    return folder;
  }

  async function assertNameFree(
    name: string,
    parent: number | null,
    exceptId: number
  ): Promise<void> {
    const clash = await strapi.db
      .query(FOLDER_UID)
      .findOne({ where: { name, parent, id: { $ne: exceptId } }, select: ['id'] });
    if (clash) throw badRequest(`A folder named "${name}" already exists there.`);
  }
  const folderIdSchema = z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('Folder id, or null for the root folder. See strapi_media_list_folders.');
  const folderPathSchema = (creates: boolean) =>
    z
      .string()
      .min(1)
      .max(1000)
      .describe(
        creates
          ? 'Folder path from the root, e.g. "templates/thumbnails" — missing folders are created. Alternative to folderId.'
          : 'Folder path from the root, e.g. "templates/thumbnails". Alternative to folderId.'
      );

  /**
   * Walk a "a/b/c" path from the root, reusing existing folders and (when
   * `create`) creating missing ones like `mkdir -p`. Creating needs the same
   * Media Library permission the admin UI requires (assets.create).
   */
  async function ensureFolderPath(
    auth: ToolAuth,
    path: string,
    create: boolean
  ): Promise<{ id: number; path: string; created: string[] }> {
    const segments = path
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) throw badRequest('folderPath is empty.');
    if (segments.some((s) => s.length > 255))
      throw badRequest('Folder names are limited to 255 characters.');
    let parent: number | null = null;
    const created: string[] = [];
    for (const [i, name] of segments.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const existing = (await strapi.db
        .query(FOLDER_UID)
        .findOne({ where: { name, parent }, select: ['id'] })) as { id: number } | null;
      if (existing) {
        parent = existing.id;
        continue;
      }
      const soFar = segments.slice(0, i + 1).join('/');
      if (!create)
        throw notFound(`Folder "${soFar}" does not exist. See strapi_media_list_folders.`);
      // eslint-disable-next-line no-await-in-loop
      if (created.length === 0) await manager(auth, UPLOAD_ACTIONS.create);
      // eslint-disable-next-line no-await-in-loop
      const folder = (await strapi
        .plugin('upload')
        .service('folder')
        .create({ name, parent }, { user: auth.principal.user })) as { id: number };
      parent = folder.id;
      created.push(soFar);
    }
    return { id: parent as number, path: segments.join('/'), created };
  }

  /** folderId | folderPath → folder id (null = root, undefined = not given), verified to exist. */
  async function resolveFolder(
    auth: ToolAuth,
    input: { folderId?: number | null; folderPath?: string },
    create: boolean
  ): Promise<number | null | undefined> {
    if (input.folderId !== undefined && input.folderPath !== undefined) {
      throw badRequest('Pass folderId or folderPath, not both.');
    }
    if (input.folderPath !== undefined)
      return (await ensureFolderPath(auth, input.folderPath, create)).id;
    if (input.folderId === undefined || input.folderId === null) return input.folderId;
    const exists = await strapi.db.query(FOLDER_UID).count({ where: { id: input.folderId } });
    if (!exists)
      throw notFound(`Folder ${input.folderId} not found. See strapi_media_list_folders.`);
    return input.folderId;
  }

  return [
    defineTool({
      name: 'strapi_media_list',
      title: 'List media files',
      description:
        'Paginated list of Media Library files, optionally filtered by folder, MIME type prefix (e.g. "image/") or name.',
      scope: 'strapi:media:read',
      requires: 'media.read',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z
        .object({
          folderId: folderIdSchema.optional(),
          folderPath: folderPathSchema(false).optional(),
          mime: z
            .string()
            .max(100)
            .optional()
            .describe(
              '"image" (or "image/") matches every image/* type; a full type like "application/pdf" matches exactly.'
            ),
          name: z
            .string()
            .max(255)
            .optional()
            .describe('Case-insensitive substring of the file name.'),
          sort: z.enum(SORTS).default('createdAt:DESC'),
          page: z.number().int().min(1).max(10000).default(1),
          pageSize: z.number().int().min(1).max(100).default(25),
        })
        .strict(),
      async run(input, auth) {
        const pm = await manager(auth, UPLOAD_ACTIONS.read);
        const folderId = await resolveFolder(auth, input, false);
        const and: Array<Record<string, unknown>> = [];
        if (folderId !== undefined) {
          and.push(
            folderId === null ? { folder: { id: { $null: true } } } : { folder: { id: folderId } }
          );
        }
        if (input.mime) {
          // "image" / "image/" → every image/*; "image/png" → exactly that (case-insensitive).
          const m = input.mime.toLowerCase();
          and.push(
            m.includes('/') && !m.endsWith('/')
              ? { mime: { $eqi: m } }
              : { mime: { $startsWith: m.endsWith('/') ? m : `${m}/` } }
          );
        }
        if (input.name) and.push({ name: { $containsi: input.name } });
        const sanitized = await pm.sanitizeQuery({
          filters: and.length ? { $and: and } : undefined,
          sort: input.sort,
          page: input.page,
          pageSize: input.pageSize,
        });
        const query = pm.addPermissionsQueryTo({ ...sanitized, populate: { folder: true } });
        const { results, pagination } = await uploadSvc().findPage(query);
        const files = (await pm.sanitizeOutput(results)) as FileRow[];
        return { results: files.map(pickFile), pagination };
      },
    }),

    defineTool({
      name: 'strapi_media_get',
      title: 'Get media file',
      description: 'Details of one Media Library file by id.',
      scope: 'strapi:media:read',
      requires: 'media.read',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ id: idSchema }).strict(),
      async run({ id }, auth) {
        const { pm, file } = await loadFileChecked(auth, id, UPLOAD_ACTIONS.read);
        return pickFile((await pm.sanitizeOutput(file)) as FileRow);
      },
    }),

    defineTool({
      name: 'strapi_media_list_folders',
      title: 'List media folders',
      description: 'The full Media Library folder tree ({ id, name, children }).',
      scope: 'strapi:media:read',
      requires: 'media.read',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}).strict(),
      async run(_input, auth) {
        await manager(auth, UPLOAD_ACTIONS.read);
        return { folders: await strapi.plugin('upload').service('folder').getStructure() };
      },
    }),

    defineTool({
      name: 'strapi_media_create_folder',
      title: 'Create media folder',
      description:
        'Create a Media Library folder path like "templates/thumbnails" (existing folders are reused, missing ones created, like mkdir -p). Returns the id of the last folder.',
      scope: 'strapi:media:write',
      requires: 'media.create',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({ path: folderPathSchema(true) }).strict(),
      async run({ path }, auth) {
        await manager(auth, UPLOAD_ACTIONS.create);
        return ensureFolderPath(auth, path, true);
      },
    }),

    defineTool({
      name: 'strapi_media_rename_folder',
      title: 'Rename media folder',
      description: 'Rename a Media Library folder. Names must be unique among its siblings.',
      scope: 'strapi:media:write',
      requires: 'media.update',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({ id: folderRefSchema, name: z.string() }).strict(),
      async run({ id, name }, auth) {
        await manager(auth, UPLOAD_ACTIONS.update);
        assertFolderName(name);
        const folder = await loadFolder(id);
        await assertNameFree(name, folder.parent?.id ?? null, id);
        await strapi
          .plugin('upload')
          .service('folder')
          .update(id, { name }, { user: auth.principal.user });
        return { id, name };
      },
    }),

    defineTool({
      name: 'strapi_media_move_folder',
      title: 'Move media folder',
      description:
        'Move a folder (with everything inside it) under another folder, by parentId or parentPath (created if missing); parentId null = the root. A folder cannot move into itself or its descendants.',
      scope: 'strapi:media:write',
      requires: 'media.update',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z
        .object({
          id: folderRefSchema,
          parentId: folderRefSchema.nullable().optional(),
          parentPath: folderPathSchema(true).optional(),
        })
        .strict(),
      async run(input, auth) {
        await manager(auth, UPLOAD_ACTIONS.update);
        const parent = await resolveFolder(
          auth,
          { folderId: input.parentId, folderPath: input.parentPath },
          true
        );
        if (parent === undefined)
          throw badRequest('Pass parentId (null for the root) or parentPath.');
        const folder = await loadFolder(input.id);
        if (parent !== null) {
          const dest = await loadFolder(parent);
          if (dest.path === folder.path || dest.path.startsWith(`${folder.path}/`)) {
            throw badRequest('A folder cannot be moved into itself or one of its descendants.');
          }
        }
        await assertNameFree(folder.name, parent, folder.id);
        await strapi
          .plugin('upload')
          .service('folder')
          .update(folder.id, { name: folder.name, parent }, { user: auth.principal.user });
        return { id: folder.id, name: folder.name, parentId: parent };
      },
    }),

    defineTool({
      name: 'strapi_media_delete_folder',
      title: 'Delete media folders',
      description:
        'Permanently delete folders AND every subfolder and file inside them (from the database and the storage provider, with all thumbnails). No undo, and no check for entries still using the files. Use dryRun: true first. Rejects the whole call if any id is not a folder.',
      scope: 'strapi:media:delete',
      requires: 'media.update',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z
        .object({
          ids: z.array(folderRefSchema).min(1).max(50),
          dryRun: z.boolean().default(false),
        })
        .strict(),
      async run({ ids, dryRun }, auth) {
        await manager(auth, UPLOAD_ACTIONS.update);
        const folders = (await strapi.db
          .query(FOLDER_UID)
          .findMany({ where: { id: { $in: ids } }, select: ['id', 'name', 'path'] })) as Array<{
          id: number;
          name: string;
          path: string;
        }>;
        const missing = ids.filter((id) => !folders.some((f) => f.id === id));
        if (missing.length)
          throw notFound(`Not folders: ${missing.join(', ')}. Nothing was deleted.`);
        const under = (field: string) => ({
          $or: folders.flatMap((f) => [
            { [field]: { $eq: f.path } },
            { [field]: { $startsWith: `${f.path}/` } },
          ]),
        });
        if (dryRun) {
          const [totalFolderNumber, totalFileNumber] = await Promise.all([
            strapi.db.query(FOLDER_UID).count({ where: under('path') }),
            strapi.db.query('plugin::upload.file').count({ where: under('folderPath') }),
          ]);
          return {
            dryRun: true,
            folders: folders.map(({ id, name }) => ({ id, name })),
            totalFolderNumber,
            totalFileNumber,
          };
        }
        const res = (await strapi.plugin('upload').service('folder').deleteByIds(ids)) as {
          totalFolderNumber: number;
          totalFileNumber: number;
        };
        return {
          deleted: folders.map(({ id, name }) => ({ id, name })),
          totalFolderNumber: res.totalFolderNumber,
          totalFileNumber: res.totalFileNumber,
        };
      },
    }),

    defineTool({
      name: 'strapi_media_move',
      title: 'Move media files',
      description:
        'Move files into a folder in bulk, by folderId (null = the root) or folderPath (created if missing).',
      scope: 'strapi:media:write',
      requires: 'media.update',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z
        .object({
          ids: z.array(idSchema).min(1).max(100),
          folderId: folderIdSchema.optional(),
          folderPath: folderPathSchema(true).optional(),
        })
        .strict(),
      async run(input, auth) {
        const folder = await resolveFolder(auth, input, true);
        if (folder === undefined)
          throw badRequest('Pass folderId (null for the root) or folderPath.');
        // Check every file before moving any.
        const checked = [];
        for (const id of input.ids) {
          // eslint-disable-next-line no-await-in-loop
          checked.push(await loadFileChecked(auth, id, UPLOAD_ACTIONS.update));
        }
        for (const { file } of checked) {
          // eslint-disable-next-line no-await-in-loop
          await uploadSvc().updateFileInfo(file.id, { folder }, { user: auth.principal.user });
        }
        return { moved: input.ids, folderId: folder };
      },
    }),

    defineTool({
      name: 'strapi_media_update',
      title: 'Update media file details',
      description:
        'Edit a file’s name, alternative text or caption, or move it to another folder (by folderId, or folderPath — created if missing).',
      scope: 'strapi:media:write',
      requires: 'media.update',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z
        .object({
          id: idSchema,
          name: z.string().min(1).max(255).optional(),
          alternativeText: z.string().max(1000).nullable().optional(),
          caption: z.string().max(1000).nullable().optional(),
          folderId: folderIdSchema.optional(),
          folderPath: folderPathSchema(true).optional(),
        })
        .strict(),
      async run(input, auth) {
        const { id, folderId: _folderId, folderPath, ...info } = input;
        if (Object.keys(info).length === 0 && _folderId === undefined && folderPath === undefined) {
          throw badRequest('Nothing to update.');
        }
        const { pm } = await loadFileChecked(auth, id, UPLOAD_ACTIONS.update);
        const folderId = await resolveFolder(auth, input, true);
        await uploadSvc().updateFileInfo(
          id,
          { ...info, ...(folderId !== undefined ? { folder: folderId } : {}) },
          { user: auth.principal.user }
        );
        // Re-read with the folder so the caller sees where the file now lives.
        const updated = await uploadSvc().findOne(id, ['folder']);
        return pickFile(
          (await pm.sanitizeOutput(updated, { action: UPLOAD_ACTIONS.read })) as FileRow
        );
      },
    }),

    defineTool({
      name: 'strapi_media_delete',
      title: 'Delete media files',
      description:
        'Permanently delete Media Library files. Entries referencing them lose the media. Use dryRun: true to see what would be deleted.',
      scope: 'strapi:media:delete',
      requires: 'media.update',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z
        .object({
          ids: z.array(idSchema).min(1).max(50),
          dryRun: z.boolean().default(false),
        })
        .strict(),
      async run({ ids, dryRun }, auth) {
        // Check every file before deleting any, so a forbidden one aborts the batch.
        const checked = [];
        for (const id of ids) {
          // Strapi's Media Library gates deletion on the "update" action.
          // eslint-disable-next-line no-await-in-loop
          checked.push(await loadFileChecked(auth, id, UPLOAD_ACTIONS.update));
        }
        const files = checked.map(({ file }) => pickFile(file));
        if (dryRun) return { dryRun: true, wouldDelete: files };
        for (const { file } of checked) {
          // eslint-disable-next-line no-await-in-loop
          await uploadSvc().remove(file);
        }
        return { deleted: files };
      },
    }),

    defineTool({
      name: 'strapi_media_upload',
      title: 'Upload media file',
      description:
        'Upload one file from base64 or a public http(s) URL. Base64 only suits small files (< ~50 KB); for local files use strapi_media_request_upload instead. The MIME type must be on the server allowlist, match the file extension and match the file contents.',
      scope: 'strapi:media:write',
      requires: 'media.create',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: z
        .object({
          filename: z.string().regex(FILENAME_RE, 'invalid filename'),
          mime: z.string().regex(MIME_RE, 'invalid mime'),
          source: z.union([
            z.object({ base64: z.string().min(1).max(MAX_BASE64_LEN) }).strict(),
            z.object({ url: z.string().url() }).strict(),
          ]),
          alternativeText: z.string().max(1000).optional(),
          caption: z.string().max(1000).optional(),
          folderId: z.number().int().positive().optional(),
          folderPath: folderPathSchema(true).optional(),
        })
        .strict(),
      async run(input, auth) {
        const cfg = getConfig(strapi);
        const mime = input.mime.toLowerCase();
        assertAllowedMime(strapi, mime);
        // Fail on permissions before spending a remote fetch.
        await manager(auth, UPLOAD_ACTIONS.create);
        const folderId = await resolveFolder(auth, input, true);
        const buf =
          'base64' in input.source
            ? Buffer.from(input.source.base64, 'base64')
            : await fetchBounded(input.source.url, cfg.upload.maxBytes);
        return storeUpload(strapi, auth.principal, {
          filename: input.filename,
          mime,
          buf,
          alternativeText: input.alternativeText,
          caption: input.caption,
          folderId,
        });
      },
    }),

    defineTool({
      name: 'strapi_media_request_upload',
      title: 'Get a one-time upload URL',
      description:
        'Get a single-use URL (valid ~10 min) to upload a LOCAL file without passing its bytes through the conversation. Upload with the returned curl command from a shell, or give the URL to the user to open in a browser. Prefer this over strapi_media_upload for any file on disk larger than ~50 KB.',
      scope: 'strapi:media:write',
      requires: 'media.create',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: z
        .object({
          alternativeText: z.string().max(1000).optional(),
          caption: z.string().max(1000).optional(),
          folderId: z.number().int().positive().optional(),
          folderPath: folderPathSchema(true).optional(),
        })
        .strict(),
      async run(input, auth) {
        // Refuse up front if the role can't upload at all; the upload route re-checks.
        await manager(auth, UPLOAD_ACTIONS.create);
        const cfg = getConfig(strapi);
        const folderId = await resolveFolder(auth, input, true);
        const { ticket, expiresAt } = await strapi
          .plugin('mcp-server')
          .service('upload-tickets')
          .issue({
            adminUserId: String(auth.principal.user.id),
            clientId: auth.clientId,
            alternativeText: input.alternativeText,
            caption: input.caption,
            folderId: folderId ?? undefined,
          });
        const uploadUrl = `${authorizationServerUrl(strapi)}/mcp/uploads/${ticket}`;
        return {
          uploadUrl,
          expiresAt: expiresAt.toISOString(),
          maxBytes: cfg.upload.maxBytes,
          allowedTypes: cfg.upload.mimeAllowlist.filter(
            (m) => m !== 'image/svg+xml' || cfg.upload.allowSvg
          ),
          curl: `curl -sS -F "file=@<path-to-file>" ${uploadUrl}`,
          note: 'Single use: the first upload attempt consumes the URL, even if it fails. Request a new one to retry. The response is the created media file.',
        };
      },
    }),
  ];
}

// --- shared upload pipeline -------------------------------------------------

export function assertAllowedMime(strapi: Core.Strapi, mime: string): void {
  const cfg = getConfig(strapi);
  if (!cfg.upload.mimeAllowlist.includes(mime)) throw badRequest(`mime not allowed: ${mime}`);
  if (mime === 'image/svg+xml' && !cfg.upload.allowSvg) throw badRequest('SVG uploads disabled');
}

/**
 * Every upload path (base64, URL fetch, one-time upload URL) ends here:
 * type/size/content checks, Media Library create permission as `principal`,
 * then Strapi's own upload service → the configured provider.
 */
export async function storeUpload(
  strapi: Core.Strapi,
  principal: PrincipalContext,
  input: {
    filename: string;
    mime: string;
    buf: Buffer;
    alternativeText?: string | null;
    caption?: string | null;
    folderId?: number | null;
  }
): Promise<Record<string, unknown>> {
  const cfg = getConfig(strapi);
  assertAllowedMime(strapi, input.mime);
  if (input.buf.byteLength === 0) throw badRequest('empty file');
  if (input.buf.byteLength > cfg.upload.maxBytes) {
    throw badRequest(`file too large (max ${cfg.upload.maxBytes} bytes)`);
  }
  checkFileType(input.filename, input.mime, input.buf);

  const pm: UploadPermissionsManager = await strapi
    .plugin('mcp-server')
    .service('permissions')
    .uploadManager(principal, UPLOAD_ACTIONS.create);
  if (!pm.isAllowed) throw forbidden();

  const dir = await mkdtemp(join(tmpdir(), 'mcp-upload-'));
  const path = join(dir, input.filename);
  try {
    await writeFile(path, input.buf);
    const [file] = (await strapi
      .plugin('upload')
      .service('upload')
      .upload(
        {
          data: {
            fileInfo: {
              name: input.filename,
              alternativeText: input.alternativeText ?? undefined,
              caption: input.caption ?? undefined,
              folder: input.folderId ?? undefined,
            },
          },
          files: {
            filepath: path,
            originalFilename: input.filename,
            mimetype: input.mime,
            size: input.buf.byteLength,
          },
        },
        { user: principal.user }
      )) as FileRow[];
    return pickFile((await pm.sanitizeOutput(file, { action: UPLOAD_ACTIONS.read })) as FileRow);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Filenames arriving over multipart are user-chosen; keep them to a safe charset. */
export function safeFilename(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._\- ()]/g, '_').slice(-255);
  return FILENAME_RE.test(cleaned) && !/^\.+$/.test(cleaned) ? cleaned : 'upload';
}

/**
 * MIME for a pushed file: from the extension when we know it (curl often
 * sends application/octet-stream), else whatever the client declared.
 * checkFileType then verifies the bytes either way.
 */
export function mimeForUpload(filename: string, declared: string | undefined): string {
  const ext = extname(filename).toLowerCase();
  const known = Object.entries(KNOWN_TYPES).find(([, t]) => t.exts.includes(ext));
  return known ? known[0] : (declared ?? 'application/octet-stream').toLowerCase();
}

// --- file-type checks -------------------------------------------------------

const KNOWN_TYPES: Record<string, { exts: string[]; magic?: (b: Buffer) => boolean }> = {
  'image/png': {
    exts: ['.png'],
    magic: (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  },
  'image/jpeg': {
    exts: ['.jpg', '.jpeg'],
    magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  'image/gif': { exts: ['.gif'], magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  'image/webp': {
    exts: ['.webp'],
    magic: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  'application/pdf': {
    exts: ['.pdf'],
    magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  },
  'image/svg+xml': { exts: ['.svg'] },
};

// Extensions a browser may execute when served from the Strapi origin.
const ACTIVE_EXTS = new Set([
  '.html',
  '.htm',
  '.xhtml',
  '.shtml',
  '.svg',
  '.xml',
  '.js',
  '.mjs',
  '.php',
  '.hta',
]);

/**
 * The declared MIME alone is attacker-controlled: "x.html" declared as
 * image/png would be served as HTML by the local provider (stored XSS).
 */
export function checkFileType(filename: string, mime: string, buf: Buffer): void {
  const ext = extname(filename).toLowerCase();
  const known = KNOWN_TYPES[mime];
  if (known) {
    if (!known.exts.includes(ext)) {
      throw badRequest(`filename extension must be ${known.exts.join(' or ')} for ${mime}`);
    }
    if (known.magic && !known.magic(buf)) throw badRequest(`file content is not ${mime}`);
    return;
  }
  if (ACTIVE_EXTS.has(ext)) throw badRequest(`extension ${ext} is not allowed`);
}

// --- SSRF-safe fetch --------------------------------------------------------

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True for globally routable addresses only (loopback, private, link-local, metadata → false). */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return !blocked.check(mapped[1], 'ipv4');
  const family = isIP(address);
  if (family === 0) return false;
  return !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Resolve-then-check inside the socket's own lookup, so the address that is
 * checked is the address connected to (no DNS-rebinding window).
 */
function safeLookup(
  hostname: string,
  options: object,
  cb: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number
  ) => void
): void {
  dnsLookup(hostname, options as never, (err, address, family) => {
    if (err) return cb(err, address as string, family);
    const list: LookupAddress[] = Array.isArray(address)
      ? address
      : [{ address: address as string, family: family as number }];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad) return cb(badRequest(`refusing to fetch non-public address ${bad.address}`), '', 0);
    cb(null, address, family);
  });
}

function get(url: URL): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        lookup: safeLookup as never,
        timeout: 10_000,
        headers: { 'user-agent': 'strapi-mcp-server' },
      },
      resolve
    );
    req.on('timeout', () => req.destroy(badRequest('remote request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchBounded(rawUrl: string, maxBytes: number): Promise<Buffer> {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= 3; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw badRequest('only http(s) URLs supported');
    // Literal IPs skip DNS, so the lookup hook never sees them — check here.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !isPublicAddress(host))
      throw badRequest(`refusing to fetch non-public address ${host}`);

    // eslint-disable-next-line no-await-in-loop
    const res = await get(url);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, url);
      continue;
    }
    if (status >= 400) {
      res.resume();
      throw badRequest(`remote returned ${status}`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    // eslint-disable-next-line no-await-in-loop
    for await (const chunk of res) {
      total += (chunk as Buffer).byteLength;
      if (total > maxBytes) {
        res.destroy();
        throw badRequest(`remote file exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }
  throw badRequest('too many redirects');
}
