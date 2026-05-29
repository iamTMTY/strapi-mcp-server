'use strict';

import type { Core } from '@strapi/strapi';
import { authorizationServerUrl } from './audience';

/**
 * RFC 6749 / 9728 token-error payload — used by 4xx responses on /oauth/*
 * and /mcp. Never include token bodies or PII in error_description.
 */
export interface OAuthErrorPayload {
  error: string;
  error_description?: string;
  error_uri?: string;
}

export function bearerChallenge(
  strapi: Core.Strapi,
  opts: { error?: string; error_description?: string; scope?: string } = {}
): string {
  const asUrl = authorizationServerUrl(strapi);
  const parts: string[] = ['Bearer realm="mcp"'];
  if (opts.error) parts.push(`error="${opts.error}"`);
  if (opts.error_description) {
    // strip quotes and CRLF to keep the header well-formed
    const safe = opts.error_description.replace(/["\r\n]/g, '');
    parts.push(`error_description="${safe}"`);
  }
  if (opts.scope) parts.push(`scope="${opts.scope}"`);
  // Points at our actual route, which is mounted at the host root, not under /mcp.
  parts.push(`resource_metadata="${asUrl}/.well-known/oauth-protected-resource"`);
  return parts.join(', ');
}
