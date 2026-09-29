'use strict';

// One-time upload URLs from strapi_media_request_upload. The ticket in the
// path is the credential, so no origin/bearer policies; still 404 when
// unconfigured and rate-limited per IP.
const policies = ['plugin::mcp-server.configured', 'plugin::mcp-server.rateLimit'];

export default {
  type: 'admin' as const,
  prefix: '',
  routes: [
    {
      method: 'GET',
      path: '/mcp/uploads/:ticket',
      handler: 'uploads.form',
      config: { auth: false, policies },
    },
    {
      method: 'POST',
      path: '/mcp/uploads/:ticket',
      handler: 'uploads.receive',
      config: { auth: false, policies },
    },
  ],
};
