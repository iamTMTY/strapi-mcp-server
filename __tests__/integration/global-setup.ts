'use strict';

import { startServer } from '../helpers/test-server';

// Boots the fixture Strapi app once for the entire integration test run.
// Jest stores the returned handle on `globalThis` so global-teardown can find
// it (Jest's module isolation hides the in-memory module state otherwise).
export default async function globalSetup(): Promise<void> {
  const handle = await startServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__MCP_TEST_SERVER__ = handle;
}
