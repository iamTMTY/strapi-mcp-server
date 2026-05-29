# strapi-mcp-server

A standalone Strapi v5 plugin that exposes a Strapi instance as a Model
Context Protocol (MCP) server. AI clients (Claude Code, Claude web, Cursor,
opencode, …) connect over Streamable HTTP and call tools — content
read/write and media — gated by OAuth 2.1 + PKCE and the authenticated
admin user's Strapi RBAC permissions.

## Stack

- TypeScript, Node ≥ 18
- Strapi v5 plugin scaffold via `@strapi/sdk-plugin` (pack-up)
- `@modelcontextprotocol/sdk` for the MCP transport
- `jose` for JWT signing, `zod` for tool input validation
- Optional `ioredis` for horizontal scale (rate-limiter sharing + cross-instance session routing)
- Jest with two projects: `unit` and `integration`

## Common commands

```bash
npm run dev              # plugin watch:link + fixture test-app develop, concurrently
npm run build            # one-shot plugin build (dist/)
npm run test             # unit tests (default — 191 tests)
npm run test:integration # integration tests against a spawned fixture Strapi
npm run test:all         # both
npm run inspect          # @modelcontextprotocol/inspector against this server
npm run test-app:reset   # delete the fixture sqlite DB
```

The fixture Strapi app lives at `__tests__/fixtures/test-app/` and is an npm
workspace (`"strapi-mcp-server": "file:../../.."`). `npm run dev` runs the
plugin in watch mode and the test app together — edits to plugin source
rebuild and Strapi develop hot-reloads.

## Layout

```
server/src/
  bootstrap.ts                 # session sweeper, audit drainer, nightly cron
  register.ts                  # plugin registration, RBAC actions
  config/index.ts              # full McpConfig + validator
  content-types/               # internal — audit-log, oauth-client, auth-code, etc.
  controllers/
    mcp.ts                     # POST/GET/DELETE /mcp transport handler
    oauth/                     # /.well-known/*, /authorize, /token, /register, …
    admin/                     # /admin/plugins/mcp-server/* JSON endpoints
  policies/                    # origin, authenticate, scope, rateLimit
  routes/                      # mcp.ts (root-mounted), oauth.ts, admin.ts
  services/
    mcp-server.ts              # builds McpServer + transport per session
    session-store.ts           # local Map + Redis directory integration
    audit.ts                   # buffered async writes + redactor
    permissions.ts             # canActionOnUid via admin::permission engine
    rate-limiter.ts            # token-bucket; uses Redis when enabled
    redis.ts, instance-id.ts,
    heartbeat.ts,
    session-directory.ts,
    proxy-client.ts            # Redis cluster bits
    oauth/                     # tokens, signing-keys, scopes, clients, audience, errors
    tools/content.ts, media.ts # the MCP tool implementations

admin/src/                     # the Strapi admin SPA bits (sidebar, pages)
  pages/                       # Overview, Clients, Tools, AuditLog, Settings, NewClient
  lib/applyQuery.ts            # client-side _q + filters.$and + pagination
  components/                  # Sidebar (per-permission gated), PageHeader

__tests__/                     # unit/ and integration/
  fixtures/test-app/           # workspace: a real Strapi v5 app that loads the plugin
```

## Conventions and gotchas

- **Admin imports come from `@strapi/strapi/admin`, not `@strapi/admin`.**
  The former is peer-declared and externalized by pack-up; the latter ends
  up bundled twice (once in plugin, once in host) and breaks `useAuth`,
  `checkUserHasPermissions`, etc. Hooks like `useQueryParams`, `Pagination`,
  `Filters`, `SearchInput`, `useFetchClient` come from there.
- **Content-type `schema.json` must be copied to `dist/`.** Achieved via
  `tsconfig.json` glob `"src/**/*.json"` in `include`. Without it,
  `isSingleType` etc. are undefined at runtime.
- **`@strapi/utils` must be a single instance.** Achieved via npm workspaces
  (which hoists). `instanceof` checks on `UnauthorizedError` etc. break if
  two copies are loaded.
- **The fixture sqlite DB is at `__tests__/fixtures/test-app/.data/database.sqlite`**,
  deliberately outside `dist/` so Strapi develop's rebuilds don't wipe it.
- **All routes are `auth: false`** — the plugin's own `authenticate` policy
  parses the bearer token and attaches `ctx.state.mcpAuth`. The admin REST
  endpoints under `/admin/plugins/mcp-server/*` use the admin auth strategy
  - `admin::hasPermissions` instead.

## Security posture

- Default-deny, disabled-by-default (`config.enabled` false by default).
- PKCE S256 only — `plain` rejected. Strict per-client redirect URI allowlist
  with loopback-port leniency per RFC 8252 §7.3.
- Audience-bound tokens. Short access TTL (10 min default), rotating opaque
  refresh tokens (24h default) with reuse → family revocation.
- RS256 signing key generated on first boot, **encrypted at rest** via
  `strapi.service('admin::encryption')`. Never reuses `ADMIN_JWT_SECRET`.
- Every tool re-checks Strapi RBAC at call time (no caching across calls).
- Rate-limiter per-principal and per-IP. Audit writes are buffered and
  redacted (`password|token|secret|authorization|cookie|apikey` keys).
- DCR is **off by default**. When on, anyone can register a client — the
  admin consent screen is the real security gate either way.
- The `mcp_admin_sso` cookie is bound to the Strapi admin's `sessionId` and
  re-checked against `strapi.sessionManager('admin').isSessionActive` on
  every verify, so admin logout immediately invalidates it.

## Permission model

Three actions registered in `register.ts`:

- `plugin::mcp-server.read` — Overview, Tools, Settings
- `plugin::mcp-server.clients.manage` — full CRUD on the Clients page
- `plugin::mcp-server.audit.read` — Audit Log page

Sidebar items and admin routes are gated per-action via `useAuth` state and
`admin::hasPermissions` policies respectively. The top-level menu link
OR-matches all three so a role with only audit.read still sees the plugin.

## Tools

- `strapi.content.list_types` / `get_schema` / `list_entries` / `get_entry`
  (scope `strapi:content:read`)
- `strapi.content.create_entry` / `update_entry` — draft only, no publish
  (scope `strapi:content:write`)
- `strapi.media.list` (scope `strapi:media:read`)
- `strapi.media.upload` — MIME allowlist, size cap, SVG rejected by default
  (scope `strapi:media:write`)

Tools call `requireScope(scope)` and `requirePerm(uid, action)` at the top
of every handler. Errors thrown have a stable machine-readable `.code`
(`insufficient_scope`, `forbidden`, `internal_error`) plus a user-facing
`.message` ("You do not have permission to access this content."). The
transport wraps both into the MCP `{error, message, isError: true}` response.

## OAuth client owner / creator semantics

`oauth-client` rows carry two admin-id fields:

- `createdByAdminId` — who made the client appear in the table. UI: the
  admin who clicked Create. DCR: backfilled to the first admin who grants
  consent (DCR registration is unauthenticated).
- `ownerAdminId` — who granted consent. Null until first `/oauth/authorize`
  approval. Never set at creation time.

The orphan-purge predicate is `createdByAdminId IS NULL` plus no
consents/codes/tokens, so freshly UI-created clients aren't matched. On
consent grant, sibling DCR registrations with matching name + port-agnostic
redirect URI signature are deleted (alongside their `oauth.dcr.register`
audit row) so the table shows one client per logical MCP client.
