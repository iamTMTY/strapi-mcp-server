'use strict';

export default async function globalTeardown(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = (globalThis as any).__MCP_TEST_SERVER__ as
    | { shutdown: () => Promise<void> }
    | undefined;
  if (handle) await handle.shutdown();
}
