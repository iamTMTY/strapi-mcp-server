'use strict';

const originPolicy = ['plugin::mcp-server.origin'];

// type: 'admin' + prefix: '' mounts at the host root — required so the
// well-known URLs and /oauth/* paths match what AS metadata advertises.
export default {
  type: 'admin' as const,
  prefix: '',
  routes: [
    {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource',
      handler: 'metadata.protectedResource',
      config: { auth: false, policies: [] },
    },
    {
      method: 'GET',
      path: '/.well-known/oauth-authorization-server',
      handler: 'metadata.authorizationServer',
      config: { auth: false, policies: [] },
    },
    {
      method: 'GET',
      path: '/oauth/jwks',
      handler: 'metadata.jwks',
      config: { auth: false, policies: [] },
    },
    {
      method: 'GET',
      path: '/oauth/authorize',
      handler: 'authorize.start',
      config: { auth: false, policies: originPolicy },
    },
    {
      method: 'POST',
      path: '/oauth/consent',
      handler: 'authorize.consent',
      config: { auth: false, policies: originPolicy },
    },
    {
      method: 'POST',
      path: '/oauth/sso-handoff',
      handler: 'authorize.ssoHandoff',
      config: { auth: false, policies: originPolicy },
    },
    {
      method: 'POST',
      path: '/oauth/token',
      handler: 'token.token',
      config: { auth: false, policies: originPolicy },
    },
    {
      method: 'POST',
      path: '/oauth/revoke',
      handler: 'token.revoke',
      config: { auth: false, policies: originPolicy },
    },
    {
      method: 'POST',
      path: '/oauth/introspect',
      handler: 'introspect.introspect',
      config: { auth: false, policies: [] },
    },
    {
      method: 'POST',
      path: '/oauth/register',
      handler: 'dcr-register.register',
      config: { auth: false, policies: originPolicy },
    },
    // Some MCP clients (Claude Code's SDK is one) fall back to a default
    // `/register` path when DCR metadata is absent. Alias it so the response is
    // a parseable JSON error instead of a plain-text 405 from Koa.
    {
      method: 'POST',
      path: '/register',
      handler: 'dcr-register.register',
      config: { auth: false, policies: originPolicy },
    },
  ],
};
