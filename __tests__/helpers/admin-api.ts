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
let cachedAdmin: Promise<AdminAuthResult> | null = null;

/** Cached per test file — Strapi rate-limits /admin/login. */
export function ensureAdmin(): Promise<AdminAuthResult> {
  cachedAdmin ??= ensureAdminUncached().catch((err) => {
    cachedAdmin = null;
    throw err;
  });
  return cachedAdmin;
}

async function ensureAdminUncached(): Promise<AdminAuthResult> {
  try {
    return await ensureAdminOnce();
  } catch (err) {
    // Parallel test files race to register the first admin; the loser just logs in.
    // …or logs in a moment before the winner's registration commits.
    if (
      !/cannot register a new super admin|admin exists but login failed/.test(
        (err as Error).message
      )
    )
      throw err;
    await new Promise((r) => setTimeout(r, 250));
    return ensureAdminOnce();
  }
}

async function ensureAdminOnce(): Promise<AdminAuthResult> {
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

/**
 * Create (once) and log in a non-super-admin user with the given built-in
 * role code, e.g. 'strapi-author'. Used for RBAC tests.
 */
export async function ensureRoleUser(roleCode: string): Promise<AdminAuthResult> {
  const email = `${roleCode}@test.local`;
  const password = 'TestPass1!';
  const login = await request(`${TEST_BASE_URL}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (login.statusCode === 200)
    return ((await login.body.json()) as { data: AdminAuthResult }).data;
  await login.body.text();

  const { token } = await ensureAdmin();
  const roles = (await adminFetch('/admin/roles', { token })).body as {
    data: Array<{ id: number; code: string }>;
  };
  const role = roles.data.find((r) => r.code === roleCode);
  if (!role) throw new Error(`role ${roleCode} not found`);
  const created = await adminFetch('/admin/users', {
    method: 'POST',
    token,
    body: { firstname: roleCode, lastname: 'User', email, roles: [role.id] },
  });
  const registrationToken = (created.body as { data?: { registrationToken?: string } }).data
    ?.registrationToken;
  if (!registrationToken) throw new Error(`create user failed: ${JSON.stringify(created.body)}`);
  const reg = await request(`${TEST_BASE_URL}/admin/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      registrationToken,
      userInfo: { firstname: roleCode, lastname: 'User', password },
    }),
  });
  if (reg.statusCode !== 200)
    throw new Error(`register failed: ${reg.statusCode} ${await reg.body.text()}`);
  return ((await reg.body.json()) as { data: AdminAuthResult }).data;
}

/**
 * Set the i18n `locales` property on a role's permissions for one subject,
 * via the same API the Roles page uses. Strapi creates default role
 * permissions without it for types localized later — meaning no locale access.
 */
export async function setRoleLocales(
  roleCode: string,
  subject: string,
  locales: string[]
): Promise<void> {
  const { token } = await ensureAdmin();
  const roles = (await adminFetch('/admin/roles', { token })).body as {
    data: Array<{ id: number; code: string }>;
  };
  const role = roles.data.find((r) => r.code === roleCode);
  if (!role) throw new Error(`role ${roleCode} not found`);
  const current = (await adminFetch(`/admin/roles/${role.id}/permissions`, { token })).body as {
    data: Array<{
      action: string;
      subject: string | null;
      properties: Record<string, unknown>;
      conditions: string[];
    }>;
  };
  const permissions = current.data.map(({ action, subject: s, properties, conditions }) => ({
    action,
    subject: s,
    properties: s === subject ? { ...properties, locales } : properties,
    conditions,
  }));
  const res = await adminFetch(`/admin/roles/${role.id}/permissions`, {
    method: 'PUT',
    token,
    body: { permissions },
  });
  if (res.status !== 200)
    throw new Error(`update permissions failed: ${res.status} ${JSON.stringify(res.body)}`);
}
