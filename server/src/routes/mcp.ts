'use strict';

const policies = ['plugin::mcp-server.origin', 'plugin::mcp-server.authenticate', 'plugin::mcp-server.rateLimit'];

// type: 'admin' + prefix: '' mounts at the host root (no /api prefix). Strapi's
// admin router itself has prefix '', so admin-typed routes with prefix '' land
// at `/<path>` exactly. Auth is bypassed per-route via `auth: false`.
export default {
  type: 'admin' as const,
  prefix: '',
  routes: [
    {
      method: 'POST',
      path: '/mcp',
      handler: 'mcp.handle',
      config: { auth: false, policies },
    },
    {
      method: 'GET',
      path: '/mcp',
      handler: 'mcp.handle',
      config: { auth: false, policies },
    },
    {
      method: 'DELETE',
      path: '/mcp',
      handler: 'mcp.end',
      config: { auth: false, policies },
    },
  ],
};
