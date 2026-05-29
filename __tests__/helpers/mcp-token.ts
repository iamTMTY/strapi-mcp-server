'use strict';

import { request } from 'undici';
import { TEST_BASE_URL } from './test-server';
import { adminFetch, ensureAdmin } from './admin-api';

/**
 * Mint an MCP access token for the seeded admin without going through the
 * browser-based OAuth dance.
 *
 * The seeded admin's id is read from `/admin/users/me`. Then we create a
 * confidential MCP client via the plugin's admin API, run the PKCE flow
 * server-to-server (we already have a valid `mcp_admin_sso` cookie because
 * we go through `/oauth/sso-handoff` with our admin JWT), and exchange the
 * resulting code for a token.
 *
 * Returns the bearer token + the session id we'll use in subsequent calls.
 */
export interface MintResult {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  adminId: number;
  adminJwt: string;
}

export async function mintMcpToken(): Promise<MintResult> {
  const { token: adminJwt, user } = await ensureAdmin();

  // Create a confidential client via the plugin's admin API.
  const clientResp = await adminFetch('/mcp-server/clients', {
    method: 'POST',
    token: adminJwt,
    body: {
      clientName: 'integration-test-client',
      redirectUris: ['http://localhost/callback'],
      scopes: [
        'strapi:content:read',
        'strapi:content:write',
        'strapi:media:read',
        'strapi:media:write',
      ],
      isConfidential: true,
    },
  });
  if (clientResp.status !== 201 && clientResp.status !== 200) {
    throw new Error(`create client failed: ${clientResp.status} ${JSON.stringify(clientResp.body)}`);
  }
  const createdClient = clientResp.body as {
    client: { clientId: string };
    clientSecret: string;
  };
  if (!createdClient.client?.clientId) {
    throw new Error(
      `create client returned unexpected shape: ${JSON.stringify(clientResp.body)}`
    );
  }
  const clientId = createdClient.client.clientId;
  const clientSecret = createdClient.clientSecret;

  // Establish mcp_admin_sso cookie via the sso-handoff endpoint.
  const ssoResp = await request(`${TEST_BASE_URL}/oauth/sso-handoff`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: TEST_BASE_URL,
    },
    body: JSON.stringify({ adminToken: adminJwt, next: '/admin/plugins/mcp-server' }),
  });
  if (ssoResp.statusCode !== 200 && ssoResp.statusCode !== 302) {
    const text = await ssoResp.body.text();
    throw new Error(`sso-handoff failed: ${ssoResp.statusCode} ${text}`);
  }
  const setCookie = ssoResp.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie)
    ? setCookie.map((c) => c.split(';')[0]).join('; ')
    : (setCookie ?? '');

  // Generate PKCE pair.
  const { createHash, randomBytes } = await import('crypto');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(8).toString('base64url');

  // Hit /oauth/authorize with the SSO cookie attached — the plugin renders the
  // consent page (HTML), but we don't need to "click approve" because we POST
  // directly to /oauth/consent with the CSRF token from the rendered form.
  const redirectUri = 'http://localhost/callback';
  const authorizeUrl = new URL(`${TEST_BASE_URL}/oauth/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', 'strapi:content:read strapi:content:write strapi:media:read strapi:media:write');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('resource', `${TEST_BASE_URL}/mcp`);
  const authResp = await request(authorizeUrl.toString(), {
    method: 'GET',
    headers: { cookie: cookieHeader, origin: TEST_BASE_URL },
  });
  const authHtml = await authResp.body.text();
  if (authResp.statusCode !== 200) {
    throw new Error(`authorize failed: ${authResp.statusCode} ${authHtml.slice(0, 500)}`);
  }
  // The consent screen sets a `mcp_consent_csrf` cookie that must round-trip
  // alongside the form's `csrf` field. Merge the new Set-Cookie values onto
  // the existing cookie header.
  const consentSetCookie = authResp.headers['set-cookie'];
  const consentCookies = Array.isArray(consentSetCookie)
    ? consentSetCookie.map((c) => c.split(';')[0]).join('; ')
    : consentSetCookie
      ? (consentSetCookie as string).split(';')[0]
      : '';
  const fullCookieHeader = [cookieHeader, consentCookies].filter(Boolean).join('; ');
  const csrfMatch = authHtml.match(/name="csrf"\s+value="([^"]+)"/);
  if (!csrfMatch) {
    throw new Error(`csrf token not found in consent page; got:\n${authHtml.slice(0, 500)}`);
  }
  const csrf = csrfMatch[1];

  // POST consent with the CSRF + our params — the response is a 302 to
  // redirect_uri with code= and state= attached.
  const consentBody = new URLSearchParams({
    csrf,
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'strapi:content:read strapi:content:write strapi:media:read strapi:media:write',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${TEST_BASE_URL}/mcp`,
    decision: 'approve',
  });
  const consentResp = await request(`${TEST_BASE_URL}/oauth/consent`, {
    method: 'POST',
    headers: {
      cookie: fullCookieHeader,
      'content-type': 'application/x-www-form-urlencoded',
      origin: TEST_BASE_URL,
    },
    body: consentBody.toString(),
  });
  if (consentResp.statusCode !== 302) {
    const text = await consentResp.body.text();
    throw new Error(`consent did not redirect: ${consentResp.statusCode} ${text.slice(0, 500)}`);
  }
  const location = consentResp.headers.location as string;
  const codeMatch = /[?&]code=([^&]+)/.exec(location);
  if (!codeMatch) {
    throw new Error(`no code in redirect: ${location}`);
  }
  const code = decodeURIComponent(codeMatch[1]);

  // Exchange code for a token.
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: verifier,
    resource: `${TEST_BASE_URL}/mcp`,
  });
  const tokenResp = await request(`${TEST_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: TEST_BASE_URL,
    },
    body: tokenBody.toString(),
  });
  if (tokenResp.statusCode !== 200) {
    const text = await tokenResp.body.text();
    throw new Error(`token exchange failed: ${tokenResp.statusCode} ${text}`);
  }
  const tok = (await tokenResp.body.json()) as { access_token: string; refresh_token: string };

  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    clientId,
    clientSecret,
    adminId: user.id,
    adminJwt,
  };
}
