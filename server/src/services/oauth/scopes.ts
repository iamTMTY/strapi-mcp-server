'use strict';

export const ALL_SCOPES = [
  'strapi:content:read',
  'strapi:content:write',
  'strapi:content:publish',
  'strapi:content:delete',
  'strapi:media:read',
  'strapi:media:write',
  'strapi:media:delete',
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

/**
 * Granted when a client doesn't ask for specific scopes (DCR) and pre-ticked
 * in the admin UI. Publish and delete are destructive, so they are only ever
 * granted when explicitly requested/ticked.
 */
export const DEFAULT_SCOPES: Scope[] = ALL_SCOPES.filter(
  (s) => !s.endsWith(':publish') && !s.endsWith(':delete')
);

export const SCOPE_LABELS: Record<Scope, string> = {
  'strapi:content:read': 'Read content (list types, schemas, entries)',
  'strapi:content:write': 'Create and update draft entries, discard drafts',
  'strapi:content:publish': 'Publish and unpublish entries',
  'strapi:content:delete': 'Delete entries',
  'strapi:media:read': 'List and view media files and folders',
  'strapi:media:write': 'Upload media files and edit their details',
  'strapi:media:delete': 'Delete media files',
};

export function parseScope(input: unknown): Scope[] {
  if (typeof input !== 'string') return [];
  const parts = input
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Scope[] = [];
  for (const p of parts) {
    if ((ALL_SCOPES as readonly string[]).includes(p)) out.push(p as Scope);
  }
  return [...new Set(out)];
}

export function scopeString(scopes: Scope[]): string {
  return [...new Set(scopes)].sort().join(' ');
}

export function isSubsetOf(requested: Scope[], allowed: Scope[]): boolean {
  return requested.every((s) => allowed.includes(s));
}

export function hasScope(granted: Scope[], required: Scope): boolean {
  return granted.includes(required);
}
