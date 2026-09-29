# Changelog

## 0.2.0

A major security and feature release. It contains **breaking changes**; read [Upgrading](#upgrading-from-01x) before deploying.

### Highlights

- **Strapi's own permission engine everywhere.** Content and media tools now enforce RBAC through the Content Manager's permission checker and the Media Library's permissions manager: conditions ("is creator"), field-level and locale permissions all apply, exactly as in the admin panel.
- **Full content lifecycle.** Publish, unpublish, discard draft and delete, behind new opt-in scopes.
- **Real media management.** Upload local files of any size through one-time upload URLs, plus folders (create, rename, move, delete), bulk move and delete.
- **Stateless transport.** Every request is authorized on its own; any instance behind any load balancer can serve any request.
- **Works with strict MCP clients.** Tool schemas are advertised as JSON Schema 2020-12.

### Security fixes

Upgrading is strongly recommended.

- **XSS / open redirect in the SSO bridge.** The `next` parameter was followed unvalidated, allowing `javascript:` URLs to run in the admin origin. Only same-origin paths are followed now.
- **Missing RBAC on media tools.** Media tools checked the OAuth scope only; any admin could list and upload files regardless of Media Library permissions.
- **RBAC conditions, field and locale permissions were ignored.** An "own entries only" role could read and update everyone's entries; restricted fields and locales were not enforced.
- **Private data through filters and populate.** Queries were not sanitized, so private attributes (e.g. admin password hashes via `createdBy`) could be filtered on or returned. Invalid queries are now rejected.
- **Related entries bypassed permissions.** Populating a relation returned the full related entry even when the caller couldn't read that content type. Related entries — including inside components and dynamic zones — are now checked against their own type and reduced to `{ documentId }` when unreadable.
- **Stale permissions and scopes.** Tool calls used the principal and scopes captured when the session started. Every call now uses the current token, role and client state.
- **SSRF in URL uploads.** Private, loopback, link-local and metadata addresses are refused, checked at connection time and on every redirect — including IPv6 forms that reach an IPv4 host (IPv4-mapped in hex or dotted notation, IPv4-compatible, NAT64, 6to4) and tunnelling ranges (Teredo, local-use NAT64).
- **Content-type spoofing on upload.** Declared MIME types were trusted (`x.html` as `image/png`). Extension, MIME type and file contents must now agree.
- **Authorization-code and refresh-token races.** Concurrent requests could redeem one code or rotate one refresh token twice. Consumption is atomic, and a replayed code — sequential or concurrent — revokes the token family the winning redemption mints into. Family revocation is now persistent, so it also invalidates tokens minted _after_ it and every access token of that family.
- **External mode accepted any token from the IdP.** `aud` was not checked. `oauth.external.audience` is now required, and `email_verified: false` tokens are rejected.
- **Client changes didn't take effect.** Disabling a client or narrowing its scopes had no effect on existing tokens. Both now apply on the next request and on refresh.
- **Unbounded refresh sessions.** Refresh families now have an absolute lifetime (`oauth.refreshFamilyMaxAgeSec`, 30 days).
- **Consent-screen phishing with DCR.** The consent screen now shows where it will redirect and flags self-registered clients no admin has approved. New `oauth.dcr.allowedRedirectHosts` restricts DCR redirect targets.
- The consent "Deny" path validated the redirect URI only after redirecting; client secret hashes were returned by the admin API; any authenticated caller could end another's session.
- A plugin with `config.enabled: false` still served its OAuth and MCP endpoints.

### New

**Content tools**

- `strapi_content_publish_entry`, `strapi_content_unpublish_entry` (scope `strapi:content:publish`)
- `strapi_content_delete_entry` (scope `strapi:content:delete`)
- `strapi_content_discard_draft`
- Single types work without a `documentId`; `update_entry` creates an empty single type.
- `list_entries`: `sort` (string, array, object or array of objects), `fields`, and pagination with `total` / `pageCount`.
- `populate` accepts dotted paths through relations, components **and dynamic zones** (`blocks.category`).
- `list_types` reports allowed actions, the default locale and the locales allowed per action.
- `get_schema` resolves every component (nested, dynamic-zone members, cycle-safe), lists `writableFields` for create and update, and documents the dynamic-zone format.
- Locales are validated against your i18n configuration (`zh-Hans`, `es-419`, … now work).
- Created and updated entries are stamped with the signed-in admin as creator/updater.

**Media tools**

- `strapi_media_request_upload` — a single-use, short-lived URL for uploading a local file of any size with `curl` (or a browser form). Files go through Strapi's upload service to your configured provider.
- `strapi_media_get`, `strapi_media_list_folders`, `strapi_media_update`, `strapi_media_move`
- `strapi_media_create_folder` (mkdir -p), `strapi_media_rename_folder`, `strapi_media_move_folder`
- `strapi_media_delete` and `strapi_media_delete_folder` (scope `strapi:media:delete`), both with `dryRun`
- Every placing tool accepts `folderId` or `folderPath` (`"templates/thumbnails"`, created if missing).
- `strapi_media_list` filters by folder, MIME (`"image"` = any image, `"image/png"` exact) and name.
- Media responses never include `hash`, `provider`, `provider_metadata`, `formats` or `folderPath`.

**Platform**

- **Stateless Streamable HTTP**: no `Mcp-Session-Id`; `GET`/`DELETE /mcp` return `405`.
- Tools are listed per request, only if the token has the scope _and_ the admin's role can use them.
- JSON Schema 2020-12 tool schemas; results also returned as `structuredContent`; `title` and MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) on every tool.
- Content-type schemas exposed as MCP resources (`strapi://content-types/{uid}/schema`).
- **Extension point**: other plugins can add tools via `strapi.plugin('mcp-server').service('tool-registry').register(...)`.
- Stable error codes: `insufficient_scope`, `forbidden`, `not_found`, `bad_request`, `timeout`, `upload_provider_error`, `internal_error`.
- New config: `requestTimeoutMs` (60 s), `audit.recordReads`, `upload.ticketTtlSec`, `oauth.refreshFamilyMaxAgeSec`, `oauth.dcr.allowedRedirectHosts`, `oauth.external.audience`.
- MCP requests carry the admin as `ctx.state.user`, so Strapi's request-scoped features (e.g. Enterprise audit logs) can attribute changes.

### Changed

- The plugin is active once `resourceUrl` is set; until then every public route returns 404. Turn it off with Strapi's standard `'mcp-server': { enabled: false }`.
- Publish and delete scopes are opt-in everywhere: new clients created in the admin UI get read/write scopes by default, and self-registered (DCR) clients that don't request specific scopes get only read/write.
- The admin UI Overview no longer shows sessions; Settings no longer shows session or cluster options.

### Removed

- Sessions and Redis-based session routing: `session.*`, `redis.instanceId`, `redis.internalAddress`, `redis.internalSecret`, `redis.heartbeat*` and the internal `/__mcp/proxy/*` endpoint. Redis is now only used to share rate-limit buckets.
- The plugin-level `config.enabled` flag.

### Upgrading from 0.1.x

1. **Tool names** changed from `strapi.content.list_types` to `strapi_content_list_types`. Update any prompts or allowlists; dotted names still work as `tools.enabled` keys.
2. **Remove `config.enabled`** from the plugin config. The plugin is active when `resourceUrl` is set.
3. **Remove `session.*` and the Redis cluster keys.** They're ignored if left in. Sticky load balancing is no longer needed.
4. **External mode:** add `oauth.external.audience`, or the plugin won't start.
5. **Grant new scopes** (`strapi:content:publish`, `strapi:content:delete`, `strapi:media:delete`) to existing clients in **MCP Server → Clients** if they should have them, then reconnect.
6. **Check role locales.** Strapi creates default role permissions without locale access for content types localized after the role was created. If a role can't write a localized type, set its locales in **Settings → Roles**.
7. Reconnect your MCP clients so they fetch the new tool list.

Two small database columns are added automatically on boot, plus a table for upload tickets.

## 0.1.3 — 2026-09-12

### Fixed

- **The published package didn't load.** The npm tarballs for 0.1.1 and 0.1.2 contained no `dist/` build output: `package.json` `exports` point at `dist/`, `dist/` is git-ignored, and nothing built it before publishing (npm silently drops missing `files` entries). Strapi skipped the plugin without logging anything. A `prepack` hook now builds before `npm pack`, `npm publish` and `file:`/git installs, so a tarball can no longer be assembled without `dist/`.

## 0.1.2 — 2026-05-31

This patch fixes a permissions bug that made the MCP server unusable for any admin role other than super-admin, and adds practical prompt recipes to the README.

> The npm tarball for this version is missing its build output and doesn't load — use 0.1.3 or later.

### Fixed

- **Non-super-admin users saw an empty tool catalog.** MCP now mirrors what the role can do in Strapi's Content Manager — read access to a content type in the Content Manager UI also means read access via MCP.

### Added

- **"Use cases" section in the README**: 15 prompt recipes organized by intent:
  - **Analyze (read-only)** — content-model tour, editorial audit, duplicate clustering, cross-type relationship maps, locale gap reports, tag taxonomy hygiene, image library audit, pre-writing content briefs
  - **Create (drafts)** — bulk-from-outline, batch localization, A/B headline variants, schema-aware stubbing for new content types
  - **Update (drafts)** — bulk find-and-replace, missing-field backfill (especially SEO), editorial style normalization

## 0.1.1 — 2026-05-29

First public release of `strapi-mcp-server` — a Strapi v5 plugin that exposes your Strapi instance as a Model Context Protocol (MCP) server, so AI assistants like Claude Code, Claude (web), Cursor and opencode can browse your content schema and read/write entries through your existing Strapi RBAC.

> The npm tarball for this version is missing its build output and doesn't load — use 0.1.3 or later.

### Highlights

- **Streamable HTTP MCP transport** at `POST/GET/DELETE /mcp`, per the current MCP spec.
- **OAuth 2.1 + PKCE (S256)** authorization server embedded in the plugin — no extra infrastructure. External IdP mode is in the config schema for future work.
- **Eight tools**: `strapi.content.list_types`, `get_schema`, `list_entries`, `get_entry`, `create_entry` (draft only), `update_entry`, `strapi.media.list`, `strapi.media.upload`.
- **Double-gated calls**: OAuth scope (`strapi:content:read`, `strapi:content:write`, `strapi:media:read`, `strapi:media:write`) and the admin user's Strapi RBAC permissions.
- **Admin pages**: Overview, Clients, Tools, Audit Log, Settings — each gated by its own permission action.
- **Audit log** of every tool call, with redacted parameters and configurable retention.
- **Optional Redis backend** for horizontal scale — shared rate-limit buckets and cross-instance session routing via an HMAC-signed proxy.

### Security posture (defaults)

- PKCE S256 only — `plain` rejected
- Rotating opaque refresh tokens; reuse revokes the whole family
- RS256 access tokens signed with a plugin-owned key, encrypted at rest (never reuses `ADMIN_JWT_SECRET`)
- Audience-bound tokens (`aud` claim + `resource` indicator)
- Dynamic Client Registration off by default; admins create clients in the UI
- Origin + Host allowlist on every `/mcp` and `/oauth/*` request
- Per-principal and per-IP rate limiting
- Upload MIME allowlist and size cap; SVG rejected by default
- Security-critical config validated at boot — the plugin refuses to start with unsafe values in production
