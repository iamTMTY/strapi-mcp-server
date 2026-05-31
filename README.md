# strapi-mcp-server

Expose a Strapi v5 instance as a **Model Context Protocol** (MCP) server. AI clients (Claude Code, Claude web, Cursor, Codex, opencode, Continue, etc.) authenticate via **OAuth 2.1 + PKCE** and then call tools to browse content-types, read entries, create/update drafts, list media, and upload files — all governed by Strapi's existing role-based permissions.

> Security posture: default-deny, disabled-by-default, full audit log, short-lived access tokens with rotating refresh tokens, family invalidation on reuse, mandatory PKCE S256, strict redirect-URI allowlists, Origin/Host validation, rate limiting.

## Table of contents

- [Quick setup](#quick-setup)
- [Configuration reference](#configuration-reference)
- [External AS mode](#external-as-mode)
- [Endpoints](#endpoints)
- [Tools](#tools)
- [Use cases](#use-cases)
- [Horizontal scale](#horizontal-scale)

## Quick setup

By default, clients connect with a pre-registered `client_id` + `client_secret` that you create in the Strapi admin UI. All major AI clients (Claude Code, Claude web, Codex via `mcp-remote`, opencode, Cursor) support this. The `client_secret` protects refresh tokens: if a refresh token ever leaks, it can't be used to mint new access tokens without the secret.

If you'd rather skip the manual client creation step, enable Dynamic Client Registration (DCR) so clients self-register on first connect — see [step 3](#3-optional-create-a-confidential-client) for how.

### 1. Install

```sh
npm install strapi-mcp-server
```

### 2. Enable the plugin

In `config/plugins.ts` (or `.js`):

```ts
export default ({ env }) => ({
  'mcp-server': {
    enabled: true,
    config: {
      enabled: true,
      resourceUrl: env('MCP_RESOURCE_URL', 'http://localhost:1337/mcp'),
      allowedOrigins: env.array('MCP_ALLOWED_ORIGINS', ['http://localhost:1337']),
    },
  },
});
```

Restart Strapi.

### 3. (Optional) Create a confidential client

Skip this step only if you've enabled DCR (`oauth: { dcr: { enabled: true } }` in step 2's config) and want clients to self-register on first connect. Otherwise, do this once:

1. Open Strapi admin → **MCP Server → Clients → New client**
2. **Name**: anything (e.g. `Claude Code — my-laptop`)
3. **Redirect URIs**: leave blank — defaults to `http://localhost/callback` and accepts any loopback port (per RFC 8252 §7.3). Only fill in for non-loopback web clients.
4. **Confidential**: tick "Generate client secret" → **Save**
5. Copy the **Client ID** and **Client Secret** on the next screen. The secret is shown once.

You'll plug those values into your AI client in the next step.

### 4. Connect your AI client

Each client speaks the same MCP Streamable HTTP transport. Pick the subsection for your client below and paste in the credentials from step 3. If you skipped step 3 (DCR mode), omit the credential block — each example notes which block to drop.

#### 4.1 Claude Code

```sh
claude mcp add --transport http --scope user strapi http://localhost:1337/mcp \
  --client-id <CLIENT_ID> \
  --client-secret
```

`--client-secret` prompts for the secret (or set `MCP_CLIENT_SECRET` in your env to skip the prompt). To use DCR instead, drop the last two flags.

Docs: [Claude Code MCP](https://docs.claude.com/en/docs/claude-code/mcp)

#### 4.2 Claude web (claude.ai)

Needs a public HTTPS URL — `claude.ai` can't reach `localhost`. Tunnel with `ngrok`, `cloudflared`, or `tailscale funnel`, set `resourceUrl` and `allowedOrigins` to the public hostname, restart Strapi. Then in **claude.ai → Settings → Connectors → Add connector**, paste the URL. For pre-registered credentials, expand **Advanced settings** in the dialog and fill in **OAuth Client ID** + **OAuth Client Secret**.

Docs: [Anthropic custom connectors](https://support.anthropic.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)

#### 4.3 Codex CLI

`~/.codex/config.toml`. Codex doesn't speak HTTP transports natively — [`mcp-remote`](https://github.com/geelen/mcp-remote) bridges stdio↔HTTP. Pass `--static-oauth-client-info` for pre-registered credentials:

```toml
[mcp_servers.strapi]
command = "npx"
args = [
  "-y",
  "mcp-remote",
  "http://localhost:1337/mcp",
  "--static-oauth-client-info",
  "{\"client_id\":\"<CLIENT_ID>\",\"client_secret\":\"<CLIENT_SECRET>\"}"
]
```

Drop the last two args to use DCR.

Docs: [mcp-remote static client info](https://github.com/geelen/mcp-remote#static-oauth-client-information)

#### 4.4 opencode

`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "strapi": {
      "type": "remote",
      "url": "http://localhost:1337/mcp",
      "enabled": true,
      "oauth": {
        "clientId": "{env:MCP_CLIENT_ID}",
        "clientSecret": "{env:MCP_CLIENT_SECRET}",
        "scope": "strapi:content:read strapi:content:write strapi:media:read strapi:media:write"
      }
    }
  }
}
```

Omit the `oauth` block to use DCR.

Docs: [opencode MCP OAuth](https://opencode.ai/docs/mcp-servers/#oauth)

#### 4.5 Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "strapi": {
      "url": "http://localhost:1337/mcp",
      "auth": {
        "CLIENT_ID": "<CLIENT_ID>",
        "CLIENT_SECRET": "<CLIENT_SECRET>",
        "scopes": [
          "strapi:content:read",
          "strapi:content:write",
          "strapi:media:read",
          "strapi:media:write"
        ]
      }
    }
  }
}
```

Omit the `auth` block to use DCR.

Docs: [Cursor static OAuth](https://cursor.com/docs/mcp#static-oauth-for-remote-servers)

### 5. Authorize

Trigger the connection (e.g. for Claude Code: `claude` → `/mcp` → pick **strapi**). A browser opens to your Strapi admin login (if not already signed in), then a consent screen lists the client name + requested scopes. Click Approve. From this point your AI client can call MCP tools against your Strapi.

That's it. The rest of this README is reference material.

### Notes that apply to every client

- Non-localhost targets require HTTPS, and the URL must be listed in `allowedOrigins`.
- Access tokens are short-lived (10 min default). Refresh is automatic via the rotating refresh token.
- To force re-auth, delete the client from **MCP Server → Clients** in the Strapi admin — this revokes its tokens and sessions.

## Configuration reference

Every option, its default, and what it controls. All keys go under the plugin's `config: { ... }` block.

### Top-level

| Option           | Type       | Default    | Description                                                                                                                                                  |
| ---------------- | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`        | `boolean`  | `false`    | Master switch. Must be `true` for the plugin to mount routes.                                                                                                |
| `resourceUrl`    | `string`   | _required_ | Canonical public URL of `/mcp` (e.g. `https://cms.example.com/mcp`). Used as JWT `aud` and to compute the OAuth issuer.                                      |
| `allowedOrigins` | `string[]` | _required_ | Origins permitted to call `/mcp` and `/oauth/*` from a browser. CLI clients fall back to a Host check against `resourceUrl`. `'*'` is refused in production. |

### OAuth (`oauth.*`)

| Option                            | Type                       | Default                | Description                                                                                                                                                                                                                                                       |
| --------------------------------- | -------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth.mode`                      | `'embedded' \| 'external'` | `'embedded'`           | `embedded` runs the OAuth Authorization Server inside the plugin. `external` delegates to an existing IdP — see below.                                                                                                                                            |
| `oauth.accessTokenTtlSec`         | `number` (60–3600)         | `600`                  | Access-token JWT lifetime.                                                                                                                                                                                                                                        |
| `oauth.refreshTokenTtlSec`        | `number` (≥300)            | `86400`                | Refresh-token lifetime. Tokens rotate on every use; reuse triggers family-wide revocation.                                                                                                                                                                        |
| `oauth.authCodeTtlSec`            | `number` (10–600)          | `60`                   | Authorization-code lifetime.                                                                                                                                                                                                                                      |
| `oauth.ssoCookieTtlSec`           | `number`                   | `900`                  | TTL of the cookie that ties an admin-login session to the OAuth consent screen.                                                                                                                                                                                   |
| `oauth.dcr.enabled`               | `boolean`                  | `false`                | Allow `POST /oauth/register` so MCP clients self-register on first connect. Off by default — admins create clients manually via the Clients page and inject `client_id` + `client_secret` into the AI client. Turn on if you want clients to register themselves. |
| `oauth.dcr.ratelimitPerHour`      | `number`                   | `60`                   | Max successful DCR registrations per IP per hour when DCR is enabled.                                                                                                                                                                                             |
| `oauth.consent.rememberDays`      | `number`                   | `0`                    | Skip the consent prompt for `rememberDays` once the same admin/client/scope tuple has been approved. `0` = always prompt.                                                                                                                                         |
| `oauth.introspection.allowedIps`  | `string[]`                 | `['127.0.0.1', '::1']` | IPs allowed to call `POST /oauth/introspect`. Loopback by default.                                                                                                                                                                                                |
| `oauth.external.issuer`           | `string`                   | —                      | External AS issuer (required when `mode: 'external'`). Must match the `iss` claim.                                                                                                                                                                                |
| `oauth.external.jwksUri`          | `string`                   | —                      | External AS JWKS URL.                                                                                                                                                                                                                                             |
| `oauth.external.adminLookupClaim` | `string`                   | `'email'`              | JWT claim used to resolve the user to a Strapi admin. Supports `'email'` or `'username'`.                                                                                                                                                                         |
| `oauth.external.enforceScopes`    | `boolean`                  | `false`                | Require `strapi:*` scopes in the JWT. Off by default so IdP setup stays portable.                                                                                                                                                                                 |

### Sessions, rate limit, uploads, audit, tools

| Option                                | Type       | Default                     | Description                                                                   |
| ------------------------------------- | ---------- | --------------------------- | ----------------------------------------------------------------------------- |
| `session.idleTtlMs`                   | `number`   | `1_800_000` (30 min)        | Evict session after this idle window.                                         |
| `session.hardTtlMs`                   | `number`   | `86_400_000` (24 h)         | Evict session this long after creation, regardless of activity.               |
| `session.maxPerPrincipal`             | `number`   | `10`                        | Per-admin cap. Oldest evicted when exceeded.                                  |
| `session.maxTotal`                    | `number`   | `1000`                      | Process-wide cap. New `initialize` returns 503 when reached.                  |
| `rateLimit.perPrincipal.capacity`     | `number`   | `60`                        | Burst per admin.                                                              |
| `rateLimit.perPrincipal.refillPerSec` | `number`   | `1`                         | Steady-state requests/sec per admin.                                          |
| `rateLimit.perIp.capacity`            | `number`   | `120`                       | Burst per IP.                                                                 |
| `rateLimit.perIp.refillPerSec`        | `number`   | `2`                         | Steady-state requests/sec per IP.                                             |
| `upload.maxBytes`                     | `number`   | `10_485_760`                | Max upload size (10 MB).                                                      |
| `upload.mimeAllowlist`                | `string[]` | (png, jpeg, webp, gif, pdf) | Accepted MIME types.                                                          |
| `upload.allowSvg`                     | `boolean`  | `false`                     | Off because SVGs can carry XSS payloads.                                      |
| `audit.retentionDays`                 | `number`   | `90`                        | Daily cron deletes entries older than this.                                   |
| `audit.redactKeyPatterns`             | `string[]` | (password, token, …)        | Object keys whose values are replaced with `[redacted]` before being written. |
| `tools.enabled[<toolName>]`           | `boolean`  | `true`                      | Per-tool master switch. See [Tools](#tools).                                  |

### Redis (`redis.*`, optional)

For single-instance deployments, leave this section out. For multi-instance, point the plugin at Redis so rate limits, sessions, and revocation events are cluster-wide. See [Horizontal scale](#horizontal-scale) for deployment shapes.

| Option                      | Type      | Default                 | Description                                                                                                                           |
| --------------------------- | --------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `redis.enabled`             | `boolean` | `false`                 | When `true`, shared state lives in Redis.                                                                                             |
| `redis.url`                 | `string`  | _required when enabled_ | `redis://` or `rediss://` connection string.                                                                                          |
| `redis.keyPrefix`           | `string`  | `'mcp:'`                | Prefix on every Redis key the plugin writes.                                                                                          |
| `redis.instanceId`          | `string`  | _auto_                  | Override the auto-generated instance id. Set to a K8s pod name when you want logs to match the pod name.                              |
| `redis.internalAddress`     | `string`  | _unset_                 | Private URL where peer instances can reach this one (e.g. `http://10.0.0.5:1337`). Setting this enables session routing.              |
| `redis.internalSecret`      | `string`  | _required with above_   | ≥ 32-char shared secret used to sign cross-instance proxy requests. `openssl rand -hex 32` and inject same value into every instance. |
| `redis.heartbeatIntervalMs` | `number`  | `10000`                 | How often each instance refreshes its liveness key.                                                                                   |
| `redis.heartbeatTtlMs`      | `number`  | `30000`                 | TTL of the liveness key. Must be > intervalMs.                                                                                        |

## External AS mode

Delegate authentication to an existing OAuth 2.1 / OIDC provider (Auth0, Keycloak, Okta, etc.). The plugin acts purely as a resource server: verifies tokens issued by your IdP, runs tools under the matching Strapi admin identity. The embedded `/oauth/*` endpoints are disabled.

### When to use it

- Your org has SSO and you want MCP traffic to obey the same policies (MFA, lifecycle, off-boarding).
- You don't want this plugin storing OAuth state (clients, refresh tokens, signing keys).

### Configuration

```ts
oauth: {
  mode: 'external',
  external: {
    issuer: env('MCP_EXTERNAL_ISSUER'),       // e.g. https://your-tenant.auth0.com/
    jwksUri: env('MCP_EXTERNAL_JWKS_URI'),    // e.g. https://your-tenant.auth0.com/.well-known/jwks.json
    adminLookupClaim: 'email',                // or 'username'
  },
},
```

Boot validator refuses to start without both `issuer` and `jwksUri`.

### How requests are authenticated

1. MCP client calls `/mcp` with `Authorization: Bearer <token>` issued by your IdP.
2. Plugin fetches your IdP's JWKS, verifies signature + `iss` + `exp`.
3. Reads the configured claim from the JWT (`email` by default) and looks up an active `admin::user` matching that value.
4. If found, request proceeds under that admin's RBAC. Otherwise `401 invalid_token`.

Provision Strapi admin users ahead of time matching the IdP identities you want to allow.

### Scopes

With `enforceScopes: false` (default), a verified JWT is granted the full tool surface — your IdP gates authentication, Strapi RBAC + per-tool toggles gate authorization. Set `true` only if you've defined `strapi:*` scopes as Client Scopes in your IdP.

### Common IdP quirks

- **Audience**: external mode doesn't check `aud` by default.
- **`email` claim**: some IdPs require requesting the `email` scope. Make sure your client asks for it.
- **Tenant-scoped issuers**: Auth0 includes a trailing slash on `iss`; AWS Cognito doesn't. `external.issuer` must match the JWT's `iss` byte-for-byte.

### Keycloak walkthrough (validated)

Quickest local test path. Other IdPs (Auth0, Okta, Entra ID, Cognito) work in principle but aren't documented step-by-step.

```sh
docker run --name keycloak -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:latest start-dev
```

In Keycloak admin (`admin`/`admin` at http://localhost:8080):

1. **Create realm** `mcp-test`. Under **Authentication → Required actions**, toggle every "Default Action" off (avoids "account not fully set up" warnings during testing).
2. **Clients → Create client** `mcp-test-client` with **Client authentication ON** (confidential) and **Standard flow ON**. Valid redirect URIs: `http://localhost:33418/callback` (Keycloak requires an exact port here — pin Claude Code's callback to match in step 5). On the **Credentials** tab, copy the **Client secret** — save it.
3. **Users → Add user**. Email must match a real Strapi admin's email. **Email verified ON**. **Credentials → Set password** (uncheck Temporary).
4. Point the plugin at Keycloak:

   ```js
   oauth: {
     mode: 'external',
     external: {
       issuer: 'http://localhost:8080/realms/mcp-test',
       jwksUri: 'http://localhost:8080/realms/mcp-test/protocol/openid-connect/certs',
     },
   },
   ```

   Restart Strapi. `curl http://localhost:1337/.well-known/oauth-protected-resource` should show your Keycloak realm as the authorization_server.

5. Connect Claude Code (Keycloak doesn't allow anonymous DCR; use the pre-registered client):

   ```sh
   claude mcp add --transport http --scope user strapi http://localhost:1337/mcp \
     --client-id mcp-test-client \
     --client-secret \
     --callback-port 33418
   ```

   In `~/.claude.json`, pin the scopes on the `strapi` entry to avoid Keycloak rejecting unknown realm scopes:

   ```json
   "oauth": { "clientId": "mcp-test-client", "callbackPort": 33418, "scopes": "openid email" }
   ```

   `claude` → `/mcp` → pick **strapi**. Sign in as your Keycloak user, approve consent, done.

**Production hardening**: use HTTPS everywhere, re-enable required actions on your realm, use a real DB backend instead of `start-dev`, and tighten realm session and access-token TTLs.

## Endpoints

| Path                                          | Purpose                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `POST/GET/DELETE /mcp`                        | MCP Streamable HTTP transport                                              |
| `GET /.well-known/oauth-protected-resource`   | RFC 9728                                                                   |
| `GET /.well-known/oauth-authorization-server` | RFC 8414                                                                   |
| `GET /oauth/authorize`                        | PKCE authorization endpoint (S256 only)                                    |
| `POST /oauth/token`                           | Token endpoint (`authorization_code` + `refresh_token` grants)             |
| `POST /oauth/revoke`                          | RFC 7009                                                                   |
| `POST /oauth/introspect`                      | RFC 7662 (loopback-only by default)                                        |
| `POST /oauth/register`                        | RFC 7591 Dynamic Client Registration (only when `oauth.dcr.enabled: true`) |
| `GET /oauth/jwks`                             | Public JWKS                                                                |

The plugin reserves `/mcp`, `/.well-known/oauth-*`, `/oauth/*`, and `/register` at the app root.

## Tools

| Tool                                       | Scope                  |
| ------------------------------------------ | ---------------------- |
| `strapi.content.list_types`                | `strapi:content:read`  |
| `strapi.content.get_schema`                | `strapi:content:read`  |
| `strapi.content.list_entries`              | `strapi:content:read`  |
| `strapi.content.get_entry`                 | `strapi:content:read`  |
| `strapi.content.create_entry` (draft only) | `strapi:content:write` |
| `strapi.content.update_entry` (draft only) | `strapi:content:write` |
| `strapi.media.list`                        | `strapi:media:read`    |
| `strapi.media.upload`                      | `strapi:media:write`   |

Delete, publish/unpublish, and user/role management are deliberately omitted. Every tool re-checks its scope and the Strapi RBAC permission at call time.

## Use cases

Practical prompts you can paste into any connected AI client. Two ground rules apply to every example:

- **Every entry the AI creates or updates lands as a draft.** Publishing stays a human action in the Strapi UI — by design, no publish tool is exposed.
- **The AI sees exactly what your role sees.** Same Strapi RBAC the Content Manager uses. If your role can't read a content type, neither can the AI talking through your token.

### Analyze (read-only)

**Tour my content model.** The AI walks the schema for every type you can read and gives you a human map.

> Walk me through every content type in my Strapi. For each, summarize what it represents, list its fields and types, and flag anything under-specified (missing meta description, no slug field, no relations).

**Editorial audit.** Scan content for problems without changing anything.

> Audit all published Articles. Tell me which are missing a meta description, have a body under 300 words, lack a featured image, or use a tag we no longer use [list of deprecated tags]. Group your findings by author.

**Find duplicates and near-duplicates.** Cross-entry comparison the AI is naturally good at; tedious manually.

> Look at all Articles tagged `product-update`. Cluster ones that cover the same release or feature so I can decide whether to merge, redirect, or unpublish. Show the documentIds for each cluster.

**Cross-type relationship mapping.** Uses `populate` to walk relations — hard to do in the UI.

> For our top 10 Products (by `popularity`), find every Article that mentions them. Build me a table: product, article count, sample titles, last-mention date.

**Locale gap report.** Find entries that should have been translated but weren't.

> For every published Article in English, check whether a French version exists. Give me the list of slugs that are English-only, sorted by publish date so I can prioritize.

**Tag taxonomy hygiene.** Find semantic duplicates humans gloss over.

> Look at every tag used across Articles. Group ones that probably mean the same thing (e.g. `ai`, `AI`, `artificial-intelligence`). Recommend a canonical form for each cluster.

**Image hygiene.** Uses `media.list`. Surfaces issues humans don't track.

> Audit our media library. Find images with no alt text, oversized images (>2 MB), or images uploaded > 1 year ago that aren't referenced by any Article. Don't delete anything — just report.

**Content brief from existing material.** Synthesize a brief out of what's already published before you write something new.

> I want to write a new pillar article on "edge caching." Before I start, find the 5 most relevant existing Articles and Products, summarize what we've already said, identify gaps we haven't covered, and suggest a structure that doesn't duplicate existing content.

### Create (drafts)

**Bulk-create from an outline.** Turn one prompt + outline into N drafts. Beats clicking "New entry" 30 times.

> Here are 12 article ideas for our Q3 content calendar [paste list]. For each, create a draft Article with a title, slug, 60-word excerpt, and a 300-word first-draft body. Tag them with `editorial-todo` so I can find them.

**Translate / localize a batch.** AI reads the English version, creates a draft for each in another locale, preserves slug and structure.

> Find the 20 most recently updated English Articles. For each, create a French draft preserving the same slug, structure, and tone. Don't publish — I'll review in Strapi.

**Generate A/B variants.** Draft variants for testing.

> For Article `<documentId>`, create two draft variants of the headline + lead paragraph — one more curiosity-driven, one more direct. Keep the body unchanged. Use the slug pattern `<slug>-variant-a` and `<slug>-variant-b`.

**Stub the rest of a new content type.** Uses `get_schema` to understand fields, then fills realistic placeholders.

> I just created a new content type called `case-study`. Read its schema, then create 5 stub drafts so I can see how a populated listing page would look. Use realistic-sounding company names but obviously-fake numbers.

### Update (drafts)

**Bulk fix a consistent mistake.** Find-and-update across the catalog without writing a script.

> Every Article that references our old product name "Foo" should be updated to use "Bar." Don't change the meaning of any sentence — just swap the name and any obvious derivatives (URLs, headings, CTAs). Update them as drafts so I can review.

**Missing-field backfill.** AI generates the missing piece _from_ the existing content. Especially useful for SEO fields.

> Find every published Article missing a meta description. For each, draft a 150-character meta description based on the body. Update the entries as drafts.

**Editorial style normalization.** Rewrites for tone consistency without changing semantics.

> Our older Articles (published before 2024) used a more formal voice. Pick 5 of them, rewrite the intros to match our current conversational style guide [paste guide]. Save as drafts — same documentId, just an updated draft revision.

## Horizontal scale

For single-instance deployments, the plugin works as-is. For multi-instance, pick one of three shapes.

### Why session routing isn't trivial

An MCP session over Streamable HTTP includes a live TCP connection on the process that handled `initialize`. That connection can't move between processes. So a request with `Mcp-Session-Id: X` must land on the instance that owns X, or be forwarded there.

### Three shapes

**1. Single instance.** One Strapi process. Default. Zero infra. Doesn't scale; doesn't survive a process restart.

**2. Sticky load balancer.** N Strapi processes behind an LB that hashes on `Mcp-Session-Id` (HAProxy, nginx, envoy — not AWS ALB). Same plugin config as single-instance. Per-instance rate limits, so a single user can burst `N × capacity`.

```nginx
upstream mcp_backends {
  hash $http_mcp_session_id consistent;
  server strapi-1:1337;
  server strapi-2:1337;
}
server {
  location / {
    proxy_pass http://mcp_backends;
    proxy_http_version 1.1;
    proxy_buffering off;          # SSE
    proxy_read_timeout 3600s;
  }
}
```

**3. Redis-routed.** N processes share a Redis. Each process registers its sessions in a directory; a request that lands on the wrong process is forwarded over HTTP to the owner. Cluster-wide rate limits via Lua-atomic Redis. Cluster-wide revocation via pub/sub. Heartbeats turn dead-owner cases into clean 404 re-init instead of 502.

```ts
redis: {
  enabled: true,
  url: env('MCP_REDIS_URL'),
  internalAddress: env('MCP_INTERNAL_ADDRESS'),  // private URL of THIS instance
  internalSecret: env('MCP_INTERNAL_SECRET'),    // openssl rand -hex 32; same across instances
},
```

### Decision matrix

|                                    | Single | Sticky LB                  | Redis-routed |
| ---------------------------------- | ------ | -------------------------- | ------------ |
| Strapi processes                   | 1      | N                          | N            |
| Extra infrastructure               | none   | LB with consistent hashing | Redis        |
| AWS ALB compatible                 | n/a    | ❌                         | ✅           |
| Auto-scaling friendly              | ❌     | partial                    | ✅           |
| Rate limits cluster-wide           | n/a    | ❌                         | ✅           |
| Revocation propagates cluster-wide | n/a    | ❌                         | ✅           |
| Extra hop on cross-instance call   | n/a    | 0                          | ~3-10 ms     |

### Operational checklist for Redis-routed deploys

- `redis.url` points at a managed/monitored Redis. The plugin treats it as load-bearing — outage breaks routing.
- `redis.internalSecret` is ≥ 32 chars from `openssl rand -hex 32`, same on every instance, injected via secret manager.
- `redis.internalAddress` is the **private** address peers can reach (VPC IP, K8s service DNS) — not the public LB hostname.
- LB forwards `Authorization`, `Mcp-Session-Id`, `Origin`, `Accept`, `Content-Type` unmodified.
- LB disables response buffering and uses a long read timeout (`proxy_buffering off; proxy_read_timeout 3600s;`).
- `MCP_RESOURCE_URL` and `MCP_ALLOWED_ORIGINS` are identical on every instance.
- `heartbeatTtlMs` > 3× `heartbeatIntervalMs` to avoid spurious "dead" detections on transient hiccups.
- LB drops `/__mcp/proxy/*` from the public internet if possible. (HMAC is the primary gate; network isolation is defense in depth.)
