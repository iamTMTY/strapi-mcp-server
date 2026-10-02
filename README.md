# strapi-mcp-server

Expose a Strapi v5 instance as a **Model Context Protocol** (MCP) server. AI clients (Claude Code, Claude web, Cursor, Codex, opencode, …) sign in with **OAuth 2.1 + PKCE** — no shared admin tokens — and then browse content types, read, create, update, publish and delete entries, manage the Media Library and upload files, all governed by the signed-in admin's Strapi role.

> Security posture: inactive until configured, default-deny, the same permission engine as the Content Manager and Media Library (conditions, field- and locale-level permissions), per-request authorization, short-lived audience-bound tokens with rotating refresh tokens, mandatory PKCE S256, strict redirect-URI allowlists, Origin/Host validation, SSRF-safe URL fetching, rate limiting and a full audit log.

## Table of contents

- [Why this instead of Strapi's built-in MCP server](#why-this-instead-of-strapis-built-in-mcp-server)
- [Quick setup](#quick-setup)
- [Tools](#tools)
- [Permissions](#permissions)
- [Media: uploads and folders](#media-uploads-and-folders)
- [Configuration reference](#configuration-reference)
- [External AS mode](#external-as-mode)
- [Endpoints](#endpoints)
- [Extending: registering your own tools](#extending-registering-your-own-tools)
- [Deployment and scaling](#deployment-and-scaling)
- [Use cases](#use-cases)
- [Upgrading from 0.1.x](#upgrading-from-01x)

## Why this instead of Strapi's built-in MCP server

Strapi 5 ships an [MCP server](https://docs.strapi.io/cms/features/strapi-mcp-server) authenticated with Admin tokens. This plugin covers the same ground and adds:

|                                     | Strapi built-in                      | strapi-mcp-server                                                                                                                         |
| ----------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication                      | Admin token pasted into every client | OAuth 2.1 + PKCE; each person signs in as themselves, with a consent screen and revocable clients                                         |
| Third-party / web clients           | Manual token distribution            | Dynamic Client Registration (optional, with redirect-host allowlist)                                                                      |
| Tool count                          | One set per content type (~5–8 each) | 22 generic tools, whatever the size of your model — far less context used                                                                 |
| Upload new files                    | ❌ (reference existing media only)   | ✅ base64, public URL, or a one-time upload URL for local files of any size                                                               |
| Relation permissions                | —                                    | Populated relations are re-checked against the _target_ type's permissions                                                                |
| Nested populate                     | ❌                                   | ✅ including through components and dynamic zones                                                                                         |
| Dynamic zones / circular components | Untyped / open record                | Fully described by `get_schema` (all components, nested, cycle-safe)                                                                      |
| Audit log                           | Enterprise only                      | Built in, every call, redacted (requests also carry the admin as `ctx.state.user` for Strapi's EE audit log — untested without a license) |
| Transport                           | Stateless                            | Stateless                                                                                                                                 |
| Tool schemas                        | JSON Schema 2020-12                  | JSON Schema 2020-12                                                                                                                       |

## Quick setup

By default, clients self-register on first connect through Dynamic Client Registration (DCR) and get read/write scopes only. For a pre-registered `client_id` + `client_secret` instead — the `client_secret` protects refresh tokens, so a leaked refresh token can't be used without it — create a client in the Strapi admin UI ([step 3](#3-optional-create-a-confidential-client)) and set `oauth: { dcr: { enabled: false } }` to turn self-registration off.

### 1. Install

```sh
npm install strapi-mcp-server
```

### 2. Configure the plugin

In `config/plugins.ts` (or `.js`):

```ts
export default ({ env }) => ({
  'mcp-server': {
    config: {
      resourceUrl: env('MCP_RESOURCE_URL', 'http://localhost:1337/mcp'),
      allowedOrigins: env.array('MCP_ALLOWED_ORIGINS', ['http://localhost:1337']),
    },
  },
});
```

Restart Strapi. The plugin is **inactive until `resourceUrl` is set**: installing it exposes nothing. To turn a configured plugin off, use Strapi's standard `'mcp-server': { enabled: false }`.

> If Strapi's built-in MCP server is enabled (`mcp: { enabled: true }` in `config/server`), turn it off — both serve `/mcp`.

### 3. (Optional) Create a confidential client

Skip this step if you use DCR (on by default). Otherwise, once:

1. Strapi admin → **MCP Server → Clients → New client**
2. **Name**: anything (e.g. `Claude Code — my-laptop`)
3. **Redirect URIs**: leave blank — defaults to `http://localhost/callback` and accepts any loopback port (RFC 8252 §7.3). Only fill in for non-loopback web clients.
4. **Scopes**: read/write are ticked by default; tick **publish** and **delete** scopes only if the AI should be able to do that. Those scopes are only granted once their tools are enabled in `tools.enabled` (see [Tools](#tools)).
5. **Confidential**: tick "Generate client secret" → **Save**, then copy the **Client ID** and **Client Secret** (shown once).

### 4. Connect your AI client

Every client speaks the same MCP Streamable HTTP transport. Paste the credentials from step 3, or omit the credential block to use DCR.

#### 4.1 Claude Code

```sh
claude mcp add --transport http --scope user strapi http://localhost:1337/mcp \
  --client-id <CLIENT_ID> \
  --client-secret
```

`--client-secret` prompts for the secret (or set `MCP_CLIENT_SECRET`). Drop the last two flags for DCR. Docs: [Claude Code MCP](https://docs.claude.com/en/docs/claude-code/mcp)

#### 4.2 Claude web (claude.ai)

Needs a public HTTPS URL — `claude.ai` can't reach `localhost`. Tunnel with `ngrok`, `cloudflared` or `tailscale funnel`, set `resourceUrl` and `allowedOrigins` to the public hostname, restart. Then **claude.ai → Settings → Connectors → Add connector**, paste the URL; for pre-registered credentials fill in **OAuth Client ID/Secret** under **Advanced settings**. Docs: [custom connectors](https://support.anthropic.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)

#### 4.3 Codex CLI

`~/.codex/config.toml`, bridged with [`mcp-remote`](https://github.com/geelen/mcp-remote):

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

Drop the last two args for DCR.

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

Omit the `oauth` block for DCR. Add `strapi:content:publish`, `strapi:content:delete` or `strapi:media:delete` to `scope` if the client was granted them.

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

Omit the `auth` block for DCR.

### 5. Authorize

Trigger the connection (Claude Code: `claude` → `/mcp` → **strapi**). A browser opens to the Strapi admin login (if you're not signed in), then a consent screen showing the client's name, **where it will redirect you**, and the requested scopes. Self-registered clients nobody has approved yet are flagged as unverified. Click Approve.

### Notes that apply to every client

- Non-localhost targets require HTTPS, and the URL must be listed in `allowedOrigins`.
- Access tokens last 10 minutes by default and refresh automatically; a login lasts at most `oauth.refreshFamilyMaxAgeSec` (30 days) before re-consent.
- Disable or delete a client in **MCP Server → Clients** and its tokens stop working on the next request. Narrowing a client's scopes also applies immediately.
- Behind a reverse proxy / load balancer, set Strapi's `server.proxy: true` so per-IP rate limiting sees real client IPs.

## Tools

22 tools, listed per request: a tool only appears if it is **enabled in config**, the token has its **scope** _and_ the admin's Strapi role can use it somewhere (e.g. no media tools for a role without Media Library access). Every call is re-checked anyway.

Publish, unpublish and delete tools (`strapi_content_publish_entry`, `strapi_content_unpublish_entry`, `strapi_content_delete_entry`, `strapi_media_delete`, `strapi_media_delete_folder`) are **disabled by default**. The plugin config is the source of truth: a scope is only advertised, registered, consented to or honoured on a token when at least one enabled tool needs it, whatever the client asked for and whatever the admin's role allows. Enabling a tool does not bypass RBAC — the admin's role must still allow the action.

```js
'mcp-server': {
  config: {
    tools: { enabled: { strapi_content_publish_entry: true } },
  },
},
```

### Content

| Tool                             | Scope                    | Notes                                                                                                                |
| -------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `strapi_content_list_types`      | `strapi:content:read`    | Kind, draft & publish, allowed actions; for localized types the default locale and **locales allowed per action**.   |
| `strapi_content_get_schema`      | `strapi:content:read`    | Readable fields, every component (nested, dynamic-zone members, cycle-safe), and `writableFields` for create/update. |
| `strapi_content_list_entries`    | `strapi:content:read`    | `filters`, `sort`, `fields`, `populate`, `locale`, `status`, pagination with `total`/`pageCount`.                    |
| `strapi_content_get_entry`       | `strapi:content:read`    | By `documentId`; single types omit it.                                                                               |
| `strapi_content_create_entry`    | `strapi:content:write`   | Saved as a draft on draft & publish types.                                                                           |
| `strapi_content_update_entry`    | `strapi:content:write`   | Updates the draft; a new `locale` creates a translation; single types are created if empty.                          |
| `strapi_content_discard_draft`   | `strapi:content:write`   | Reset the draft to the published version.                                                                            |
| `strapi_content_publish_entry`   | `strapi:content:publish` |                                                                                                                      |
| `strapi_content_unpublish_entry` | `strapi:content:publish` | Keeps the draft.                                                                                                     |
| `strapi_content_delete_entry`    | `strapi:content:delete`  | One locale (the default if omitted), draft and published.                                                            |

**Querying.** `filters` use Strapi's syntax on scalar fields — `$eq $ne $in $notIn $lt $lte $gt $gte $between $contains $notContains $startsWith $endsWith $null $notNull`, case-insensitive `$eqi $nei $containsi $notContainsi $startsWithi $endsWithi`, combined with `$and`/`$or`/`$not`; a bare value means `$eq`. Invalid filters (unknown or private fields) are rejected with a clear error rather than silently dropped. `sort` accepts `"title:asc"`, `["a:asc","b:desc"]`, `{ "title": "asc" }` or `[{ "title": "asc" }]`. `populate` accepts `"*"` (one level of everything) or dotted paths such as `["author", "seo.image", "blocks.category"]`, which work through components **and dynamic zones**.

**Writing.** To-one relations take a documentId, `{ documentId, locale?, status? }` or `null`; to-many take `{ connect, disconnect }` (with optional `position: { before | after | start | end }`) or `{ set }`. Dynamic-zone items are `{ "__component": "category.name", …fields }`. Fields the role may not write are dropped; the creator/updater is stamped as the signed-in admin.

### Media

| Tool                          | Scope                 | Notes                                                                                                                                                                                               |
| ----------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strapi_media_list`           | `strapi:media:read`   | Filter by folder (`folderId`, `null` = root, or `folderPath`), MIME (`"image"` = any image, `"image/png"` exact) and name.                                                                          |
| `strapi_media_get`            | `strapi:media:read`   |                                                                                                                                                                                                     |
| `strapi_media_list_folders`   | `strapi:media:read`   | Full folder tree.                                                                                                                                                                                   |
| `strapi_media_upload`         | `strapi:media:write`  | base64 (small files) or a public http(s) URL.                                                                                                                                                       |
| `strapi_media_request_upload` | `strapi:media:write`  | One-time URL for pushing a local file of any size — see below.                                                                                                                                      |
| `strapi_media_update`         | `strapi:media:write`  | Name, alt text, caption, folder.                                                                                                                                                                    |
| `strapi_media_move`           | `strapi:media:write`  | Move files in bulk.                                                                                                                                                                                 |
| `strapi_media_create_folder`  | `strapi:media:write`  | `mkdir -p` for a path like `templates/thumbnails`; idempotent.                                                                                                                                      |
| `strapi_media_rename_folder`  | `strapi:media:write`  | Unique among siblings.                                                                                                                                                                              |
| `strapi_media_move_folder`    | `strapi:media:write`  | Moves the whole subtree; can't move into itself or a descendant.                                                                                                                                    |
| `strapi_media_delete`         | `strapi:media:delete` | Files; `dryRun` supported.                                                                                                                                                                          |
| `strapi_media_delete_folder`  | `strapi:media:delete` | Folders **and everything inside** (files removed from the provider too); `dryRun`; all-or-nothing — refused if any file inside is one the role may not manage; only checked files are ever deleted. |

Media responses contain only `id, documentId, name, alternativeText, caption, url, mime, size, width, height, ext, folder` and timestamps — never `hash`, `provider`, `provider_metadata`, `formats` or `folderPath`. File ids and folder ids are separate numeric sequences.

### Results, errors, annotations

- Every result is returned both as JSON text and as `structuredContent`.
- Errors carry a stable `error` code — `insufficient_scope`, `forbidden`, `not_found`, `bad_request`, `timeout`, `upload_provider_error`, `internal_error` — plus a message. Internal errors never leak stack traces or SQL.
- Every tool has a `title` and MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so clients can auto-approve reads and ask before destructive calls.
- Read-only tool calls are capped at `requestTimeoutMs` (60 s). Write tools always run to completion, so a write is never reported as failed while it may still land.
- Content-type schemas are also exposed as MCP **resources** (`strapi://content-types/{uid}/schema`) for clients that attach context from resources.

## Permissions

Each request is authorized on its own — there are no sessions, so permission, scope and client changes apply on the very next call.

1. **Token**: signature, issuer, audience, expiry, revocation; the client must still be active.
2. **Scope**: the tool's scope must be in the token _and_ still granted to the client.
3. **Strapi RBAC**, through Strapi's own enforcement (the Content Manager's `permission-checker`, the Media Library's permissions manager), never a hand-rolled check:
   - **Conditions** such as "is creator" / "has same role as creator" filter queries at the database level and are checked on each document before writes, publishes and deletes.
   - **Field-level permissions**: unreadable fields are stripped from output and can't be filtered or sorted on; unwritable fields are dropped from input. `get_schema` tells the model which fields it may write.
   - **Locale permissions**: checked against the actual target locale (the default locale when omitted), evaluated as "an entry this admin would create" so creator conditions work. `list_types` tells the model which locales it may use per action.
   - **Private attributes** (e.g. admin password hashes via `createdBy`) are never returned or filterable.
   - **Relations**: every populated related entry — including inside components and dynamic zones — is checked against _its own_ type's read permission and sanitized with that type's field rules; entries the caller can't read are reduced to `{ documentId }`. (Strapi's own sanitizer only applies the root type's permissions.)

Plugin admin pages are gated by three RBAC actions: `plugin::mcp-server.read` (Overview, Tools, Settings), `plugin::mcp-server.clients.manage` (Clients) and `plugin::mcp-server.audit.read` (Audit Log).

## Media: uploads and folders

### Uploading local files

Base64 makes the model re-type every byte — fine for an icon, hopeless for a 400 KB screenshot. For files on disk the model calls `strapi_media_request_upload` and gets a single-use URL:

```bash
curl -sS -F "file=@Your HR Team.png" https://cms.example.com/mcp/uploads/<ticket>
# → 201 { "id": 42, "name": "Your HR Team.png", "url": "…", "mime": "image/png", … }
```

Agents with a shell (Claude Code, Cursor, Codex) run the curl themselves; for chat-only clients the user opens the URL and gets a one-file upload form. The bytes never pass through the model.

- Files go through Strapi's own upload service, so they land on **whatever upload provider you configured** (local, S3, Cloudinary, …) with normal thumbnails and responsive formats. There is no provider-specific code.
- The URL is **single-use** (consumed by the first attempt, even a failed one), expires after `upload.ticketTtlSec` (10 min) and is bound to the admin + client that requested it. At upload time the admin, the client, its `strapi:media:write` scope and the Media Library create permission are re-checked. Only a hash of the ticket is stored.
- Alt text, caption and folder are fixed when the URL is requested. Oversized requests are refused from `Content-Length` before Strapi parses the body.

### Upload checks (all paths)

- MIME type must be on `upload.mimeAllowlist`; SVG is off unless `upload.allowSvg`.
- The file extension must match the MIME type, and the bytes must match it (magic-byte check) — `x.html` declared as `image/png` is rejected. Executable extensions are refused for unknown types.
- URL uploads refuse private, loopback, link-local and metadata addresses, checked at connection time (DNS-rebinding-safe) and on every redirect.
- Storage failures (e.g. bad S3 credentials) come back as `upload_provider_error` with the provider's message, not an opaque internal error.

### Folders

Every tool that places a file (`upload`, `request_upload`, `update`, `move`) takes `folderId` or `folderPath` (`"templates/thumbnails"`); a `folderPath` creates missing folders like `mkdir -p` (same permission the admin UI requires). `strapi_media_list` accepts `folderPath` but never creates anything. Folder names can't contain `/` or leading/trailing spaces and must be unique among siblings.

## Configuration reference

All keys go under the plugin's `config: { ... }` block.

### Top-level

| Option             | Type       | Default    | Description                                                                                                                                                                |
| ------------------ | ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resourceUrl`      | `string`   | _unset_    | Public URL of `/mcp` (e.g. `https://cms.example.com/mcp`); JWT `aud` and OAuth issuer origin. **Until it is set the plugin serves nothing** (public routes 404).           |
| `allowedOrigins`   | `string[]` | _required_ | Origins allowed to call `/mcp` and `/oauth/*` from a browser. Clients without an `Origin` fall back to a Host check against `resourceUrl`. `'*'` is refused in production. |
| `requestTimeoutMs` | `number`   | `60000`    | Upper bound for a read-only tool call (1 000–600 000). Writes are never cut off.                                                                                           |

### OAuth (`oauth.*`)

| Option                            | Type                       | Default                | Description                                                                                                                                                                        |
| --------------------------------- | -------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth.mode`                      | `'embedded' \| 'external'` | `'embedded'`           | `embedded` runs the Authorization Server in the plugin; `external` delegates to your IdP — see below.                                                                              |
| `oauth.accessTokenTtlSec`         | `number` (60–3600)         | `600`                  | Access-token lifetime.                                                                                                                                                             |
| `oauth.refreshTokenTtlSec`        | `number` (≥300)            | `86400`                | Refresh-token lifetime. Rotates on every use; reuse or concurrent use revokes the family.                                                                                          |
| `oauth.refreshFamilyMaxAgeSec`    | `number` (≥ refresh TTL)   | `2592000` (30 d)       | Absolute lifetime of a login; rotation can't extend past it.                                                                                                                       |
| `oauth.authCodeTtlSec`            | `number` (10–600)          | `60`                   | Authorization-code lifetime. Codes are single-use; a replayed code revokes the tokens it produced.                                                                                 |
| `oauth.ssoCookieTtlSec`           | `number`                   | `900`                  | Cookie tying the admin login to the consent screen (also invalidated by admin logout).                                                                                             |
| `oauth.dcr.enabled`               | `boolean`                  | `true`                 | Allow `POST /oauth/register` so clients self-register. Clients that don't request scopes get read/write only; publish/delete must be requested explicitly and their tools enabled. |
| `oauth.dcr.ratelimitPerHour`      | `number`                   | `60`                   | Max DCR registrations per IP per hour.                                                                                                                                             |
| `oauth.dcr.allowedRedirectHosts`  | `string[]`                 | unset                  | Only let self-registered clients redirect to these hosts (loopback always allowed), e.g. `['claude.ai']`. Strongly recommended with DCR.                                           |
| `oauth.consent.rememberDays`      | `number`                   | `0`                    | Skip the consent prompt for an approved admin/client/scope set. `0` = always prompt.                                                                                               |
| `oauth.introspection.allowedIps`  | `string[]`                 | `['127.0.0.1', '::1']` | IPs allowed to call `POST /oauth/introspect`.                                                                                                                                      |
| `oauth.external.issuer`           | `string`                   | —                      | External issuer (required in `external` mode). Must match `iss` byte-for-byte.                                                                                                     |
| `oauth.external.jwksUri`          | `string`                   | —                      | External JWKS URL.                                                                                                                                                                 |
| `oauth.external.audience`         | `string \| string[]`       | —                      | **Required** in `external` mode: expected `aud`.                                                                                                                                   |
| `oauth.external.adminLookupClaim` | `string`                   | `'email'`              | Claim mapped to a Strapi admin (`'email'` or `'username'`).                                                                                                                        |
| `oauth.external.enforceScopes`    | `boolean`                  | `false`                | Require `strapi:*` scopes in the JWT.                                                                                                                                              |

### Rate limit, uploads, audit, tools

| Option                                | Type       | Default                                       | Description                                                               |
| ------------------------------------- | ---------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| `rateLimit.perPrincipal.capacity`     | `number`   | `60`                                          | Burst per admin.                                                          |
| `rateLimit.perPrincipal.refillPerSec` | `number`   | `1`                                           | Steady-state requests/sec per admin.                                      |
| `rateLimit.perIp.capacity`            | `number`   | `120`                                         | Burst per IP.                                                             |
| `rateLimit.perIp.refillPerSec`        | `number`   | `2`                                           | Steady-state requests/sec per IP.                                         |
| `upload.maxBytes`                     | `number`   | `10_485_760`                                  | Max upload size (10 MB).                                                  |
| `upload.mimeAllowlist`                | `string[]` | (png, jpeg, webp, gif, pdf)                   | Accepted MIME types.                                                      |
| `upload.allowSvg`                     | `boolean`  | `false`                                       | Off because SVGs can carry XSS payloads.                                  |
| `upload.ticketTtlSec`                 | `number`   | `600`                                         | Lifetime (60–3600 s) of one-time upload URLs.                             |
| `audit.retentionDays`                 | `number`   | `90`                                          | Daily cron deletes older entries.                                         |
| `audit.redactKeyPatterns`             | `string[]` | (password, token, …)                          | Keys whose values are replaced with `[redacted]`.                         |
| `audit.recordReads`                   | `boolean`  | `true`                                        | Record successful read-only calls. Writes and errors are always recorded. |
| `tools.enabled[<toolName>]`           | `boolean`  | `true` (read/write), `false` (publish/delete) | Per-tool switch (0.1 dotted names are accepted as keys too).              |

### Redis (`redis.*`, optional)

Only used to share rate-limit buckets across instances — the transport is stateless, so multiple instances work without it.

| Option            | Type      | Default                 | Description                                  |
| ----------------- | --------- | ----------------------- | -------------------------------------------- |
| `redis.enabled`   | `boolean` | `false`                 | Share rate-limit buckets through Redis.      |
| `redis.url`       | `string`  | _required when enabled_ | `redis://` or `rediss://` connection string. |
| `redis.keyPrefix` | `string`  | `'mcp:'`                | Prefix on every key the plugin writes.       |

## External AS mode

Delegate authentication to an existing OAuth 2.1 / OIDC provider (Auth0, Keycloak, Okta, Entra ID, …). The plugin becomes a pure resource server: it verifies tokens from your IdP and runs tools as the matching Strapi admin. The embedded `/oauth/*` endpoints are disabled.

Use it when your org has SSO and MCP traffic should follow the same policies (MFA, off-boarding), or when you don't want the plugin storing OAuth state.

```ts
oauth: {
  mode: 'external',
  external: {
    issuer: env('MCP_EXTERNAL_ISSUER'),       // e.g. https://your-tenant.auth0.com/
    jwksUri: env('MCP_EXTERNAL_JWKS_URI'),    // e.g. https://your-tenant.auth0.com/.well-known/jwks.json
    audience: env('MCP_EXTERNAL_AUDIENCE'),   // the aud your IdP puts in tokens for this server
    adminLookupClaim: 'email',                // or 'username'
  },
},
```

The plugin refuses to start without `issuer`, `jwksUri` and `audience`. Each request: verify signature + `iss` + `aud` + `exp` → read the lookup claim (tokens with `email_verified: false` are rejected) → find an active Strapi admin with that value → run under that admin's RBAC. Provision Strapi admins ahead of time.

With `enforceScopes: false` (default) a verified JWT gets the full tool surface (still filtered by Strapi RBAC); set `true` only if your IdP issues `strapi:*` scopes.

**IdP quirks.** Keycloak puts `account` in `aud` by default — add an _Audience_ mapper so tokens carry your MCP audience. Some IdPs only include `email` when the `email` scope is requested. Auth0 issuers end with a slash; Cognito's don't.

### Keycloak walkthrough (validated)

```sh
docker run --name keycloak -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:latest start-dev
```

1. **Create realm** `mcp-test`; under **Authentication → Required actions** turn the default actions off for testing.
2. **Clients → Create client** `mcp-test-client`, **Client authentication ON**, **Standard flow ON**, redirect URI `http://localhost:33418/callback`. Copy the client secret. Add an **Audience** mapper (client scopes → dedicated scope → Add mapper → Audience → `mcp-test-client`).
3. **Users → Add user** with the email of a real Strapi admin, **Email verified ON**, set a password.
4. Configure the plugin:

   ```js
   oauth: {
     mode: 'external',
     external: {
       issuer: 'http://localhost:8080/realms/mcp-test',
       jwksUri: 'http://localhost:8080/realms/mcp-test/protocol/openid-connect/certs',
       audience: 'mcp-test-client',
     },
   },
   ```

5. Connect Claude Code with the pre-registered client (Keycloak doesn't allow anonymous DCR):

   ```sh
   claude mcp add --transport http --scope user strapi http://localhost:1337/mcp \
     --client-id mcp-test-client --client-secret --callback-port 33418
   ```

   and pin `"scopes": "openid email"` on the entry in `~/.claude.json`.

## Endpoints

| Path                                          | Purpose                                                      |
| --------------------------------------------- | ------------------------------------------------------------ |
| `POST /mcp`                                   | MCP Streamable HTTP, stateless (`GET`/`DELETE` return `405`) |
| `GET\|POST /mcp/uploads/:ticket`              | One-time upload form / upload                                |
| `GET /.well-known/oauth-protected-resource`   | RFC 9728                                                     |
| `GET /.well-known/oauth-authorization-server` | RFC 8414                                                     |
| `GET /oauth/authorize`                        | PKCE authorization endpoint (S256 only)                      |
| `POST /oauth/consent`                         | Consent form submission                                      |
| `POST /oauth/token`                           | `authorization_code` + `refresh_token` grants                |
| `POST /oauth/revoke`                          | RFC 7009                                                     |
| `POST /oauth/introspect`                      | RFC 7662 (loopback-only by default)                          |
| `POST /oauth/register` (and `/register`)      | RFC 7591 DCR (only when `oauth.dcr.enabled`)                 |
| `GET /oauth/jwks`                             | Public JWKS                                                  |

The plugin reserves these paths at the app root.

## Extending: registering your own tools

Other plugins (or your app) can add tools. They get the same scope check, zod validation, audit logging, timeout, listing filter and `tools.enabled` toggle as built-ins:

```ts
// in your plugin's register() or bootstrap()
import { z } from 'zod'; // zod v4

strapi
  .plugin('mcp-server')
  .service('tool-registry')
  .register({
    name: 'acme_reindex_search', // ^[a-z][a-z0-9_]{0,63}$, "strapi_" prefix is reserved
    title: 'Reindex search',
    description: 'Rebuild the search index for one content type.',
    scope: 'strapi:content:write', // one of the plugin's OAuth scopes
    requires: 'content.update', // role capability needed for the tool to be listed
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: z.object({ uid: z.string() }),
    async run({ uid }, auth) {
      // auth.principal.user is the calling admin; do your own RBAC checks for specifics
      await strapi.service('plugin::acme.search').reindex(uid);
      return { ok: true };
    },
  });
```

`requires` is one of `content.read|create|update|delete|publish` or `media.read|create|update`.

## Deployment and scaling

The MCP transport is **stateless**: every `POST /mcp` is authenticated and authorized on its own, builds a fresh MCP server for that request and throws it away. There are no `Mcp-Session-Id`s and nothing to route, so:

- Any number of Strapi instances can sit behind any load balancer (AWS ALB included) — no sticky sessions.
- Revoking a client, changing a role or narrowing scopes takes effect on the next request, on every instance.
- OAuth state (clients, codes, refresh tokens, upload tickets, signing keys) lives in the Strapi database, shared by all instances.
- Rate limits are per instance unless you enable `redis`, which shares the buckets.

Checklist: identical `resourceUrl` / `allowedOrigins` on every instance; `server.proxy: true` behind a proxy; the LB forwards `Authorization`, `Origin`, `Accept` and `Content-Type` unmodified.

## Use cases

Paste these into any connected client. The AI sees exactly what your role sees.

### Analyze (read-only)

- **Tour my content model.** _"Walk me through every content type. For each, summarize what it represents, its fields, and anything under-specified (no slug, no meta description, no relations)."_
- **Editorial audit.** _"Audit all published Articles: missing meta description, body under 300 words, no featured image, or deprecated tags [list]. Group by author."_
- **Duplicates.** _"Cluster Articles tagged `product-update` that cover the same release so I can merge or redirect them. Show documentIds."_
- **Relationship mapping.** _"For our top 10 Products by `popularity`, find every Article that mentions them: product, count, sample titles, last mention."_
- **Locale gaps.** _"List published English Articles without a French version, newest first."_
- **Media hygiene.** _"Find images with no alt text, over 2 MB, or older than a year and unreferenced. Report only."_

### Create and update

- **Bulk drafts from an outline.** _"Create a draft Article for each of these 12 ideas with title, slug, excerpt and a 300-word first draft; tag them `editorial-todo`."_
- **Translate a batch.** _"Create French drafts for the 20 most recently updated English Articles, keeping structure and tone."_
- **Fix a consistent mistake.** _"Replace the old product name 'Foo' with 'Bar' across Articles, as drafts for review."_
- **Backfill SEO.** _"Draft a 150-character meta description for every Article missing one."_

### Publish and media (needs the publish / media scopes)

- _"Publish the drafts I approved: <documentIds>."_
- _"Upload ~/Downloads/hero.png into `marketing/2026/q3` with alt text '…' and set it as the hero image of Article <documentId>."_
- _"Move every PDF in the root folder into `docs/`, then show me what's left in the root."_

## Upgrading from 0.1.x

- **Tool names** changed from `strapi.content.list_types` to `strapi_content_list_types` (dots break some clients' function-name rules). Old names still work as `tools.enabled` keys.
- **New scopes** `strapi:content:publish`, `strapi:content:delete` and `strapi:media:delete`. Existing clients don't get them automatically — edit the client to grant them.
- **No plugin-level `enabled` flag** — the plugin is active when `resourceUrl` is set; use Strapi's `'mcp-server': { enabled: false }` to turn it off.
- **Stateless transport**: `session.*` and `redis.internalAddress` / `internalSecret` / `instanceId` / `heartbeat*` are gone (ignored if still present). No sticky load balancing is needed any more. Clients that used `GET /mcp` for a server stream get `405` and continue over `POST`, which MCP clients handle.
- **External mode** now requires `oauth.external.audience`.
- **Default role permissions and i18n**: Strapi creates default role permissions without a `locales` property for types made localized later, which means _no_ locale access for that role (in the Content Manager too). Set the locales in **Settings → Roles** if a role suddenly can't write a localized type.
