'use strict';

import { request } from 'undici';
import { TEST_BASE_URL } from '../helpers/test-server';
import { mintMcpToken } from '../helpers/mcp-token';
import { ensureRoleUser, setRoleLocales } from '../helpers/admin-api';

const ALL = [
  'strapi:content:read',
  'strapi:content:write',
  'strapi:content:publish',
  'strapi:content:delete',
  'strapi:media:read',
  'strapi:media:write',
  'strapi:media:delete',
];
const ARTICLE = 'api::article.article';

/** Minimal MCP client over Streamable HTTP (SSE responses). */
class Client {
  sessionId?: string;
  constructor(private token: string) {}

  async rpc(
    method: string,
    params: unknown
  ): Promise<{ status: number; result?: any; error?: any }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      origin: TEST_BASE_URL,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const resp = await request(`${TEST_BASE_URL}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    const sid = resp.headers['mcp-session-id'];
    if (typeof sid === 'string') this.sessionId = sid;
    const text = await resp.body.text();
    // Stateless transport answers with plain JSON; tolerate SSE framing too.
    const data = text.trimStart().startsWith('{')
      ? JSON.parse(text)
      : text
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => JSON.parse(l.slice(6)))
          .pop();
    return { status: resp.statusCode, result: data?.result, error: data?.error };
  }

  async init(): Promise<void> {
    const r = await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0.0' },
    });
    if (r.status !== 200) throw new Error(`initialize failed: ${r.status}`);
  }

  /** Returns parsed tool payload; `isError` results come back as { isError, error, message }. */
  async tool(name: string, args: unknown): Promise<any> {
    const r = await this.rpc('tools/call', { name, arguments: args });
    if (r.error)
      return {
        isError: true,
        error: 'rpc_error',
        message: r.error.message ?? JSON.stringify(r.error),
        status: r.status,
      };
    const payload = JSON.parse(r.result.content[0].text);
    return r.result.isError ? { isError: true, ...payload } : payload;
  }
}

let admin: Client;
let author: Client;

beforeAll(async () => {
  admin = new Client((await mintMcpToken({ scopes: ALL })).accessToken);
  await admin.init();
  const authorUser = await ensureRoleUser('strapi-author');
  // `category` is localized; give Author the one fixture locale.
  await setRoleLocales('strapi-author', 'api::category.category', ['en']);
  author = new Client((await mintMcpToken({ scopes: ALL, as: authorUser })).accessToken);
  await author.init();
});

describe('tool listing', () => {
  it('lists the new tool names with annotations', async () => {
    const r = await admin.rpc('tools/list', {});
    const tools = r.result.tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
    const names = tools.map((t) => t.name);
    for (const n of [
      'strapi_content_list_types',
      'strapi_content_publish_entry',
      'strapi_content_delete_entry',
      'strapi_media_list_folders',
      'strapi_media_delete',
    ]) {
      expect(names).toContain(n);
    }
    expect(
      tools.find((t) => t.name === 'strapi_content_delete_entry')!.annotations!.destructiveHint
    ).toBe(true);
    expect(
      tools.find((t) => t.name === 'strapi_content_list_types')!.annotations!.readOnlyHint
    ).toBe(true);
  });
});

describe('resources', () => {
  it('lists content-type schemas as resources and reads one', async () => {
    const list = await admin.rpc('resources/templates/list', {});
    expect(list.result.resourceTemplates[0].uriTemplate).toBe(
      'strapi://content-types/{uid}/schema'
    );
    const listed = await admin.rpc('resources/list', {});
    const uris = listed.result.resources.map((r: { uri: string }) => r.uri);
    const uri = `strapi://content-types/${encodeURIComponent(ARTICLE)}/schema`;
    expect(uris).toContain(uri);
    const read = await admin.rpc('resources/read', { uri });
    const schema = JSON.parse(read.result.contents[0].text);
    expect(schema.uid).toBe(ARTICLE);
    expect(schema.attributes.title).toBeDefined();
  });

  it('tool results carry structuredContent', async () => {
    const r = await admin.rpc('tools/call', { name: 'strapi_content_list_types', arguments: {} });
    expect(r.result.structuredContent.contentTypes.length).toBeGreaterThan(0);
  });
});

describe('content lifecycle (super admin)', () => {
  let id: string;

  it('creates, reads, filters and counts', async () => {
    const created = await admin.tool('strapi_content_create_entry', {
      uid: ARTICLE,
      data: { title: 'MCP lifecycle', body: 'v1' },
    });
    expect(created.isError).toBeUndefined();
    id = created.documentId;

    const got = await admin.tool('strapi_content_get_entry', { uid: ARTICLE, documentId: id });
    expect(got.title).toBe('MCP lifecycle');

    const list = await admin.tool('strapi_content_list_entries', {
      uid: ARTICLE,
      filters: { title: { $eq: 'MCP lifecycle' } },
      sort: 'title:asc',
    });
    expect(list.pagination.total).toBe(1);
  });

  it('publishes, unpublishes, discards drafts and deletes', async () => {
    const pub = await admin.tool('strapi_content_publish_entry', { uid: ARTICLE, documentId: id });
    expect(pub.publishedAt).toBeTruthy();

    await admin.tool('strapi_content_update_entry', {
      uid: ARTICLE,
      documentId: id,
      data: { body: 'v2' },
    });
    const discarded = await admin.tool('strapi_content_discard_draft', {
      uid: ARTICLE,
      documentId: id,
    });
    expect(discarded.body).toBe('v1');

    const unpub = await admin.tool('strapi_content_unpublish_entry', {
      uid: ARTICLE,
      documentId: id,
    });
    expect(unpub.unpublished).toBe(true);

    const del = await admin.tool('strapi_content_delete_entry', { uid: ARTICLE, documentId: id });
    expect(del.deleted).toBe(true);
    const gone = await admin.tool('strapi_content_get_entry', { uid: ARTICLE, documentId: id });
    expect(gone).toMatchObject({ isError: true, error: 'not_found' });
  });
});

describe('data exposure', () => {
  it('never returns admin password hashes through populate', async () => {
    const created = await admin.tool('strapi_content_create_entry', {
      uid: ARTICLE,
      data: { title: 'populate' },
    });
    const got = await admin.tool('strapi_content_get_entry', {
      uid: ARTICLE,
      documentId: created.documentId,
      populate: ['createdBy'],
    });
    expect(JSON.stringify(got)).not.toMatch(/password|resetPasswordToken|\$2[aby]\$/);
  });

  it('does not allow filtering on admin password hashes', async () => {
    const all = await admin.tool('strapi_content_list_entries', { uid: ARTICLE });
    const probe = await admin.tool('strapi_content_list_entries', {
      uid: ARTICLE,
      filters: { createdBy: { password: { $startsWith: 'NOT-A-HASH-PREFIX' } } },
    });
    // Either rejected outright, or the filter is stripped (same total as
    // unfiltered) — never evaluated against the hash.
    if (!probe.isError) expect(probe.pagination.total).toBe(all.pagination.total);
    else expect(probe.error).toBe('bad_request');
  });
});

describe('RBAC conditions (Author role = own entries only)', () => {
  let adminDocId: string;

  beforeAll(async () => {
    adminDocId = (
      await admin.tool('strapi_content_create_entry', {
        uid: ARTICLE,
        data: { title: 'admin-owned' },
      })
    ).documentId;
  });

  it('author can create and read their own entry', async () => {
    const mine = await author.tool('strapi_content_create_entry', {
      uid: ARTICLE,
      data: { title: 'author-owned' },
    });
    expect(mine.isError).toBeUndefined();
    const got = await author.tool('strapi_content_get_entry', {
      uid: ARTICLE,
      documentId: mine.documentId,
    });
    expect(got.title).toBe('author-owned');
  });

  it("author cannot read or update the admin's entry", async () => {
    const read = await author.tool('strapi_content_get_entry', {
      uid: ARTICLE,
      documentId: adminDocId,
    });
    expect(read.isError).toBe(true);
    const upd = await author.tool('strapi_content_update_entry', {
      uid: ARTICLE,
      documentId: adminDocId,
      data: { title: 'hijacked' },
    });
    expect(upd).toMatchObject({ isError: true, error: 'forbidden' });
    const still = await admin.tool('strapi_content_get_entry', {
      uid: ARTICLE,
      documentId: adminDocId,
    });
    expect(still.title).toBe('admin-owned');
  });

  it("author's list only contains their own entries", async () => {
    const list = await author.tool('strapi_content_list_entries', { uid: ARTICLE, pageSize: 100 });
    expect(list.results.map((r: { title: string }) => r.title)).not.toContain('admin-owned');
  });

  it("populating a relation never reveals a related entry the author can't read", async () => {
    const adminCat = await admin.tool('strapi_content_create_entry', {
      uid: 'api::category.category',
      data: { name: 'admin-cat', internalNotes: 'secret-notes' },
    });
    const ownCat = await author.tool('strapi_content_create_entry', {
      uid: 'api::category.category',
      data: { name: 'author-cat', internalNotes: 'mine' },
    });
    const linkedToAdmin = await author.tool('strapi_content_create_entry', {
      uid: ARTICLE,
      data: { title: 'links admin cat', category: adminCat.documentId },
    });
    const linkedToOwn = await author.tool('strapi_content_create_entry', {
      uid: ARTICLE,
      data: { title: 'links own cat', category: ownCat.documentId },
    });

    const leaky = await author.tool('strapi_content_get_entry', {
      uid: ARTICLE,
      documentId: linkedToAdmin.documentId,
      populate: ['category'],
    });
    expect(leaky.category).toEqual({ documentId: adminCat.documentId });

    const listed = await author.tool('strapi_content_list_entries', {
      uid: ARTICLE,
      populate: '*',
      pageSize: 100,
    });
    expect(JSON.stringify(listed)).not.toContain('secret-notes');

    const fine = await author.tool('strapi_content_get_entry', {
      uid: ARTICLE,
      documentId: linkedToOwn.documentId,
      populate: ['category'],
    });
    expect(fine.category).toMatchObject({ documentId: ownCat.documentId, name: 'author-cat' });
  });

  it('author can create in a localized type (creator-aware locale check) and sees per-action locales', async () => {
    const types = await author.tool('strapi_content_list_types', {});
    const cat = types.contentTypes.find((t: { uid: string }) => t.uid === 'api::category.category');
    expect(cat.localized).toBe(true);
    expect(cat.defaultLocale).toBe('en');
    expect(cat.locales.create).toContain('en');
    const created = await author.tool('strapi_content_create_entry', {
      uid: 'api::category.category',
      locale: 'en',
      data: { name: 'localized by author' },
    });
    expect(created).toMatchObject({ name: 'localized by author', locale: 'en' });
    const schema = await author.tool('strapi_content_get_schema', {
      uid: 'api::category.category',
    });
    expect(schema.writableFields.create).toEqual(expect.arrayContaining(['name', 'internalNotes']));
  });

  it('nested populate through a dynamic zone, with relation checks inside it', async () => {
    const adminCat = await admin.tool('strapi_content_create_entry', {
      uid: 'api::category.category',
      data: { name: 'dz-admin-cat', internalNotes: 'dz-secret' },
    });
    const art = await author.tool('strapi_content_create_entry', {
      uid: ARTICLE,
      data: {
        title: 'with blocks',
        blocks: [
          { __component: 'blocks.cta', label: 'Go', category: adminCat.documentId },
          { __component: 'blocks.quote', text: 'hello' },
        ],
      },
    });
    const asAdmin = await admin.tool('strapi_content_get_entry', {
      uid: ARTICLE,
      documentId: art.documentId,
      populate: ['blocks.category'],
    });
    expect(asAdmin.blocks[0]).toMatchObject({
      __component: 'blocks.cta',
      label: 'Go',
      category: { name: 'dz-admin-cat' },
    });
    expect(asAdmin.blocks[1]).toMatchObject({ __component: 'blocks.quote', text: 'hello' });

    const asAuthor = await author.tool('strapi_content_get_entry', {
      uid: ARTICLE,
      documentId: art.documentId,
      populate: ['blocks.category'],
    });
    expect(asAuthor.blocks[0].category).toEqual({ documentId: adminCat.documentId });
    expect(JSON.stringify(asAuthor)).not.toContain('dz-secret');

    const schema = await author.tool('strapi_content_get_schema', { uid: ARTICLE });
    expect(Object.keys(schema.components).sort()).toEqual(['blocks.cta', 'blocks.quote']);
    expect(schema.dynamicZoneFormat).toContain('__component');
  });

  it('author cannot delete (no delete permission by default)', async () => {
    const del = await author.tool('strapi_content_delete_entry', {
      uid: ARTICLE,
      documentId: adminDocId,
    });
    expect(del.isError).toBe(true);
  });
});

describe('media', () => {
  // Canonical valid 1x1 PNG (Strapi's image pipeline rejects malformed ones).
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  it('uploads, lists, gets, updates, dry-runs and deletes', async () => {
    const up = await admin.tool('strapi_media_upload', {
      filename: 'pixel.png',
      mime: 'image/png',
      source: { base64: PNG },
      alternativeText: 'a pixel',
    });
    expect(up.isError).toBeUndefined();
    expect(up.hash).toBeUndefined();

    const list = await admin.tool('strapi_media_list', { mime: 'image/', name: 'pixel' });
    expect(list.results.some((f: { id: number }) => f.id === up.id)).toBe(true);

    const upd = await admin.tool('strapi_media_update', { id: up.id, caption: 'cap' });
    expect(upd.caption).toBe('cap');

    const folders = await admin.tool('strapi_media_list_folders', {});
    expect(Array.isArray(folders.folders)).toBe(true);

    const dry = await admin.tool('strapi_media_delete', { ids: [up.id], dryRun: true });
    expect(dry.wouldDelete[0].id).toBe(up.id);
    expect((await admin.tool('strapi_media_get', { id: up.id })).id).toBe(up.id);

    await admin.tool('strapi_media_delete', { ids: [up.id] });
    expect(await admin.tool('strapi_media_get', { id: up.id })).toMatchObject({
      isError: true,
      error: 'not_found',
    });
  });

  it('one-time upload URL: multipart push stores the file once, then is gone', async () => {
    const req = await admin.tool('strapi_media_request_upload', {
      alternativeText: 'pushed pixel',
    });
    expect(req.uploadUrl).toMatch(/\/mcp\/uploads\/[A-Za-z0-9_-]{43}$/);
    // Tests hit 127.0.0.1; the URL is built from resourceUrl's origin.
    const url = `${TEST_BASE_URL}${new URL(req.uploadUrl).pathname}`;

    const push = (name: string, bytes: Buffer) => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name);
      return request(url, { method: 'POST', body: form });
    };

    const form = await request(url, { method: 'GET' });
    expect(form.statusCode).toBe(200);
    expect(await form.body.text()).toContain('enctype="multipart/form-data"');

    const first = await push('Your HR Team.png', Buffer.from(PNG, 'base64'));
    expect(first.statusCode).toBe(201);
    const file = (await first.body.json()) as {
      id: number;
      alternativeText: string;
      hash?: string;
    };
    expect(file.alternativeText).toBe('pushed pixel');
    expect(file.hash).toBeUndefined();
    expect((await admin.tool('strapi_media_get', { id: file.id })).id).toBe(file.id);

    const again = await push('again.png', Buffer.from(PNG, 'base64'));
    expect(again.statusCode).toBe(410);
    await again.body.text();

    const req2 = await admin.tool('strapi_media_request_upload', {});
    const bad = await request(`${TEST_BASE_URL}${new URL(req2.uploadUrl).pathname}`, {
      method: 'POST',
      body: (() => {
        const f = new FormData();
        f.append('file', new Blob([Buffer.from('<html><script>x</script>')]), 'evil.png');
        return f;
      })(),
    });
    expect(bad.statusCode).toBe(400);
    await bad.body.text();

    await admin.tool('strapi_media_delete', { ids: [file.id] });
  });

  it('folders: mkdir -p, idempotent, and uploads land in the folder by path', async () => {
    const made = await admin.tool('strapi_media_create_folder', { path: 'templates/thumbnails' });
    expect(made.created).toEqual(['templates', 'templates/thumbnails']);
    const again = await admin.tool('strapi_media_create_folder', { path: 'templates/thumbnails' });
    expect(again).toMatchObject({ id: made.id, created: [] });

    const req = await admin.tool('strapi_media_request_upload', {
      folderPath: 'templates/thumbnails',
    });
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(PNG, 'base64')]), 'thumb.png');
    const res = await request(`${TEST_BASE_URL}${new URL(req.uploadUrl).pathname}`, {
      method: 'POST',
      body: form,
    });
    expect(res.statusCode).toBe(201);
    const file = (await res.body.json()) as { id: number };

    const got = await admin.tool('strapi_media_get', { id: file.id });
    expect(got.folder).toEqual({ id: made.id, name: 'thumbnails' });
    const listed = await admin.tool('strapi_media_list', { folderPath: 'templates/thumbnails' });
    expect(listed.results.map((f: { id: number }) => f.id)).toEqual([file.id]);
    expect(
      await admin.tool('strapi_media_list', { folderPath: 'templates/missing' })
    ).toMatchObject({
      isError: true,
      error: 'not_found',
    });

    // Move it back to the root with update, then clean up.
    const moved = await admin.tool('strapi_media_update', { id: file.id, folderId: null });
    expect(moved.folder).toBeNull();
    await admin.tool('strapi_media_delete', { ids: [file.id] });
  });

  it('folders: rename, move (cycle-safe), bulk-move files, dry-run then cascade delete', async () => {
    const a = await admin.tool('strapi_media_create_folder', { path: 'ops/a' });
    const b = await admin.tool('strapi_media_create_folder', { path: 'ops/b' });
    const up = await admin.tool('strapi_media_upload', {
      filename: 'ops.png',
      mime: 'image/png',
      source: { base64: PNG },
    });

    expect(await admin.tool('strapi_media_rename_folder', { id: a.id, name: 'b' })).toMatchObject({
      isError: true,
      error: 'bad_request',
    });
    expect(await admin.tool('strapi_media_rename_folder', { id: a.id, name: 'alpha' })).toEqual({
      id: a.id,
      name: 'alpha',
    });

    const ops = await admin.tool('strapi_media_create_folder', { path: 'ops' });
    expect(
      await admin.tool('strapi_media_move_folder', { id: ops.id, parentId: a.id })
    ).toMatchObject({
      isError: true,
      error: 'bad_request',
    });
    await admin.tool('strapi_media_move_folder', { id: b.id, parentPath: 'ops/alpha' });

    await admin.tool('strapi_media_move', { ids: [up.id], folderPath: 'ops/alpha/b' });
    expect((await admin.tool('strapi_media_get', { id: up.id })).folder).toEqual({
      id: b.id,
      name: 'b',
    });
    expect(
      (await admin.tool('strapi_media_list', { mime: 'image/png', folderId: b.id })).results
    ).toHaveLength(1);
    expect(
      (await admin.tool('strapi_media_list', { mime: 'image/jpeg', folderId: b.id })).results
    ).toHaveLength(0);

    const dry = await admin.tool('strapi_media_delete_folder', { ids: [ops.id], dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, totalFolderNumber: 3, totalFileNumber: 1 });
    expect((await admin.tool('strapi_media_get', { id: up.id })).id).toBe(up.id);
    expect(await admin.tool('strapi_media_delete_folder', { ids: [ops.id, 999999] })).toMatchObject(
      {
        isError: true,
        error: 'not_found',
      }
    );

    const del = await admin.tool('strapi_media_delete_folder', { ids: [ops.id] });
    expect(del).toMatchObject({ totalFolderNumber: 3, totalFileNumber: 1 });
    expect(await admin.tool('strapi_media_get', { id: up.id })).toMatchObject({
      isError: true,
      error: 'not_found',
    });
  });

  it('folder cascade delete refuses when the folder holds files the role may not manage', async () => {
    const shared = await admin.tool('strapi_media_create_folder', { path: 'shared-cascade' });
    const adminFile = await admin.tool('strapi_media_upload', {
      filename: 'admins.png',
      mime: 'image/png',
      source: { base64: PNG },
      folderId: shared.id,
    });
    // Author: Media Library update/delete is "own files only".
    for (const dryRun of [true, false]) {
      expect(
        await author.tool('strapi_media_delete_folder', { ids: [shared.id], dryRun })
      ).toMatchObject({
        isError: true,
        error: 'forbidden',
      });
    }
    expect((await admin.tool('strapi_media_get', { id: adminFile.id })).id).toBe(adminFile.id);

    // A folder holding only the author's own file can be deleted by the author.
    const own = await author.tool('strapi_media_create_folder', { path: 'author-cascade' });
    await author.tool('strapi_media_upload', {
      filename: 'mine.png',
      mime: 'image/png',
      source: { base64: PNG },
      folderId: own.id,
    });
    expect(await author.tool('strapi_media_delete_folder', { ids: [own.id] })).toMatchObject({
      totalFolderNumber: 1,
      totalFileNumber: 1,
    });

    await admin.tool('strapi_media_delete_folder', { ids: [shared.id] });
  });

  it('refuses to fetch URLs on private addresses (SSRF)', async () => {
    const r = await admin.tool('strapi_media_upload', {
      filename: 'x.png',
      mime: 'image/png',
      source: { url: `${TEST_BASE_URL}/admin/init` },
    });
    expect(r).toMatchObject({ isError: true, error: 'bad_request' });
  });
});
