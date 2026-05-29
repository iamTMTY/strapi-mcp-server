'use strict';

import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';
import { randomBytes } from 'crypto';
import { parseScope, scopeString, isSubsetOf } from '../../services/oauth/scopes';
import { canonicalResourceUrl } from '../../services/oauth/audience';
import { ensureEmbeddedMode } from './mode-guard';

interface AuthorizeQuery {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string;
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

function renderError(ctx: Context, status: number, code: string, description: string): void {
  ctx.status = status;
  ctx.set('Referrer-Policy', 'no-referrer');
  ctx.type = 'text/html';
  ctx.body = `<!doctype html><html><head><title>OAuth error</title></head><body>
    <h1>${htmlEscape(code)}</h1>
    <p>${htmlEscape(description)}</p>
  </body></html>`;
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * GET /oauth/authorize — PKCE S256-only, strict redirect_uri match. Renders
   * a consent screen if the admin has an active SSO cookie; otherwise bounces
   * through the admin login → SsoBridge → back to this endpoint.
   *
   * All validation happens *before* any redirect (open-redirect mitigation).
   */
  async start(ctx: Context): Promise<void> {
    if (!ensureEmbeddedMode(ctx, strapi)) return;
    const q = ctx.query as AuthorizeQuery;
    if (q.response_type !== 'code') {
      return renderError(ctx, 400, 'unsupported_response_type', 'only response_type=code is supported');
    }
    if (!q.client_id) return renderError(ctx, 400, 'invalid_request', 'client_id required');
    if (!q.redirect_uri) return renderError(ctx, 400, 'invalid_request', 'redirect_uri required');
    if (q.code_challenge_method !== 'S256') {
      return renderError(ctx, 400, 'invalid_request', 'code_challenge_method must be S256');
    }
    if (!q.code_challenge || q.code_challenge.length < 43 || q.code_challenge.length > 128) {
      return renderError(ctx, 400, 'invalid_request', 'invalid code_challenge');
    }
    if (!q.state) return renderError(ctx, 400, 'invalid_request', 'state required');
    if (q.resource !== canonicalResourceUrl(strapi)) {
      return renderError(ctx, 400, 'invalid_target', 'resource indicator mismatch');
    }

    const clientsSvc = strapi.plugin('mcp-server').service('clients');
    const client = await clientsSvc.findActive(q.client_id);
    if (!client) return renderError(ctx, 400, 'invalid_request', 'unknown client');
    if (!clientsSvc.isAllowedRedirectUri(client, q.redirect_uri)) {
      return renderError(ctx, 400, 'invalid_request', 'redirect_uri not allowed for this client');
    }

    const requestedScopes = parseScope(q.scope);
    if (requestedScopes.length === 0) {
      return renderError(ctx, 400, 'invalid_scope', 'no valid scopes requested');
    }
    if (!isSubsetOf(requestedScopes, client.scopes)) {
      return renderError(ctx, 400, 'invalid_scope', 'requested scopes exceed client grant');
    }

    // Resource-owner authentication.
    const ssoSvc = strapi.plugin('mcp-server').service('sso-cookie');
    const cookieVal = ctx.cookies.get(ssoSvc.cookieName());
    const adminId = await ssoSvc.verify(cookieVal);
    if (!adminId) {
      const resume = ctx.originalUrl;
      // Set a signed resume cookie as the source of truth. Strapi's AuthPage
      // double-decodes its redirectTo param, which mangles nested OAuth query
      // strings — so we cannot trust the `next=` URL param to survive the
      // login round-trip. The cookie is read back at /oauth/sso-handoff and
      // cleared on success. The URL param remains as best-effort fallback.
      const { value, maxAgeSec } = await ssoSvc.issueResume(resume);
      ctx.cookies.set(ssoSvc.resumeCookieName(), value, {
        httpOnly: true,
        sameSite: 'lax',
        secure: ctx.protocol === 'https',
        maxAge: maxAgeSec * 1000,
        signed: false,
      });
      // Send the user straight to the SsoBridge route. The admin SPA's
      // PrivateRoute will either:
      //   - render SsoBridge immediately if the admin is already logged in, or
      //   - redirect to /admin/auth/login?redirectTo=... and come back here
      //     after login.
      // We DO NOT redirect to /admin/auth/login ourselves — Strapi's AuthPage
      // hard-redirects already-logged-in users to "/" and ignores redirectTo.
      const bridgePath = `/admin/plugins/mcp-server/sso-bridge?next=${encodeURIComponent(resume)}`;
      ctx.redirect(bridgePath);
      return;
    }

    // Optional pre-existing consent (default config disables remember).
    const consentSvc = strapi.plugin('mcp-server').service('consent');
    if (await consentSvc.hasActiveConsent(client.clientId, adminId, requestedScopes)) {
      const code = await issueAuthCode({
        strapi,
        clientId: client.clientId,
        adminUserId: adminId,
        scope: scopeString(requestedScopes),
        redirectUri: q.redirect_uri,
        codeChallenge: q.code_challenge,
        resource: q.resource,
      });
      const target = new URL(q.redirect_uri);
      target.searchParams.set('code', code);
      target.searchParams.set('state', q.state);
      ctx.redirect(target.toString());
      return;
    }

    // Render consent screen with CSRF token bound to SSO cookie.
    const csrf = randomBytes(24).toString('base64url');
    const csrfCookieName = 'mcp_consent_csrf';
    ctx.cookies.set(csrfCookieName, csrf, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.protocol === 'https',
      maxAge: 10 * 60 * 1000,
      signed: false,
    });
    // Use `same-origin` (not `no-referrer`): keeps the Origin header on the
    // form POST to /oauth/consent (same-origin) so our origin policy can verify
    // it, but still strips Referer/Origin on the cross-origin redirect to the
    // client's redirect_uri — so the OAuth `code` does not leak via Referer.
    ctx.set('Referrer-Policy', 'same-origin');
    ctx.set('Cache-Control', 'no-store');
    // Override Strapi's default CSP (form-action 'self') for this response so
    // the browser will follow the cross-origin 302 to the client's redirect_uri
    // after consent. The redirect_uri has already been validated against the
    // client's strict exact-match allowlist, so widening form-action to the
    // specific origin we'll redirect to is safe.
    try {
      const redirectOrigin = new URL(q.redirect_uri).origin;
      ctx.set(
        'Content-Security-Policy',
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; base-uri 'none'; frame-ancestors 'none'`
      );
    } catch {
      /* unreachable — redirect_uri was validated above */
    }
    ctx.type = 'text/html';
    const SCOPE_LABELS = (strapi
      .plugin('mcp-server')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .service('clients') as any).SCOPE_LABELS;
    void SCOPE_LABELS;
    const labels: Record<string, string> = {
      'strapi:content:read': 'Read content (list types, schemas, entries)',
      'strapi:content:write': 'Create and update content entries (draft only)',
      'strapi:media:read': 'List media files',
      'strapi:media:write': 'Upload media files',
    };
    ctx.body = renderConsent({
      clientName: client.clientName,
      scopes: requestedScopes.map((s) => labels[s] ?? s),
      resource: canonicalResourceUrl(strapi),
      csrf,
      hidden: {
        client_id: client.clientId,
        redirect_uri: q.redirect_uri,
        scope: scopeString(requestedScopes),
        state: q.state,
        code_challenge: q.code_challenge,
        code_challenge_method: 'S256',
        resource: q.resource,
      },
    });
  },

  /**
   * POST /oauth/consent — admin approves. Validates CSRF and SSO cookie again,
   * mints an auth code, redirects to the registered redirect_uri.
   */
  async consent(ctx: Context): Promise<void> {
    if (!ensureEmbeddedMode(ctx, strapi)) return;
    ctx.set('Cache-Control', 'no-store');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = ((ctx.request as any).body ?? {}) as Record<string, string>;
    const csrfCookieName = 'mcp_consent_csrf';
    const cookieCsrf = ctx.cookies.get(csrfCookieName);
    if (!cookieCsrf || cookieCsrf !== body.csrf) {
      return renderError(ctx, 403, 'invalid_request', 'CSRF mismatch');
    }
    ctx.cookies.set(csrfCookieName, '', { maxAge: 0 });

    const ssoSvc = strapi.plugin('mcp-server').service('sso-cookie');
    const adminId = await ssoSvc.verify(ctx.cookies.get(ssoSvc.cookieName()));
    if (!adminId) return renderError(ctx, 401, 'invalid_request', 'SSO expired');

    if (body.decision !== 'approve') {
      const target = new URL(body.redirect_uri);
      target.searchParams.set('error', 'access_denied');
      if (body.state) target.searchParams.set('state', body.state);
      ctx.redirect(target.toString());
      return;
    }

    // Re-validate inputs server-side — the form may have been tampered with.
    const clientsSvc = strapi.plugin('mcp-server').service('clients');
    const client = await clientsSvc.findActive(body.client_id);
    if (!client) return renderError(ctx, 400, 'invalid_request', 'unknown client');
    if (!clientsSvc.isAllowedRedirectUri(client, body.redirect_uri)) {
      return renderError(ctx, 400, 'invalid_request', 'redirect_uri not allowed');
    }
    if (body.code_challenge_method !== 'S256' || !body.code_challenge) {
      return renderError(ctx, 400, 'invalid_request', 'bad challenge');
    }
    if (body.resource !== canonicalResourceUrl(strapi)) {
      return renderError(ctx, 400, 'invalid_target', 'resource mismatch');
    }
    const scopes = parseScope(body.scope);
    if (scopes.length === 0 || !isSubsetOf(scopes, client.scopes)) {
      return renderError(ctx, 400, 'invalid_scope', 'scope mismatch');
    }

    const code = await issueAuthCode({
      strapi,
      clientId: client.clientId,
      adminUserId: adminId,
      scope: scopeString(scopes),
      redirectUri: body.redirect_uri,
      codeChallenge: body.code_challenge,
      resource: body.resource,
    });

    await strapi.plugin('mcp-server').service('consent').record(client.clientId, adminId, scopes);

    // Claim DCR-registered clients (no owner) for the first admin to approve
    // consent — the Clients UI surfaces this as "created/connected by".
    if (!client.ownerAdminId) {
      await clientsSvc.setOwner(client.clientId, adminId);
    }

    // Sweep sibling DCR orphans (same name + redirect URIs, no owner, no
    // consent/code/token records). MCP libraries commonly hit /oauth/register
    // multiple times during connect; only the one that reached consent should
    // remain in the Clients table.
    await clientsSvc.purgeOrphansLike({
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUris: client.redirectUris,
    });

    // Audit the consent grant attributed to the approving admin — this is the
    // entry that ties a human identity to the client, since DCR itself is
    // unauthenticated and audits as #anonymous.
    strapi.plugin('mcp-server').service('audit').record({
      ts: new Date(),
      principalType: 'admin',
      principalId: adminId,
      clientId: client.clientId,
      tool: 'oauth.consent.grant',
      params: { scopes, redirectUri: body.redirect_uri },
      resultStatus: 'ok',
      ip: ctx.ip ?? ctx.request.ip,
      userAgent: ctx.request.header['user-agent'] as string | undefined,
    });

    const target = new URL(body.redirect_uri);
    target.searchParams.set('code', code);
    if (body.state) target.searchParams.set('state', body.state);
    ctx.redirect(target.toString());
  },

  /**
   * POST /oauth/sso-handoff — called by the admin-UI SPA bridge after a
   * successful admin login. Body: { adminToken }. Verifies it against
   * strapi.sessionManager('admin').validateAccessToken (Strapi v5's
   * session-aware verifier — `decodeJwtToken` no longer exists), sets the
   * mcp_admin_sso cookie, returns { next }.
   */
  async ssoHandoff(ctx: Context): Promise<void> {
    if (!ensureEmbeddedMode(ctx, strapi)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = ((ctx.request as any).body ?? {}) as { adminToken?: string; next?: string };
    if (!body.adminToken) {
      ctx.status = 400;
      ctx.body = { error: 'missing_admin_token' };
      return;
    }
    let decoded: {
      isValid: boolean;
      payload: { userId?: string | number; sessionId?: string } | null;
    };
    try {
      decoded = strapi
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .sessionManager('admin' as any)
        .validateAccessToken(body.adminToken);
    } catch {
      ctx.status = 401;
      ctx.body = { error: 'invalid_admin_token' };
      return;
    }
    if (!decoded?.isValid || !decoded.payload?.userId || !decoded.payload?.sessionId) {
      ctx.status = 401;
      ctx.body = { error: 'invalid_admin_token' };
      return;
    }
    const principal = await strapi
      .plugin('mcp-server')
      .service('permissions')
      .loadPrincipal(decoded.payload.userId);
    if (!principal) {
      ctx.status = 401;
      ctx.body = { error: 'principal_unavailable' };
      return;
    }
    const ssoSvc = strapi.plugin('mcp-server').service('sso-cookie');
    const { value, maxAgeSec } = await ssoSvc.issue(
      String(decoded.payload.userId),
      decoded.payload.sessionId
    );
    ctx.cookies.set(ssoSvc.cookieName(), value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.protocol === 'https',
      maxAge: maxAgeSec * 1000,
      signed: false,
    });
    // Prefer the signed resume cookie set at /oauth/authorize redirect time —
    // it carries the canonical OAuth URL untouched by Strapi's login flow
    // (which double-decodes its redirectTo param and mangles nested query
    // strings). Fall back to body.next, then the plugin home.
    const resumeFromCookie = await ssoSvc.verifyResume(
      ctx.cookies.get(ssoSvc.resumeCookieName())
    );
    if (resumeFromCookie) {
      ctx.cookies.set(ssoSvc.resumeCookieName(), '', { maxAge: 0, signed: false });
    }
    ctx.body = {
      ok: true,
      next: resumeFromCookie ?? body.next ?? '/admin/plugins/mcp-server',
    };
  },
});

async function issueAuthCode(input: {
  strapi: Core.Strapi;
  clientId: string;
  adminUserId: string;
  scope: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
}): Promise<string> {
  return input.strapi.plugin('mcp-server').service('auth-codes').issue({
    clientId: input.clientId,
    adminUserId: input.adminUserId,
    scope: input.scope,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    resource: input.resource,
  });
}

function renderConsent(opts: {
  clientName: string;
  scopes: string[];
  resource: string;
  csrf: string;
  hidden: Record<string, string>;
}): string {
  const hiddenInputs = Object.entries(opts.hidden)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}" />`
    )
    .join('\n');
  const scopes = opts.scopes.map((s) => `<li>${htmlEscape(s)}</li>`).join('');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Authorize MCP client</title>
<meta name="referrer" content="same-origin" />
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 540px; margin: 60px auto; color: #1f1f1f; }
  h1 { font-size: 20px; }
  .client { font-weight: 600; }
  ul { background: #f6f6f7; padding: 16px 16px 16px 32px; border-radius: 6px; }
  button { padding: 10px 18px; font-size: 14px; border-radius: 4px; cursor: pointer; }
  .approve { background: #4945ff; color: #fff; border: 0; margin-right: 8px; }
  .deny { background: #fff; border: 1px solid #d0d0d0; color: #1f1f1f; }
  .resource { color: #666; font-size: 13px; }
</style>
</head>
<body>
  <h1>Authorize <span class="client">${htmlEscape(opts.clientName)}</span></h1>
  <p>This MCP client is requesting the following permissions on <code class="resource">${htmlEscape(opts.resource)}</code>:</p>
  <ul>${scopes}</ul>
  <form method="POST" action="/oauth/consent">
    ${hiddenInputs}
    <input type="hidden" name="csrf" value="${htmlEscape(opts.csrf)}" />
    <button class="approve" type="submit" name="decision" value="approve">Approve</button>
    <button class="deny" type="submit" name="decision" value="deny">Deny</button>
  </form>
</body>
</html>`;
}
