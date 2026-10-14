/**
 * The plugin is installed via a `file:../../..` dependency, which npm
 * resolves to a symlink (or junction on Windows) at
 * `node_modules/strapi-mcp-server/` pointing at the plugin source. That way:
 *   - Strapi discovers it through the normal package.json dependencies path
 *   - The plugin and Strapi share one copy of `@strapi/utils` (the fixture's),
 *     so `errors.UnauthorizedError instanceof` checks work as expected
 *   - Edits to the plugin's `dist/` are picked up on the next Strapi boot
 */
export default ({
  env,
}: {
  env: {
    (key: string, fallback?: string): string;
    bool(key: string, fallback?: boolean): boolean;
    array(key: string, fallback?: string[]): string[];
    int(key: string, fallback?: number): number;
  };
}) => ({
  'mcp-server': {
    enabled: true,
    config: {
      resourceUrl: env('MCP_RESOURCE_URL', 'http://localhost:1337/mcp'),
      allowedOrigins: env.array('MCP_ALLOWED_ORIGINS', ['http://localhost:1337']),
      // The suite makes hundreds of calls as one admin; don't let the
      // default per-principal limit turn into flaky failures.
      // TEST FIXTURE ONLY. Publish and delete tools are deliberately off by
      // default in the plugin; this opts in the same way a real project must
      // (tools.enabled), because the suite exercises those tools.
      tools: {
        enabled: {
          strapi_content_publish_entry: true,
          strapi_content_unpublish_entry: true,
          strapi_content_delete_entry: true,
          strapi_media_delete: true,
          strapi_media_delete_folder: true,
        },
      },
      rateLimit: {
        perPrincipal: { capacity: 10000, refillPerSec: 1000 },
        perIp: { capacity: 10000, refillPerSec: 1000 },
      },
      oauth: {
        // Keep DCR off by default so the fixture matches the plugin's default
        // posture. Individual tests can override via the admin Settings page.
        dcr: { enabled: env.bool('MCP_DCR_ENABLED', false), ratelimitPerHour: 60 },
      },
    },
  },
});
