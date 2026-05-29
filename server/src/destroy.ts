'use strict';

import type { Core } from '@strapi/strapi';

export async function destroy({ strapi }: { strapi: Core.Strapi }): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rt = (strapi as any).__mcpServerRuntime;
  if (rt?.sweepTimer) clearInterval(rt.sweepTimer);
  if (rt?.auditTimer) clearInterval(rt.auditTimer);

  try {
    strapi.plugin('mcp-server').service('heartbeat').stop();
  } catch (err) {
    strapi.log.warn(`[mcp-server] heartbeat stop: ${(err as Error).message}`);
  }

  try {
    await strapi.plugin('mcp-server').service('session-store').closeAll();
  } catch (err) {
    strapi.log.error('[mcp-server] failed to close sessions on destroy', err as Error);
  }

  try {
    await strapi.plugin('mcp-server').service('redis').disconnect();
  } catch (err) {
    strapi.log.warn(`[mcp-server] redis disconnect: ${(err as Error).message}`);
  }
}
