# Contributing to strapi-mcp-server

Thanks for your interest. This document covers everything you need to get a
local dev loop running, what the test surface looks like, what CI checks
your PR will face, and the conventions that keep changes reviewable.

For architecture orientation and the project's security posture, read
`CLAUDE.md` first — it covers the layout, gotchas, and design rules that
every change has to respect.

## Development setup

Prereqs: Node ≥ 18, npm 9+, git.

```bash
git clone <your fork>
cd strapi-mcp-server
npm install        # also installs the fixture test-app via npm workspaces
npm run build      # once, to populate dist/
npm run dev        # plugin watch + fixture Strapi develop, concurrently
```

The fixture Strapi app at `__tests__/fixtures/test-app/` is a real Strapi v5
project that consumes the plugin via the workspace link. `npm run dev`
rebuilds the plugin on every source change and Strapi hot-reloads.

First boot:

1. Visit http://localhost:1337/admin and create a super-admin.
2. Settings → Roles → grant your role the three `plugin::mcp-server.*`
   permissions you want to test against.
3. The "MCP Server" sidebar entry appears once your role has any of the
   three.

If the sqlite DB ever gets into a weird state: `npm run test-app:reset` and
restart `npm run dev`.

## Manually testing the OAuth + MCP flow

Use `@modelcontextprotocol/inspector`:

```bash
npm run inspect
```

This opens the inspector against `http://localhost:1337/mcp`. Walk:

- OAuth discovery → registration (DCR if enabled) → authorize → consent → token
- `initialize` → `list_tools` → call each tool
- Confirm RBAC-denied calls return `{error: "forbidden", ...}` with the
  user-facing message

For a Claude Code / claude.ai / Cursor end-to-end test, the README has
client-by-client connect snippets.

## Tests

```bash
npm run test              # unit only (default — fast)
npm run test:integration  # spawns the fixture Strapi via @strapi/strapi/testing
npm run test:all          # both
```

Unit tests use a mock `strapi` object (see `__tests__/helpers/strapi-mock.ts`).
Integration tests boot the fixture app on a random port and hit it over
HTTP with `undici`.

When you add a feature:

- **Service / policy change** → unit test in `__tests__/services/` or
  `__tests__/policies/`.
- **Route / wire-up change** → integration test if behavior is observable
  end-to-end (e.g. a new endpoint, a discovery field). Pure unit coverage
  is fine if it's internal.
- **Tool change** → both: unit-test the handler logic, integration-test
  the scope and RBAC enforcement.
- **Schema change** → add a fixture in the integration test if it affects
  query shape; otherwise unit-test the normalizer.

Tests assert on stable contracts. If you change an error message, update
the test to match the message — but if you change an error `code` you've
broken the contract; bump version and document it.

## Code conventions

- TypeScript strict. No `any` without an eslint-disable + reason comment.
- Services exported as `({ strapi }) => ({ method() {...} })` factories —
  Strapi conventional shape. Don't reach into other plugins' internals;
  use the documented `strapi.service('admin::X')` namespace.
- Routes use `auth: false` and chain plugin policies (`origin`,
  `authenticate`, `rateLimit`) — never disable a policy to "make it work."
- Errors thrown from tool handlers carry a stable `.code` (machine-readable)
  and a user-facing `.message` (no UID, no workarounds, no internal jargon).
- No new dependencies without a reason. We bias toward the standard library
  and the four runtime deps already in `package.json`.
- Run `npm run format` before committing — Prettier handles layout.

## CI

`.github/workflows/security.yml` runs Semgrep on every push and PR with
rulesets `p/owasp-top-ten`, `p/javascript`, `p/typescript`, `p/nodejs`,
`p/react`, `p/secrets`. Any ERROR-severity finding blocks the PR;
WARNING/INFO are reported but non-blocking. `.semgrepignore` excludes
generated/test paths.

If Semgrep flags something in your patch:

1. Read the finding — most are legitimate.
2. If it's a true positive, fix the underlying issue.
3. If it's a false positive specific to your patch, add a `// nosemgrep: <ruleId>`
   comment **with a one-line justification** rather than a blanket ignore.
4. If it's a false positive across the codebase, open a PR adding the rule
   to `.semgrepignore` and explain why in the PR description.

## Pull requests

- One logical change per PR. Refactors and feature work go in separate PRs.
- Title in the imperative ("add foo", "fix bar"), keep it under 70 chars.
- PR body must include:
  - **Summary** — what changed and why (1–3 bullets).
  - **Test plan** — what you ran locally; new tests added; manual
    verification steps for UI changes.
- Don't bump the package version in your PR — it's done at release time.

## Reporting security issues

Don't open a public GitHub issue for security findings. Email the maintainer
(see `package.json` `"author"`) with:

- A short description and impact assessment
- Reproduction steps or a PoC
- Affected version

You'll get a reply within 72 hours. Coordinated disclosure with a fix
window is appreciated.

Open an issue first to discuss before sinking time into a PR.
