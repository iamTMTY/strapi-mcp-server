'use strict';

export const ALL_SCOPES = [
  'strapi:content:read',
  'strapi:content:write',
  'strapi:media:read',
  'strapi:media:write',
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export const SCOPE_LABELS: Record<Scope, string> = {
  'strapi:content:read': 'Read content (list types, schemas, entries)',
  'strapi:content:write': 'Create and update content entries (draft only)',
  'strapi:media:read': 'List media files',
  'strapi:media:write': 'Upload media files',
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
