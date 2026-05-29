'use strict';

// Internal cluster-peer endpoint. Bypasses origin/auth/rate-limit policies;
// the proxy controller validates the HMAC on `X-MCP-Proxy-Auth` and dispatches
// directly into a local session. Mounted at root, not under /api.
export default {
  type: 'admin' as const,
  prefix: '',
  routes: [
    {
      method: 'POST',
      path: '/__mcp/proxy/:sessionId',
      handler: 'proxy.receive',
      config: { auth: false, policies: [] },
    },
    {
      method: 'GET',
      path: '/__mcp/proxy/:sessionId',
      handler: 'proxy.receive',
      config: { auth: false, policies: [] },
    },
    {
      method: 'DELETE',
      path: '/__mcp/proxy/:sessionId',
      handler: 'proxy.receive',
      config: { auth: false, policies: [] },
    },
  ],
};
