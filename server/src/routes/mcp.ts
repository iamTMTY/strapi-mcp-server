'use strict';

const policies = [
  'plugin::mcp-server.configured',
  'plugin::mcp-server.origin',
  'plugin::mcp-server.authenticate',
  'plugin::mcp-server.rateLimit',
];

// type: 'admin' + prefix: '' mounts at the host root (no /api prefix). Auth is
// bypassed per-route via `auth: false`; the plugin's authenticate policy
// handles the bearer token.
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
      handler: 'mcp.methodNotAllowed',
      config: { auth: false, policies: ['plugin::mcp-server.configured'] },
    },
    {
      method: 'DELETE',
      path: '/mcp',
      handler: 'mcp.methodNotAllowed',
      config: { auth: false, policies: ['plugin::mcp-server.configured'] },
    },
  ],
};
