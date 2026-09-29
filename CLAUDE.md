# strapi-mcp-server

A standalone Strapi v5 plugin that exposes a Strapi instance as a Model
Context Protocol (MCP) server. AI clients (Claude Code, Claude web, Cursor,
opencode, …) connect over stateless Streamable HTTP and call 22 generic
content + media tools, gated by OAuth 2.1 + PKCE and the signed-in admin's
Strapi RBAC permissions. It is a drop-in alternative to Strapi's built-in
MCP server (which uses shared Admin tokens) — see the README comparison.

## Stack

- TypeScript, Node ≥ 18
- Strapi v5 plugin scaffold via `@strapi/sdk-plugin` (pack-up)
- `@modelcontextprotocol/sdk` 1.x for the transport, `zod` **v4** for tool input
- `jose` for JWT signing
- Optional `ioredis` — only to share rate-limit buckets across instances
- Jest with two projects: `unit` and `integration`

## Common commands

```bash
npm run dev              # plugin watch:link + fixture test-app develop, concurrently
npm run build            # one-shot plugin build (dist/)
npm run test             # unit tests (default)
npm run test:integration # integration tests against a spawned fixture Strapi
                         # (needs `npm run build` + `npm run test-app:build` first)
npm run test:all         # both
npm run inspect          # @modelcontextprotocol/inspector against this server
npm run test-app:reset   # delete the fixture sqlite DB
```

The fixture Strapi app lives at `__tests__/fixtures/test-app/` and is an npm
workspace (`"strapi-mcp-server": "file:../../.."`). It has `article`
(draft & publish, relation to `category`, a `blocks` dynamic zone) and
`category` (localized) so integration tests cover relations, dynamic zones,
i18n and Author-role conditions. `npm run test-app:build` must succeed —
TS errors there (e.g. controllers for a new type the generated types don't
know) silently leave a stale `dist/config`. If Strapi can't find the
`better-sqlite3` bindings, run `npm rebuild better-sqlite3`.

## Layout

```
server/src/
  register.ts                  # RBAC actions; mounts uploadSizeGuard before Strapi's body parser
  bootstrap.ts                 # signing key, redis connect, audit drainer, nightly cron
  config/index.ts              # McpConfig, defaults, validator, isConfigured()
  content-types/               # internal: audit-log, oauth-*, upload-ticket
  controllers/
    mcp.ts                     # stateless POST /mcp; GET/DELETE → 405
    uploads.ts                 # GET|POST /mcp/uploads/:ticket + uploadSizeGuard
    oauth/                     # /.well-known/*, /authorize, /consent, /token, /register, …
    admin/                     # /mcp-server/* admin JSON endpoints
  policies/                    # configured, origin, authenticate (resolveAuth), rateLimit, scope
  routes/                      # mcp.ts, uploads.ts, oauth.ts (root-mounted), admin.ts
  services/
    mcp-server.ts              # per-request McpServer: tools/list (2020-12), tools/call wrapper, resources
    permissions.ts             # principal, CASL ability, content-manager checker, upload manager
    tools/common.ts            # defineTool (scope + zod), ToolAuth, Capability, locale helpers
    tools/content.ts           # 10 content tools, populate builder
    tools/relation-guard.ts    # per-target permission check of populated relations
    tools/media.ts             # 12 media tools, storeUpload(), SSRF-safe fetch, file-type checks
    tools/index.ts             # allTools / toolsFor (scope + toggle + role capability)
    tool-registry.ts           # extension point for third-party tools
    upload-tickets.ts          # one-time upload URLs (hash-only, single-use)
    audit.ts                   # buffered async writes + redactor
    rate-limiter.ts, redis.ts  # token buckets, optionally shared via Redis
    oauth/                     # tokens, signing-keys, scopes, clients, auth-codes, consent, audience

admin/src/pages/               # Overview, Clients, NewClient, EditClient, Tools, AuditLog, Settings, SsoBridge
__tests__/                     # unit tests by area + integration/ against the fixture app
```

## Conventions and gotchas

- **Admin imports come from `@strapi/strapi/admin`, not `@strapi/admin`**
  (the latter gets bundled twice and breaks `useAuth` etc.).
- **Content-type `schema.json` must be copied to `dist/`** via the
  `"src/**/*.json"` tsconfig include.
- **`@strapi/utils` must be a single instance** (workspaces hoist it);
  `instanceof` checks break otherwise.
- **All public routes are `auth: false`**; the plugin's own policies run in
  order `configured → origin → authenticate → rateLimit`. Admin endpoints use
  `admin::isAuthenticatedAdmin` + `admin::hasPermissions`.
- **Plugin is inactive until `resourceUrl` is set** — the `configured` policy
  404s every public route. There is no plugin-level `enabled` flag; Strapi's
  `'mcp-server': { enabled: false }` turns it off.
- **Stateless transport.** `mcp-server.create(auth)` builds a server + a
  `sessionIdGenerator: undefined` transport per POST; nothing is cached across
  requests. Don't reintroduce sessions — per-request auth is what makes
  permission/scope/client changes apply immediately and scaling trivial.
- **Per-request identity.** `controllers/mcp.ts` sets `req.auth` from
  `toAuthInfo(mcpAuth)`; the SDK hands it to tool callbacks as
  `extra.authInfo`. It also sets `ctx.state.user` so Strapi's request-scoped
  features (EE audit logs) see the admin.
- **tools/list is ours, tools/call is the SDK's.** SDK 1.x emits draft-07
  schemas even for zod v4, which strict clients drop (strapi/strapi#27395),
  so `mcp-server.ts` overrides `tools/list`, converting with
  `z.toJSONSchema` targeting `draft-2020-12`. With zero usable tools it still answers `[]`.
- **zod v4 only** in tool schemas (`z.record(z.string(), …)`), including for
  registered third-party tools.

## Security posture

- Default-deny: unconfigured plugin serves nothing.
- PKCE S256 only. Strict per-client redirect URI allowlist with loopback-port
  leniency (RFC 8252 §7.3). Consent screen shows the redirect target and flags
  unclaimed DCR clients; `oauth.dcr.allowedRedirectHosts` restricts DCR.
- The SSO bridge and `/oauth/sso-handoff` only follow same-origin paths
  (`isSafeLocalPath`) — never `javascript:`, absolute or `//host` URLs.
- Audience-bound RS256 access tokens (10 min), rotating refresh tokens (24 h)
  inside an absolute family lifetime (`refreshFamilyMaxAgeSec`, 30 d). Code
  and refresh consumption are atomic (`updateMany … count === 1`); reuse or a
  concurrent refresh revokes the family; a replayed code (sequential or
  concurrent) revokes the family the winner mints into — the winner fixes
  `familyId` in the same atomic update that marks the code used. Family
  revocation writes a `family:<id>` marker to the revocation table, and access
  tokens carry `fid`, so tokens minted _after_ a revocation are dead too.
  Refresh and `authenticate` both intersect scopes with the client's
  _current_ grant, and `authenticate` rejects disabled/deleted clients.
- DCR clients that don't request scopes get `DEFAULT_SCOPES` (read/write);
  publish/delete scopes are only granted when explicitly requested.
- External mode requires `external.audience` and rejects `email_verified:false`.
- Signing key encrypted at rest (AES-256-GCM, key HKDF'd from `APP_KEYS` +
  `ADMIN_JWT_SECRET`; rotating either regenerates it).
- `mcp_admin_sso` is bound to the admin's Strapi session id and re-checked on
  every verify, so admin logout kills it.
- Media: URL fetches block non-public addresses at socket lookup time
  (rebinding-safe) and on every redirect; IPv6 forms embedding an IPv4
  address (mapped, compatible, NAT64, 6to4) are judged by that IPv4 address
  (`embeddedIPv4`) rather than trusting `BlockList`'s mapped handling; uploads need matching MIME,
  extension and magic bytes; SVG off by default; provider SDK errors map to
  `upload_provider_error`.
- One-time upload tickets: 32 random bytes, stored as SHA-256, single-use,
  bound to admin + client, re-checked at claim; `uploadSizeGuard` refuses
  oversized `Content-Length` before parsing.
- Rate limits per principal and per IP. Audit writes buffered and redacted.

## RBAC in tools (the important part)

Never hand-roll permission checks. Content tools use the Content Manager's
`permission-checker` (`permissions.contentChecker`); media tools use
`admin::permission.createPermissionsManager` for `plugin::upload.file`
(`permissions.uploadManager`). Rules that took bugs to learn:

- **Load entities with the populate their conditions reference**
  (`populate-builder(uid).populateFromQuery(permissionQuery)`), for checks
  _and_ for output — otherwise an "is creator" condition sees no `createdBy`
  and `sanitizeOutput` strips every field.
- **Reads filter at the DB**: `sanitizedQuery.read()` merges condition filters,
  so unreadable documents are simply not found.
- **Checks for new entries use `{ locale, createdBy: <admin> }`** (`newEntry`)
  — a bare `{ locale }` fails creator conditions for localized types.
- **Strapi's sanitizer only applies the root type's permissions.** Every
  populated relation (inside components/dynamic zones too) goes through
  `relation-guard.ts`, which checks the target type and reduces unreadable
  entries to `{ documentId }`.
- **Invalid queries are rejected** (`validateQuery`) rather than silently
  sanitized away.
- **Tool listing** (`toolsFor`) hides tools whose `requires` capability the
  role lacks everywhere; handlers still check per document.
- Strapi default role permissions for a type localized _after_ the role was
  created have no `locales` property, which i18n turns into "no locales".
  That's Strapi behaviour, not a bug here.

Admin page permissions (registered in `register.ts`):
`plugin::mcp-server.read` (Overview, Tools, Settings),
`plugin::mcp-server.clients.manage` (Clients), `plugin::mcp-server.audit.read`
(Audit Log). The top-level menu link OR-matches all three.

## Tools

22 built-ins, all defined with `defineTool` (scope check + zod parse before
`run`, JSON text + `structuredContent` result, `title`, annotations,
`requires` capability):

- `strapi:content:read`: `list_types` (per-action locales), `get_schema`
  (writable fields, all components, dynamic-zone format), `list_entries`,
  `get_entry`
- `strapi:content:write`: `create_entry`, `update_entry`, `discard_draft`
- `strapi:content:publish`: `publish_entry`, `unpublish_entry`
- `strapi:content:delete`: `delete_entry`
- `strapi:media:read`: `list`, `get`, `list_folders`
- `strapi:media:write`: `upload`, `request_upload`, `update`, `move`,
  `create_folder`, `rename_folder`, `move_folder`
- `strapi:media:delete`: `delete`, `delete_folder` (`delete_folder` checks every file inside
  with `forbiddenFiles` before cascading; Strapi's own bulk delete doesn't)

Names use underscores; dotted 0.1 names still work as `tools.enabled` keys.
Populate paths are turned into Strapi populate objects by `buildPopulate`,
which uses `on: { '<component>': … }` for dynamic zones. Every upload path
ends in `storeUpload()`. Placing tools take `folderId` or `folderPath`
(`ensureFolderPath` = mkdir -p). Third-party tools register through
`tool-registry` (`strapi_` prefix reserved).

`runTool` in `mcp-server.ts` enforces `requestTimeoutMs` on read-only tools only
(a race can't cancel a half-done write, so writes run to completion), audits (skipping
successful reads when `audit.recordReads` is false) and maps errors to stable
codes: `insufficient_scope`, `forbidden`, `not_found`, `bad_request`,
`timeout`, `upload_provider_error`, `internal_error` (generic message).
Content-type schemas are also MCP resources (`strapi://content-types/{uid}/schema`).

## OAuth client owner / creator semantics

`oauth-client` rows carry two admin-id fields:

- `createdByAdminId` — who made the client appear in the table. UI: the
  admin who clicked Create. DCR: backfilled to the first admin who grants
  consent. Null ⇒ shown as unverified on the consent screen.
- `ownerAdminId` — who granted consent. Null until first approval.

The orphan-purge predicate is `createdByAdminId IS NULL` plus no
consents/codes/tokens. On consent grant, sibling DCR registrations with the
same name + port-agnostic redirect URI signature are deleted (with their
`oauth.dcr.register` audit rows). Admin API responses never include
`clientSecretHash`.
