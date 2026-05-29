'use strict';

import type { Core } from '@strapi/strapi';
import { getConfig } from '../../config';

/** Full URL of the protected resource, e.g. `http://localhost:1337/mcp`. */
export function canonicalResourceUrl(strapi: Core.Strapi): string {
  return getConfig(strapi).resourceUrl;
}

/**
 * The OAuth Authorization Server issuer — the *origin* of the resource URL,
 * with no path. The MCP server lives at `/mcp` but the OAuth server lives at
 * the host root, so `aud` (= resource) and `iss` (= origin) are different.
 *
 * Returns e.g. `http://localhost:1337` for resource `http://localhost:1337/mcp`.
 */
export function authorizationServerUrl(strapi: Core.Strapi): string {
  const u = new URL(canonicalResourceUrl(strapi));
  return `${u.protocol}//${u.host}`;
}

export function audienceMatches(strapi: Core.Strapi, aud: unknown): boolean {
  if (typeof aud !== 'string') return false;
  return aud === canonicalResourceUrl(strapi);
}
