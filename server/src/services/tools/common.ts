'use strict';

import { z } from 'zod';
import type { Core } from '@strapi/strapi';
import type { PrincipalContext } from '../permissions';
import { hasScope, type Scope } from '../oauth/scopes';

/** Per-request identity, re-resolved from the bearer token on every call. */
export interface ToolAuth {
  principal: PrincipalContext;
  scopes: Scope[];
  clientId: string;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  /** Same payload as `content[0].text`, for clients that consume structured results. */
  structuredContent: Record<string, unknown>;
}

/**
 * What the caller's Strapi role must be able to do *somewhere* for the tool
 * to be listed at all (e.g. `content.publish` = can publish at least one
 * content type). Calls still re-check per document.
 */
export type Capability =
  | 'content.read'
  | 'content.create'
  | 'content.update'
  | 'content.delete'
  | 'content.publish'
  | 'media.read'
  | 'media.create'
  | 'media.update';

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  requires: Capability;
  annotations: ToolAnnotations;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.ZodObject<any>;
  /** Checks scope, parses input, then runs the tool. */
  handler: (raw: unknown, auth: ToolAuth) => Promise<ToolResult>;
}

/**
 * Build a tool whose handler always enforces its scope and validates input
 * before the implementation runs, so no tool can forget either.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineTool<S extends z.ZodObject<any>>(def: {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  requires: Capability;
  annotations: ToolAnnotations;
  inputSchema: S;
  run: (input: z.infer<S>, auth: ToolAuth) => Promise<unknown>;
}): ToolDef {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    scope: def.scope,
    requires: def.requires,
    annotations: def.annotations,
    inputSchema: def.inputSchema,
    async handler(raw, auth) {
      if (!auth || !hasScope(auth.scopes, def.scope)) {
        throw withCode(
          new Error('You do not have permission to perform this action.'),
          'insufficient_scope'
        );
      }
      const input = def.inputSchema.parse(raw ?? {});
      return json(await def.run(input, auth));
    },
  };
}

export const json = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value ?? null) }],
  // structuredContent must be an object; wrap lists / null.
  structuredContent:
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value ?? null },
});

export function withCode(err: Error, code: string): Error {
  (err as Error & { code?: string }).code = code;
  return err;
}

/** Errors thrown by upload provider SDKs (AWS SDK v3, Cloudinary, …) rather than by Strapi. */
export function isProviderError(err: unknown): boolean {
  const e = err as { $metadata?: unknown; http_code?: unknown; $fault?: unknown };
  return !!(e && (e.$metadata || e.$fault || e.http_code));
}

export const badRequest = (message: string): Error => withCode(new Error(message), 'bad_request');
export const notFound = (message = 'Not found.'): Error =>
  withCode(new Error(message), 'not_found');

/** BCP-47-ish shape; the real check is against the configured i18n locales. */
export const localeSchema = z
  .string()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'invalid locale');

export function isLocalized(strapi: Core.Strapi, uid: string): boolean {
  const ct = (
    strapi.contentTypes as unknown as Record<
      string,
      { pluginOptions?: Record<string, { localized?: boolean }> }
    >
  )[uid];
  return !!ct?.pluginOptions?.i18n?.localized;
}

/**
 * The locale an operation will actually touch: undefined for non-localized
 * types, otherwise the requested locale (validated against i18n) or the
 * default one. Resolving it explicitly means locale-restricted roles are
 * checked against the real target, not "whatever the default happens to be".
 */
export async function resolveLocale(
  strapi: Core.Strapi,
  uid: string,
  locale: string | undefined
): Promise<string | undefined> {
  if (!isLocalized(strapi, uid)) {
    if (locale !== undefined) throw badRequest(`${uid} is not localized; omit "locale".`);
    return undefined;
  }
  const svc = strapi.plugin('i18n')?.service('locales');
  if (!svc) return locale;
  if (locale === undefined) return (await svc.getDefaultLocale()) as string;
  const locales = (await svc.find()) as Array<{ code: string }>;
  if (!locales.some((l) => l.code === locale)) {
    throw badRequest(
      `Unknown locale "${locale}". Available: ${locales.map((l) => l.code).join(', ')}`
    );
  }
  return locale;
}
