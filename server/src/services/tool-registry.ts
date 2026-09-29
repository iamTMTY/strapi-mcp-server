'use strict';

import type { Core } from '@strapi/strapi';
import { z } from 'zod';
import { ALL_SCOPES } from './oauth/scopes';
import { defineTool, type Capability, type ToolDef } from './tools/common';

const CAPABILITIES: Capability[] = [
  'content.read',
  'content.create',
  'content.update',
  'content.delete',
  'content.publish',
  'media.read',
  'media.create',
  'media.update',
];

const registered = new Map<string, ToolDef>();

/**
 * Extension point for other plugins / the host app:
 *
 *   strapi.plugin('mcp-server').service('tool-registry').register({
 *     name: 'acme_reindex_search', title: 'Reindex search', description: '…',
 *     scope: 'strapi:content:write', requires: 'content.update',
 *     annotations: { readOnlyHint: false, destructiveHint: false },
 *     inputSchema: z.object({ uid: z.string() }),   // zod v4
 *     async run(input, auth) { … return { ok: true }; },
 *   });
 *
 * Registered tools get the same treatment as built-ins: scope check, zod
 * validation, audit, the requires-capability listing filter and
 * tools.enabled toggles. `auth.principal` is the calling admin — do your own
 * RBAC checks for anything beyond the capability.
 */
export default (_: { strapi: Core.Strapi }) => ({
  register(def: Parameters<typeof defineTool>[0]): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(def.name)) {
      throw new Error(`[mcp-server] tool name "${def.name}" must match ^[a-z][a-z0-9_]{0,63}$`);
    }
    if (def.name.startsWith('strapi_')) {
      throw new Error('[mcp-server] tool names starting with "strapi_" are reserved');
    }
    if (registered.has(def.name))
      throw new Error(`[mcp-server] tool "${def.name}" is already registered`);
    if (!(ALL_SCOPES as readonly string[]).includes(def.scope)) {
      throw new Error(`[mcp-server] tool "${def.name}": unknown scope ${def.scope}`);
    }
    if (!CAPABILITIES.includes(def.requires)) {
      throw new Error(`[mcp-server] tool "${def.name}": unknown requires ${def.requires}`);
    }
    if (!(def.inputSchema instanceof z.ZodObject) && !('shape' in (def.inputSchema ?? {}))) {
      throw new Error(
        `[mcp-server] tool "${def.name}": inputSchema must be a zod v4 z.object(...)`
      );
    }
    registered.set(def.name, defineTool(def));
  },

  list(): ToolDef[] {
    return [...registered.values()];
  },

  /** Test helper. */
  clear(): void {
    registered.clear();
  },
});
