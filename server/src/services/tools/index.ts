'use strict';

import type { ToolDef, ToolFactoryArgs } from './content';
import { createContentTools } from './content';
import { createMediaTools } from './media';
import { getConfig } from '../../config';

export type { ToolDef, ToolFactoryArgs };

/**
 * Build the per-session tool list. Filters by:
 *  - granted scopes (a tool whose scope isn't granted is not registered at all)
 *  - master-toggle in config.tools.enabled[name] (default: true)
 */
export function buildToolsForSession(args: ToolFactoryArgs): ToolDef[] {
  const cfg = getConfig(args.strapi);
  const all = [...createContentTools(args), ...createMediaTools(args)];
  return all.filter((t) => {
    if (!args.scopes.includes(t.scope)) return false;
    const toggle = cfg.tools.enabled[t.name];
    return toggle === undefined ? true : toggle;
  });
}
