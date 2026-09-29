'use strict';

import type { Core } from '@strapi/strapi';

export async function destroy({ strapi }: { strapi: Core.Strapi }): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rt = (strapi as any).__mcpServerRuntime;
  if (rt?.auditTimer) clearInterval(rt.auditTimer);

  try {
    await strapi.plugin('mcp-server').service('redis').disconnect();
  } catch (err) {
    strapi.log.warn(`[mcp-server] redis disconnect: ${(err as Error).message}`);
  }
}
