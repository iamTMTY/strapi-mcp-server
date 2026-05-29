'use strict';

import { request } from 'undici';
import { TEST_BASE_URL } from './test-server';

interface AdminUser {
  id: number;
  email: string;
  firstname: string;
  lastname: string;
}

interface AdminAuthResult {
  token: string;
  user: AdminUser;
}

const REGISTERED = {
  email: 'admin@test.local',
  password: 'TestPass1!',
  firstname: 'Test',
  lastname: 'Admin',
};

/**
 * On a freshly-booted Strapi, the admin DB is empty. The first user must be
 * registered via `/admin/register-admin`. Subsequent calls log in.
 *
 * Returns an admin JWT we can use to drive Strapi admin endpoints (e.g. to
 * create lower-privileged users for RBAC tests).
 */
export async function ensureAdmin(): Promise<AdminAuthResult> {
  // Try login first; if user doesn't exist yet, register.
  const login = await request(`${TEST_BASE_URL}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: REGISTERED.email, password: REGISTERED.password }),
  });
  if (login.statusCode === 200) {
    const body = (await login.body.json()) as { data: AdminAuthResult };
    return body.data;
  }

  const init = await request(`${TEST_BASE_URL}/admin/init`);
  const initBody = (await init.body.json()) as { data: { hasAdmin: boolean } };
  if (initBody.data.hasAdmin) {
    throw new Error(
      `admin exists but login failed (status ${login.statusCode}); seeded credentials wrong?`
    );
  }
  const reg = await request(`${TEST_BASE_URL}/admin/register-admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(REGISTERED),
  });
  if (reg.statusCode !== 200) {
    const body = await reg.body.text();
    throw new Error(`register-admin failed: ${reg.statusCode} ${body}`);
  }
  const regBody = (await reg.body.json()) as { data: AdminAuthResult };
  return regBody.data;
}

/**
 * Convenience wrapper for authenticated admin API calls. Returns the parsed
 * JSON body and the raw status code so tests can assert on either.
 */
export async function adminFetch(
  path: string,
  opts: { method?: string; body?: unknown; token: string } = { token: '' }
): Promise<{ status: number; body: unknown }> {
  const resp = await request(`${TEST_BASE_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      authorization: `Bearer ${opts.token}`,
      'content-type': 'application/json',
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.body.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* leave as text */
  }
  return { status: resp.statusCode, body: parsed };
}
