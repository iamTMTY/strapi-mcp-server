'use strict';

import { z } from 'zod';
import type { Core } from '@strapi/strapi';
import { setCreatorFields } from '@strapi/utils';
import { forbidden, type ContentChecker } from '../permissions';
import {
  defineTool,
  badRequest,
  notFound,
  localeSchema,
  isLocalized,
  resolveLocale,
  type ToolAuth,
  type ToolDef,
} from './common';
import { createRelationGuard } from './relation-guard';

type Attr = { type: string; private?: boolean; component?: string; components?: string[] };
type CT = {
  kind?: string;
  info?: { displayName?: string; singularName?: string; pluralName?: string; description?: string };
  options?: { draftAndPublish?: boolean };
  attributes: Record<string, Attr>;
};
type Action = 'read' | 'create' | 'update' | 'delete' | 'publish' | 'unpublish' | 'discard';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const FIELD_RE = /^[A-Za-z0-9_]{1,64}$/;
const documentIdSchema = z.string().min(1).max(128);
const populateSchema = z
  .union([z.literal('*'), z.array(z.string().regex(/^[A-Za-z0-9_.]{1,128}$/)).max(25)])
  .optional()
  .describe(
    'What to include: "*" (one level of every relation, media, component and dynamic zone) or dotted paths like ["author", "seo.image", "blocks.category"] — paths go through components and dynamic zones.'
  );
const fieldsSchema = z
  .array(z.string().regex(FIELD_RE))
  .max(100)
  .optional()
  .describe('Only return these scalar fields (documentId is always returned).');
const sortDir = z.enum(['asc', 'desc', 'ASC', 'DESC']);
const sortSchema = z
  .union([
    z.string().max(200),
    z.array(z.union([z.string().max(100), z.record(z.string(), sortDir)])).max(10),
    z.record(z.string(), sortDir),
  ])
  .optional()
  .describe(
    'Scalar fields only. Any of: "title:asc", ["publishedAt:desc", "title:asc"], { "title": "asc" }, [{ "title": "asc" }, { "createdAt": "desc" }].'
  );
const filtersSchema = z
  .record(z.string(), z.any())
  .optional()
  .describe(
    'Strapi filters on scalar fields, e.g. { "title": { "$containsi": "hello" } }; a bare value means $eq ({ "title": "Hello" }). Operators: $eq $ne $in $notIn $lt $lte $gt $gte $between $contains $notContains $startsWith $endsWith $null $notNull, case-insensitive $eqi $nei $containsi $notContainsi $startsWithi $endsWithi; combine with $and / $or (arrays) and $not (object).'
  );
const statusSchema = z
  .enum(['draft', 'published'])
  .default('draft')
  .describe('Which version to read on draft & publish types. Ignored otherwise.');
const dataSchema = z
  .record(z.string(), z.any())
  .describe(
    [
      'Field values (see strapi_content_get_schema for fields and writableFields).',
      'To-one relation: "<documentId>", { "documentId": "…", "locale"?: "en", "status"?: "draft" | "published" }, or null to clear.',
      'To-many relation: { "connect": [...], "disconnect": [...] } or { "set": [...] } (set replaces; null clears). Items are documentId strings or { documentId, locale?, status? }; connect items may add "position": { "before"?: id, "after"?: id, "start"?: true, "end"?: true }.',
      'Components: an object (repeatable: array of objects). Dynamic zones: an array of { "__component": "<category.name>", ...fields }.',
      'Media: file id, or array of ids for multiple media.',
    ].join(' ')
  );

export function createContentTools(strapi: Core.Strapi): ToolDef[] {
  const perms = () => strapi.plugin('mcp-server').service('permissions');
  const cts = () => strapi.contentTypes as unknown as Record<string, CT>;
  const docs = (uid: string) => strapi.documents(uid as never);
  const isSingle = (uid: string) => cts()[uid]?.kind === 'singleType';
  const hasDraftAndPublish = (uid: string) => !!cts()[uid]?.options?.draftAndPublish;

  const uidSchema = z
    .string()
    .refine((uid) => uid in cts() && !perms().isInternalUid(uid), {
      message: 'unknown or disallowed uid — call strapi_content_list_types first',
    })
    .describe('Content-type UID, e.g. "api::article.article".');

  /** Checker for the principal on this uid, failing fast when the action is not allowed at all. */
  async function checker(auth: ToolAuth, uid: string, action: Action): Promise<ContentChecker> {
    const c: ContentChecker = await perms().contentChecker(auth.principal, uid);
    if (c.cannot[action]()) throw forbidden();
    return c;
  }

  /**
   * Relations the role's permission conditions reference (e.g. createdBy for
   * "is creator"). Entities must carry them, or CASL evaluates the condition
   * against nothing and strips every field on output.
   */
  async function conditionPopulate(c: ContentChecker, uid: string, query: Doc): Promise<Doc> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const populateBuilder = strapi.plugin('content-manager').service('populate-builder') as any;
    return (await populateBuilder(uid).populateFromQuery(query).build()) ?? {};
  }

  async function outputPopulate(c: ContentChecker, uid: string): Promise<Doc> {
    return conditionPopulate(c, uid, await c.sanitizedQuery.read({}));
  }

  /**
   * Validate (so the model gets a real error instead of silently dropped
   * filters) then sanitize: strips private / non-permitted fields and merges
   * the role's condition filters (e.g. "is creator") into the query.
   */
  async function readQuery(
    c: ContentChecker,
    uid: string,
    query: Record<string, unknown>
  ): Promise<Doc> {
    const clean = Object.fromEntries(
      Object.entries({
        ...query,
        populate: normalizePopulate(strapi, cts()[uid], query.populate),
      }).filter(([, v]) => v !== undefined)
    );
    try {
      await c.validateQuery(clean);
    } catch (err) {
      throw badRequest(`Invalid query: ${(err as Error).message}`);
    }
    const q = await c.sanitizedQuery.read(clean);
    return { ...q, populate: mergePopulate(await conditionPopulate(c, uid, q), q.populate) };
  }

  /** Load one version with whatever the role's conditions need populated to be evaluated. */
  async function loadVersion(
    c: ContentChecker,
    uid: string,
    action: Action,
    where: { documentId: string; locale?: string; status: 'draft' | 'published' }
  ): Promise<Doc | null> {
    const populate = await conditionPopulate(c, uid, await c.sanitizedQuery[action]({}));
    return docs(uid).findOne({ ...where, populate } as never) as Promise<Doc | null>;
  }

  /** Collection types need a documentId; single types resolve their only document. */
  async function resolveDocumentId(
    uid: string,
    documentId: string | undefined,
    locale: string | undefined
  ): Promise<string | null> {
    if (documentId) return documentId;
    if (!isSingle(uid)) throw badRequest('documentId is required for collection types.');
    const doc = (await docs(uid).findFirst({
      locale,
      fields: ['documentId'],
    } as never)) as Doc | null;
    return doc?.documentId ?? null;
  }

  /**
   * The entry a create would produce, for permission checks: the target
   * locale plus this admin as creator — so "is creator" / "same role as
   * creator" conditions evaluate the way they will for the real entry.
   */
  const newEntry = (auth: ToolAuth, locale: string | undefined) => ({
    ...(locale ? { locale } : {}),
    createdBy: auth.principal.user,
  });

  /** Locales the role may use for each action (localized types only). */
  async function localesByAction(
    auth: ToolAuth,
    c: ContentChecker
  ): Promise<Record<string, string[]>> {
    const svc = strapi.plugin('i18n')?.service('locales');
    const codes =
      ((await svc?.find()) as Array<{ code: string }> | undefined)?.map((l) => l.code) ?? [];
    const out: Record<string, string[]> = {};
    for (const action of ['read', 'create', 'update', 'delete', 'publish'] as const) {
      out[action] = codes.filter((code) => c.can[action](newEntry(auth, code)));
    }
    return out;
  }

  /**
   * Everything returned to the model goes through here: the root type's
   * sanitizer, then per-target checks on every populated relation.
   */
  async function present(
    auth: ToolAuth,
    c: ContentChecker,
    uid: string,
    doc: Doc | null
  ): Promise<Doc | null> {
    if (!doc) return doc;
    return createRelationGuard(strapi, auth.principal).apply(uid, await c.sanitizeOutput(doc));
  }

  function requireDraftAndPublish(uid: string): void {
    if (!hasDraftAndPublish(uid)) throw badRequest(`${uid} does not use draft & publish.`);
  }

  async function createDocument(
    c: ContentChecker,
    auth: ToolAuth,
    uid: string,
    data: Record<string, unknown>,
    locale: string | undefined
  ): Promise<Doc | null> {
    if (c.cannot.create(newEntry(auth, locale))) throw forbidden();
    const clean = setCreatorFields({ user: auth.principal.user as never })(
      await c.sanitizeCreateInput(data)
    );
    const created = await docs(uid).create({
      data: clean,
      locale,
      status: 'draft',
      populate: await outputPopulate(c, uid),
    } as never);
    return present(auth, c, uid, created as Doc);
  }

  return [
    defineTool({
      name: 'strapi_content_list_types',
      title: 'List content types',
      description:
        'List the content types you can read, with kind (collectionType/singleType), whether they use draft & publish, which actions you are allowed, and — for localized types — the default locale and which locales you may use per action.',
      scope: 'strapi:content:read',
      requires: 'content.read',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}).strict(),
      async run(_input, auth) {
        const out: Array<Record<string, unknown>> = [];
        for (const uid of perms().listAllowedUids() as string[]) {
          // eslint-disable-next-line no-await-in-loop
          const c: ContentChecker = await perms().contentChecker(auth.principal, uid);
          if (c.cannot.read()) continue;
          const ct = cts()[uid];
          const localized = isLocalized(strapi, uid);
          out.push({
            uid,
            kind: ct.kind,
            displayName: ct.info?.displayName,
            description: ct.info?.description || undefined,
            draftAndPublish: hasDraftAndPublish(uid),
            localized,
            can: {
              create: c.can.create(),
              update: c.can.update(),
              delete: c.can.delete(),
              publish: c.can.publish(),
            },
            ...(localized
              ? {
                  // eslint-disable-next-line no-await-in-loop
                  defaultLocale: await strapi
                    .plugin('i18n')
                    ?.service('locales')
                    ?.getDefaultLocale(),
                  // eslint-disable-next-line no-await-in-loop
                  locales: await localesByAction(auth, c),
                }
              : {}),
          });
        }
        return { contentTypes: out };
      },
    }),

    defineTool({
      name: 'strapi_content_get_schema',
      title: 'Get content type schema',
      description:
        'Attribute schema for one content type (only fields you may read), every referenced component resolved (nested ones and dynamic-zone members included), and which fields you may set on create and on update. Call before creating or updating entries.',
      scope: 'strapi:content:read',
      requires: 'content.read',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ uid: uidSchema }).strict(),
      async run({ uid }, auth) {
        const c = await checker(auth, uid, 'read');
        const ct = cts()[uid];
        const attributes = Object.fromEntries(
          Object.entries(ct.attributes).filter(
            ([name, attr]) => !attr.private && c.can.read(undefined, name)
          )
        );
        const names = Object.keys(attributes);
        return {
          uid,
          kind: ct.kind,
          info: ct.info,
          draftAndPublish: hasDraftAndPublish(uid),
          localized: isLocalized(strapi, uid),
          attributes,
          components: collectComponents(strapi, attributes),
          // Field-level permissions per write action; anything else in `data` is dropped.
          writableFields: {
            create: names.filter((n) => c.can.create(undefined, n)),
            update: names.filter((n) => c.can.update(undefined, n)),
          },
          ...(Object.values(attributes).some((a) => a.type === 'dynamiczone')
            ? {
                dynamicZoneFormat:
                  'Each dynamic zone item is an object with "__component": "<category.name>" (one of the zone\'s allowed components) plus that component\'s fields.',
              }
            : {}),
        };
      },
    }),

    defineTool({
      name: 'strapi_content_list_entries',
      title: 'List entries',
      description:
        'Paginated, filterable, sortable list of entries for a content type. Returns results plus pagination { page, pageSize, total, pageCount }.',
      scope: 'strapi:content:read',
      requires: 'content.read',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z
        .object({
          uid: uidSchema,
          filters: filtersSchema,
          sort: sortSchema,
          fields: fieldsSchema,
          populate: populateSchema,
          page: z.number().int().min(1).max(10000).default(1),
          pageSize: z.number().int().min(1).max(100).default(25),
          locale: localeSchema.optional(),
          status: statusSchema,
        })
        .strict(),
      async run(input, auth) {
        const locale = await resolveLocale(strapi, input.uid, input.locale);
        const c = await checker(auth, input.uid, 'read');
        const q = await readQuery(c, input.uid, {
          filters: input.filters,
          sort: input.sort,
          fields: input.fields,
          populate: input.populate,
        });
        const status = hasDraftAndPublish(input.uid) ? input.status : undefined;
        const [results, total] = await Promise.all([
          docs(input.uid).findMany({
            ...q,
            locale,
            status,
            start: (input.page - 1) * input.pageSize,
            limit: input.pageSize,
          } as never) as Promise<Doc[]>,
          docs(input.uid).count({ filters: q.filters, locale, status } as never) as Promise<number>,
        ]);
        const guard = createRelationGuard(strapi, auth.principal);
        return {
          results: await Promise.all(
            results.map(async (r) => guard.apply(input.uid, await c.sanitizeOutput(r)))
          ),
          pagination: {
            page: input.page,
            pageSize: input.pageSize,
            total,
            pageCount: Math.ceil(total / input.pageSize),
          },
        };
      },
    }),

    defineTool({
      name: 'strapi_content_get_entry',
      title: 'Get entry',
      description:
        'Fetch one entry by documentId. For single types omit documentId to get the single entry.',
      scope: 'strapi:content:read',
      requires: 'content.read',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z
        .object({
          uid: uidSchema,
          documentId: documentIdSchema.optional(),
          fields: fieldsSchema,
          populate: populateSchema,
          locale: localeSchema.optional(),
          status: statusSchema,
        })
        .strict(),
      async run(input, auth) {
        const locale = await resolveLocale(strapi, input.uid, input.locale);
        const c = await checker(auth, input.uid, 'read');
        const documentId = await resolveDocumentId(input.uid, input.documentId, locale);
        if (!documentId) throw notFound();
        const q = await readQuery(c, input.uid, { fields: input.fields, populate: input.populate });
        // The role's condition filters are in q.filters, so a document the
        // caller may not read simply isn't found.
        const doc = (await docs(input.uid).findFirst({
          ...q,
          filters: { $and: [q.filters ?? {}, { documentId }] },
          locale,
          status: hasDraftAndPublish(input.uid) ? input.status : undefined,
        } as never)) as Doc | null;
        if (!doc) throw notFound();
        return present(auth, c, input.uid, doc);
      },
    }),

    defineTool({
      name: 'strapi_content_create_entry',
      title: 'Create entry',
      description:
        'Create an entry (saved as a draft on draft & publish types; use strapi_content_publish_entry to publish). Fields you may not edit are dropped. For single types that already have content, use strapi_content_update_entry.',
      scope: 'strapi:content:write',
      requires: 'content.create',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: z
        .object({ uid: uidSchema, data: dataSchema, locale: localeSchema.optional() })
        .strict(),
      async run(input, auth) {
        const locale = await resolveLocale(strapi, input.uid, input.locale);
        const c = await checker(auth, input.uid, 'create');
        if (isSingle(input.uid) && (await resolveDocumentId(input.uid, undefined, locale))) {
          throw badRequest(
            'This single type already has content; use strapi_content_update_entry.'
          );
        }
        return createDocument(c, auth, input.uid, input.data, locale);
      },
    }),

    defineTool({
      name: 'strapi_content_update_entry',
      title: 'Update entry',
      description:
        'Partially update the draft of an entry. Passing a locale the document does not have yet creates that translation. For single types omit documentId (creates the entry if empty). Fields you may not edit are dropped.',
      scope: 'strapi:content:write',
      requires: 'content.update',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z
        .object({
          uid: uidSchema,
          documentId: documentIdSchema.optional(),
          data: dataSchema,
          locale: localeSchema.optional(),
        })
        .strict(),
      async run(input, auth) {
        const locale = await resolveLocale(strapi, input.uid, input.locale);
        const c = await checker(auth, input.uid, 'update');
        const documentId = await resolveDocumentId(input.uid, input.documentId, locale);
        if (!documentId) {
          // Empty single type: writing it means creating it.
          return createDocument(c, auth, input.uid, input.data, locale);
        }

        const version = await loadVersion(c, input.uid, 'update', {
          documentId,
          locale,
          status: 'draft',
        });
        let data: Record<string, unknown>;
        if (version) {
          if (c.cannot.update(version)) throw forbidden();
          data = setCreatorFields({ user: auth.principal.user as never, isEdition: true })(
            await c.sanitizeUpdateInput(version)(input.data)
          );
        } else {
          // Document exists in another locale → this creates a translation.
          const exists = await strapi.db.query(input.uid as never).count({ where: { documentId } });
          if (!exists) throw notFound();
          if (c.cannot.create(newEntry(auth, locale))) throw forbidden();
          data = setCreatorFields({ user: auth.principal.user as never })(
            await c.sanitizeCreateInput(input.data)
          );
        }
        const updated = await docs(input.uid).update({
          documentId,
          locale,
          data,
          populate: await outputPopulate(c, input.uid),
        } as never);
        return present(auth, c, input.uid, updated as Doc);
      },
    }),

    defineTool({
      name: 'strapi_content_delete_entry',
      title: 'Delete entry',
      description:
        'Permanently delete an entry (draft and published versions) in one locale — the default locale if omitted. This cannot be undone.',
      scope: 'strapi:content:delete',
      requires: 'content.delete',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z
        .object({
          uid: uidSchema,
          documentId: documentIdSchema.optional(),
          locale: localeSchema.optional(),
        })
        .strict(),
      async run(input, auth) {
        const locale = await resolveLocale(strapi, input.uid, input.locale);
        const c = await checker(auth, input.uid, 'delete');
        const documentId = await resolveDocumentId(input.uid, input.documentId, locale);
        if (!documentId) throw notFound();
        const statuses = hasDraftAndPublish(input.uid)
          ? (['draft', 'published'] as const)
          : (['draft'] as const);
        let found = false;
        for (const status of statuses) {
          // eslint-disable-next-line no-await-in-loop
          const v = await loadVersion(c, input.uid, 'delete', { documentId, locale, status });
          if (!v) continue;
          found = true;
          if (c.cannot.delete(v)) throw forbidden();
        }
        if (!found) throw notFound();
        await docs(input.uid).delete({ documentId, locale } as never);
        return { deleted: true, documentId, locale };
      },
    }),

    defineTool({
      name: 'strapi_content_publish_entry',
      title: 'Publish entry',
      description: 'Publish the current draft of an entry (draft & publish types only).',
      scope: 'strapi:content:publish',
      requires: 'content.publish',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z
        .object({
          uid: uidSchema,
          documentId: documentIdSchema.optional(),
          locale: localeSchema.optional(),
        })
        .strict(),
      async run(input, auth) {
        requireDraftAndPublish(input.uid);
        const locale = await resolveLocale(strapi, input.uid, input.locale);
        const c = await checker(auth, input.uid, 'publish');
        const documentId = await resolveDocumentId(input.uid, input.documentId, locale);
        if (!documentId) throw notFound();
        const draft = await loadVersion(c, input.uid, 'publish', {
          documentId,
          locale,
          status: 'draft',
        });
        if (!draft) throw notFound();
        if (c.cannot.publish(draft)) throw forbidden();
        const result = (await docs(input.uid).publish({ documentId, locale } as never)) as {
          entries?: Doc[];
        };
        return present(auth, c, input.uid, result.entries?.[0] ?? null);
      },
    }),

    defineTool({
      name: 'strapi_content_unpublish_entry',
      title: 'Unpublish entry',
      description:
        'Take the published version of an entry offline. The draft is kept (draft & publish types only).',
      scope: 'strapi:content:publish',
      requires: 'content.publish',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z
        .object({
          uid: uidSchema,
          documentId: documentIdSchema.optional(),
          locale: localeSchema.optional(),
        })
        .strict(),
      async run(input, auth) {
        requireDraftAndPublish(input.uid);
        const locale = await resolveLocale(strapi, input.uid, input.locale);
        const c = await checker(auth, input.uid, 'unpublish');
        const documentId = await resolveDocumentId(input.uid, input.documentId, locale);
        if (!documentId) throw notFound();
        const published = await loadVersion(c, input.uid, 'unpublish', {
          documentId,
          locale,
          status: 'published',
        });
        if (!published) throw notFound('Entry is not published.');
        if (c.cannot.unpublish(published)) throw forbidden();
        await docs(input.uid).unpublish({ documentId, locale } as never);
        return { unpublished: true, documentId, locale };
      },
    }),

    defineTool({
      name: 'strapi_content_discard_draft',
      title: 'Discard draft',
      description:
        'Throw away unpublished draft changes, resetting the draft to the published version (draft & publish types only).',
      scope: 'strapi:content:write',
      requires: 'content.update',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z
        .object({
          uid: uidSchema,
          documentId: documentIdSchema.optional(),
          locale: localeSchema.optional(),
        })
        .strict(),
      async run(input, auth) {
        requireDraftAndPublish(input.uid);
        const locale = await resolveLocale(strapi, input.uid, input.locale);
        const c = await checker(auth, input.uid, 'discard');
        const documentId = await resolveDocumentId(input.uid, input.documentId, locale);
        if (!documentId) throw notFound();
        const published = await loadVersion(c, input.uid, 'discard', {
          documentId,
          locale,
          status: 'published',
        });
        if (!published) throw notFound('Entry has no published version to reset to.');
        if (c.cannot.discard(published)) throw forbidden();
        const result = (await docs(input.uid).discardDraft({ documentId, locale } as never)) as {
          entries?: Doc[];
        };
        return present(auth, c, input.uid, result.entries?.[0] ?? null);
      },
    }),
  ];
}

const POPULATABLE = ['relation', 'media', 'component', 'dynamiczone'];

/**
 * '*' / ["author", "seo.image", "blocks.category"] → a Strapi populate object
 * (so it can be merged with what permission conditions need). Walks the
 * schema: relations/media/components nest under `populate`, dynamic zones
 * under `on: { '<component>': … }` as Strapi requires — each zone component
 * that has the next path segment gets the nested populate, the rest are
 * populated one level. '*' = one level of everything (creator fields excluded).
 */
function normalizePopulate(strapi: Core.Strapi, ct: CT, populate: unknown): Doc | undefined {
  if (populate === undefined) return undefined;
  if (populate === '*') {
    return Object.fromEntries(
      Object.entries(ct.attributes)
        .filter(
          ([name, a]) =>
            POPULATABLE.includes(a.type) && name !== 'createdBy' && name !== 'updatedBy'
        )
        .map(([name]) => [name, true])
    );
  }
  return buildPopulate(
    strapi,
    ct.attributes,
    (populate as string[]).map((p) => p.split('.'))
  );
}

function buildPopulate(strapi: Core.Strapi, attrs: Record<string, Attr>, paths: string[][]): Doc {
  const attributesOf = (uid: string | undefined): Record<string, Attr> =>
    (uid &&
      (
        (strapi.contentTypes as unknown as Record<string, CT>)[uid] ??
        (strapi.components as unknown as Record<string, CT>)[uid]
      )?.attributes) ||
    {};
  const out: Doc = {};
  const heads = [...new Set(paths.map((p) => p[0]))];
  for (const head of heads) {
    const rests = paths.filter((p) => p[0] === head && p.length > 1).map((p) => p.slice(1));
    const attr = attrs[head] as (Attr & { target?: string }) | undefined;
    if (!rests.length || !attr) {
      // Unknown names are left for the query validator to reject.
      out[head] = true;
    } else if (attr.type === 'dynamiczone') {
      out[head] = {
        on: Object.fromEntries(
          (attr.components ?? []).map((uid) => {
            const compAttrs = attributesOf(uid);
            const own = rests.filter((r) => r[0] in compAttrs);
            return [
              uid,
              own.length ? { populate: buildPopulate(strapi, compAttrs, own) } : { populate: '*' },
            ];
          })
        ),
      };
    } else {
      const nested =
        attr.type === 'component'
          ? attributesOf(attr.component)
          : attr.type === 'media'
            ? attributesOf('plugin::upload.file')
            : attributesOf(attr.target);
      out[head] = { populate: buildPopulate(strapi, nested, rests) };
    }
  }
  return out;
}

function mergePopulate(a: unknown, b: unknown): Doc | undefined {
  const isObj = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(a)) return isObj(b) ? b : undefined;
  if (!isObj(b)) return a;
  const out: Doc = { ...a };
  for (const [k, v] of Object.entries(b))
    out[k] = isObj(out[k]) && isObj(v) ? mergePopulate(out[k], v) : v;
  return out;
}

/** Every component reachable from `attributes`, nested ones included (cycle-safe). */
function collectComponents(
  strapi: Core.Strapi,
  attributes: Record<string, Attr>
): Record<string, Record<string, Attr>> {
  const all = strapi.components as unknown as Record<string, { attributes: Record<string, Attr> }>;
  const out: Record<string, Record<string, Attr>> = {};
  const visit = (attrs: Record<string, Attr>) => {
    for (const attr of Object.values(attrs)) {
      const refs =
        attr.type === 'component' && attr.component
          ? [attr.component]
          : attr.type === 'dynamiczone'
            ? (attr.components ?? [])
            : [];
      for (const ref of refs) {
        if (out[ref] || !all[ref]) continue;
        out[ref] = Object.fromEntries(
          Object.entries(all[ref].attributes).filter(([, a]) => !a.private)
        );
        visit(all[ref].attributes);
      }
    }
  };
  visit(attributes);
  return out;
}
