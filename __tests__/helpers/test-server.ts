'use strict';

import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { request } from 'undici';

/** Where the spawned Strapi process listens. */
export const TEST_BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:11337';

interface ServerHandle {
  proc: ChildProcess;
  baseUrl: string;
  dbFile: string;
  shutdown: () => Promise<void>;
}

let handle: ServerHandle | null = null;

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'test-app');
const READY_TIMEOUT_MS = 60_000;

/**
 * Start the fixture Strapi app on a unique port. Resolves once the server
 * answers /admin/init successfully (means the Koa app is mounted + DB schema
 * is migrated). Throws on timeout.
 *
 * The DB file is created in a temp dir so concurrent test runs and the
 * developer's manual `npm run develop` don't collide. Set `KEEP_DB=1` to
 * keep the file around for post-mortem inspection.
 */
export async function startServer(): Promise<ServerHandle> {
  if (handle) return handle;
  const port = Number(new URL(TEST_BASE_URL).port);
  const tmp = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  const dbFile = join(tmp, 'database.sqlite');

  // Strapi's TS build emits .js for source files but doesn't copy JSON. The
  // article content-type's `schema.json` won't be in dist/. Copy non-.ts files
  // from src/ into dist/src/ before boot so content-types resolve correctly.
  syncNonTsFilesToDist(join(FIXTURE_DIR, 'src'), join(FIXTURE_DIR, 'dist', 'src'));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_FILENAME: dbFile,
    APP_KEYS: 'test-key-1,test-key-2',
    API_TOKEN_SALT: 'test-api-token-salt-' + Math.random().toString(36).slice(2),
    ADMIN_JWT_SECRET: 'test-admin-jwt-secret-' + Math.random().toString(36).slice(2),
    TRANSFER_TOKEN_SALT: 'test-transfer-token-salt-' + Math.random().toString(36).slice(2),
    MCP_RESOURCE_URL: `http://127.0.0.1:${port}/mcp`,
    MCP_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
    MCP_DCR_ENABLED: 'false',
    // Quiet Strapi's marketing telemetry during tests.
    STRAPI_TELEMETRY_DISABLED: 'true',
    STRAPI_DISABLE_UPDATE_NOTIFICATION: 'true',
  };

  const proc = spawn('npm', ['run', 'start'], {
    cwd: FIXTURE_DIR,
    env,
    stdio: process.env.TEST_VERBOSE ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  if (!process.env.TEST_VERBOSE) {
    proc.stdout?.on('data', () => undefined);
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(baseUrl, READY_TIMEOUT_MS, proc, () => stderr);

  const shutdown = async () => {
    if (proc.pid && !proc.killed) {
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          resolve();
        }, 5000);
        proc.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (!process.env.KEEP_DB) {
      if (existsSync(dbFile)) {
        try {
          unlinkSync(dbFile);
        } catch {
          /* race with another teardown */
        }
      }
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  };

  handle = { proc, baseUrl, dbFile, shutdown };
  return handle;
}

export function getServer(): ServerHandle {
  if (!handle) {
    throw new Error(
      'test server not started — make sure jest globalSetup is configured for the integration project'
    );
  }
  return handle;
}

async function waitForReady(
  baseUrl: string,
  timeoutMs: number,
  proc: ChildProcess,
  stderr: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `test server exited with code ${proc.exitCode} during boot:\n${stderr().slice(-2000)}`
      );
    }
    try {
      // /admin/init is the cheapest endpoint that exists once Strapi finishes
      // booting AND that returns 200 unauthenticated. /admin/users/me would
      // require auth.
      const resp = await request(`${baseUrl}/admin/init`);
      if (resp.statusCode === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(500);
  }
  throw new Error(
    `test server did not become ready within ${timeoutMs}ms.\nlast error: ${String(lastErr)}\nstderr tail:\n${stderr().slice(-2000)}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function syncNonTsFilesToDist(srcDir: string, distDir: string): void {
  if (!existsSync(srcDir)) return;
  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const distPath = join(distDir, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      syncNonTsFilesToDist(srcPath, distPath);
    } else if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) {
      copyFileSync(srcPath, distPath);
    }
  }
}
