# test-app — strapi-mcp-server fixture

Minimal Strapi v5 app used for integration tests of `strapi-mcp-server`. Also runnable manually for hands-on plugin development.

The plugin is loaded from the parent source via `resolve:` in `config/plugins.ts` — no `npm install strapi-mcp-server` here. Edit the plugin source, run `npm run build` in the plugin root, then `npm run develop` here to pick up changes.

## Manual setup

```sh
# from this directory
cp .env.example .env
npm install
npm run build      # builds Strapi admin once
npm run develop    # starts on localhost:1337
```

First time, the admin UI will prompt you to register a Strapi admin. Then open Strapi admin → **MCP Server** to use the plugin's UI exactly like a real deployment.

## Reset

```sh
rm database.sqlite     # nukes all data including the admin user
npm run develop        # admin signup prompt comes back
```

## Used by integration tests

Tests under `__tests__/integration/*.test.ts` spawn this app as a child process via `__tests__/helpers/test-server.ts`, hit it with supertest, and tear down at the end. The CI test job runs `npm install && npm run build` in this directory once during setup; subsequent runs are fast.
