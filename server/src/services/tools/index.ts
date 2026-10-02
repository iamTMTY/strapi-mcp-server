'use strict';

import type { Core } from '@strapi/strapi';
import { createContentTools } from './content';
import { createMediaTools } from './media';
import { getConfig } from '../../config';
import { UPLOAD_ACTIONS, type PrincipalContext } from '../permissions';
import { ALL_SCOPES, DEFAULT_SCOPES, type Scope } from '../oauth/scopes';
import type { Capability, ToolDef } from './common';

export type { ToolDef, ToolAuth, Capability } from './common';

export function allTools(strapi: Core.Strapi): ToolDef[] {
  return [
    ...createContentTools(strapi),
    ...createMediaTools(strapi),
    ...strapi.plugin('mcp-server').service('tool-registry').list(),
  ];
}

/** Pre-0.2 names (`strapi.content.list_types`) still work as config toggle keys. */
function legacyName(name: string): string {
  return name.replace(/^strapi_(content|media)_/, 'strapi.$1.');
}

export function isToolEnabled(strapi: Core.Strapi, tool: Pick<ToolDef, 'name' | 'scope'>): boolean {
  const toggles = getConfig(strapi).tools.enabled;
  return (
    toggles[tool.name] ?? toggles[legacyName(tool.name)] ?? DEFAULT_SCOPES.includes(tool.scope)
  );
}

export function grantableScopes(strapi: Core.Strapi): Scope[] {
  const enabled = new Set(
    allTools(strapi)
      .filter((t) => isToolEnabled(strapi, t))
      .map((t) => t.scope)
  );
  return ALL_SCOPES.filter((s) => enabled.has(s));
}

/**
 * What the principal's role can do anywhere: content actions on at least one
 * content type, and each Media Library action. Mirrors Strapi's own rule of
 * not exposing tools a token can't use.
 */
export async function capabilitiesOf(
  strapi: Core.Strapi,
  principal: PrincipalContext
): Promise<Set<Capability>> {
  const perms = strapi.plugin('mcp-server').service('permissions');
  const caps = new Set<Capability>();
  const contentActions = ['read', 'create', 'update', 'delete', 'publish'] as const;
  for (const uid of perms.listAllowedUids() as string[]) {
    // eslint-disable-next-line no-await-in-loop
    const c = await perms.contentChecker(principal, uid);
    for (const a of contentActions) if (c.can[a]()) caps.add(`content.${a}`);
    if (contentActions.every((a) => caps.has(`content.${a}`))) break;
  }
  for (const [cap, action] of [
    ['media.read', UPLOAD_ACTIONS.read],
    ['media.create', UPLOAD_ACTIONS.create],
    ['media.update', UPLOAD_ACTIONS.update],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop
    if ((await perms.uploadManager(principal, action)).isAllowed) caps.add(cap);
  }
  return caps;
}

/**
 * Tools to expose for one request: granted scope, config toggle, and a role
 * that can actually use them. Handlers still re-check everything per call.
 */
export async function toolsFor(
  strapi: Core.Strapi,
  auth: { principal: PrincipalContext; scopes: Scope[] }
): Promise<ToolDef[]> {
  const caps = await capabilitiesOf(strapi, auth.principal);
  return allTools(strapi).filter(
    (t) => auth.scopes.includes(t.scope) && isToolEnabled(strapi, t) && caps.has(t.requires)
  );
}
