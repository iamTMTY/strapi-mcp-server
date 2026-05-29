'use strict';

import { z } from 'zod';
import type { Core } from '@strapi/strapi';
import type { PrincipalContext } from '../permissions';
import { hasScope, type Scope } from '../oauth/scopes';

const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

export interface ToolDef {
  name: string;
  description: string;
  scope: Scope;
  inputSchema: z.ZodTypeAny;
  handler: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

export interface ToolFactoryArgs {
  strapi: Core.Strapi;
  principal: PrincipalContext;
  scopes: Scope[];
}

const populateSchema = z
  .union([z.literal('*'), z.array(z.string().regex(/^[A-Za-z0-9_.]{1,64}$/))])
  .optional();

const uidSchema = (strapi: Core.Strapi) =>
  z.string().refine(
    (uid) =>
      uid in (strapi.contentTypes as unknown as Record<string, unknown>) &&
      !strapi
        .plugin('mcp-server')
        .service('permissions')
        .isInternalUid(uid),
    { message: 'unknown or disallowed uid' }
  );

export function createContentTools(args: ToolFactoryArgs): ToolDef[] {
  const { strapi, principal, scopes } = args;
  const permSvc = strapi.plugin('mcp-server').service('permissions');

  function requireScope(s: Scope): void {
    if (!hasScope(scopes, s)) {
      const err = new Error('You do not have permission to perform this action.');
      (err as Error & { code?: string }).code = 'insufficient_scope';
      throw err;
    }
  }

  async function requirePerm(uid: string, action: 'read' | 'create' | 'update'): Promise<void> {
    const ok = await permSvc.canActionOnUid(principal, uid, action);
    if (!ok) {
      const err = new Error('You do not have permission to access this content.');
      (err as Error & { code?: string }).code = 'forbidden';
      throw err;
    }
  }

  const json = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  });

  return [
    {
      name: 'strapi.content.list_types',
      description: 'List all content-types the caller is allowed to see.',
      scope: 'strapi:content:read',
      inputSchema: z.object({}).strict(),
      async handler() {
        requireScope('strapi:content:read');
        const allowed = permSvc.listAllowedUids() as string[];
        const filtered: Array<Record<string, unknown>> = [];
        for (const uid of allowed) {
          // eslint-disable-next-line no-await-in-loop
          if (!(await permSvc.canActionOnUid(principal, uid, 'read'))) continue;
          const cts = strapi.contentTypes as unknown as Record<
            string,
            {
              kind?: string;
              info?: { displayName?: string; pluralName?: string };
              options?: { draftAndPublish?: boolean };
            }
          >;
          const ct = cts[uid];
          filtered.push({
            uid,
            kind: ct.kind,
            displayName: ct.info?.displayName,
            pluralName: ct.info?.pluralName,
            draftAndPublish: !!ct.options?.draftAndPublish,
          });
        }
        return json({ contentTypes: filtered });
      },
    },

    {
      name: 'strapi.content.get_schema',
      description: 'Return the attribute schema for a single content-type.',
      scope: 'strapi:content:read',
      inputSchema: z.object({ uid: uidSchema(strapi) }).strict(),
      async handler(raw) {
        requireScope('strapi:content:read');
        const input = z.object({ uid: uidSchema(strapi) }).parse(raw) as { uid: string };
        await requirePerm(input.uid, 'read');
        const cts = strapi.contentTypes as unknown as Record<
          string,
          {
            kind?: string;
            info?: Record<string, unknown>;
            attributes: Record<string, { type: string; component?: string; components?: string[] }>;
          }
        >;
        const ct = cts[input.uid];
        const components = strapi.components as unknown as Record<string, { attributes: unknown }>;
        const referenced: Record<string, unknown> = {};
        for (const attr of Object.values(ct.attributes)) {
          if (attr.type === 'component' && attr.component && components[attr.component]) {
            referenced[attr.component] = components[attr.component].attributes;
          }
          if (attr.type === 'dynamiczone' && Array.isArray(attr.components)) {
            for (const c of attr.components) {
              if (components[c]) referenced[c] = components[c].attributes;
            }
          }
        }
        return json({
          uid: input.uid,
          kind: ct.kind,
          info: ct.info,
          attributes: ct.attributes,
          components: referenced,
        });
      },
    },

    {
      name: 'strapi.content.list_entries',
      description: 'Paginated list of entries for a content-type. pageSize <= 100.',
      scope: 'strapi:content:read',
      inputSchema: z
        .object({
          uid: uidSchema(strapi),
          filters: z.record(z.any()).optional(),
          pagination: z
            .object({
              page: z.number().int().min(1).max(10000).default(1),
              pageSize: z.number().int().min(1).max(100).default(25),
            })
            .optional(),
          locale: z.string().regex(LOCALE_RE).optional(),
          status: z.enum(['draft', 'published']).default('draft'),
          populate: populateSchema,
        })
        .strict(),
      async handler(raw) {
        requireScope('strapi:content:read');
        const schema = this.inputSchema as z.ZodTypeAny;
        const input = schema.parse(raw) as {
          uid: string;
          filters?: Record<string, unknown>;
          pagination?: { page: number; pageSize: number };
          locale?: string;
          status: 'draft' | 'published';
          populate?: '*' | string[];
        };
        await requirePerm(input.uid, 'read');

        const page = input.pagination?.page ?? 1;
        const pageSize = Math.min(100, input.pagination?.pageSize ?? 25);

        const result = await strapi.documents(input.uid as never).findMany({
          filters: (input.filters ?? {}) as never,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          locale: input.locale as any,
          status: input.status,
          populate: input.populate as never,
          start: (page - 1) * pageSize,
          limit: pageSize,
        });
        return json({ page, pageSize, count: result.length, results: result });
      },
    },

    {
      name: 'strapi.content.get_entry',
      description: 'Fetch a single entry by documentId.',
      scope: 'strapi:content:read',
      inputSchema: z
        .object({
          uid: uidSchema(strapi),
          documentId: z.string().min(1).max(128),
          locale: z.string().regex(LOCALE_RE).optional(),
          status: z.enum(['draft', 'published']).default('draft'),
          populate: populateSchema,
        })
        .strict(),
      async handler(raw) {
        requireScope('strapi:content:read');
        const schema = this.inputSchema as z.ZodTypeAny;
        const input = schema.parse(raw) as {
          uid: string;
          documentId: string;
          locale?: string;
          status: 'draft' | 'published';
          populate?: '*' | string[];
        };
        await requirePerm(input.uid, 'read');
        const result = await strapi.documents(input.uid as never).findOne({
          documentId: input.documentId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          locale: input.locale as any,
          status: input.status,
          populate: input.populate as never,
        });
        return json(result ?? null);
      },
    },

    {
      name: 'strapi.content.create_entry',
      description: 'Create a draft entry. Publish/unpublish is not exposed.',
      scope: 'strapi:content:write',
      inputSchema: z
        .object({
          uid: uidSchema(strapi),
          data: z.record(z.any()),
          locale: z.string().regex(LOCALE_RE).optional(),
        })
        .strict(),
      async handler(raw) {
        requireScope('strapi:content:write');
        const schema = this.inputSchema as z.ZodTypeAny;
        const input = schema.parse(raw) as {
          uid: string;
          data: Record<string, unknown>;
          locale?: string;
        };
        await requirePerm(input.uid, 'create');
        const result = await strapi.documents(input.uid as never).create({
          data: input.data as never,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          locale: input.locale as any,
          status: 'draft',
        });
        return json(result);
      },
    },

    {
      name: 'strapi.content.update_entry',
      description: 'Partial update of an existing draft entry. Publish/unpublish not exposed.',
      scope: 'strapi:content:write',
      inputSchema: z
        .object({
          uid: uidSchema(strapi),
          documentId: z.string().min(1).max(128),
          data: z.record(z.any()),
          locale: z.string().regex(LOCALE_RE).optional(),
        })
        .strict(),
      async handler(raw) {
        requireScope('strapi:content:write');
        const schema = this.inputSchema as z.ZodTypeAny;
        const input = schema.parse(raw) as {
          uid: string;
          documentId: string;
          data: Record<string, unknown>;
          locale?: string;
        };
        await requirePerm(input.uid, 'update');
        const result = await strapi.documents(input.uid as never).update({
          documentId: input.documentId,
          data: input.data as never,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          locale: input.locale as any,
          status: 'draft',
        });
        return json(result);
      },
    },
  ];
}
