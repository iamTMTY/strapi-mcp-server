import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, Typography } from '@strapi/design-system';

/**
 * Bridge route used by the OAuth /authorize flow when the user is not yet
 * holding a valid `mcp_admin_sso` cookie. The admin user is already logged
 * into Strapi (this route is admin-private). We obtain an admin JWT and POST
 * it to /oauth/sso-handoff, which sets the SSO cookie and tells us where to
 * redirect next.
 *
 * Never echoes the JWT anywhere visible; never logs it.
 */

/**
 * Strapi v5 keeps the admin JWT in one of three places, in priority order:
 *   1. localStorage["jwtToken"] (JSON-stringified)  ← persist mode
 *   2. document.cookie "jwtToken=<encoded>"          ← non-persist, after first refresh
 *   3. POST /admin/access-token with the httpOnly refresh cookie returns a
 *      fresh JWT in the response body.
 * Mirror that lookup, with (3) as the always-works fallback.
 */
async function getAdminToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;

  const fromLs = window.localStorage.getItem('jwtToken');
  if (fromLs) {
    try {
      const parsed = JSON.parse(fromLs);
      if (typeof parsed === 'string' && parsed) {
        return parsed;
      }
    } catch {
      return fromLs;
    }
  }

  const cookieMatch = document.cookie
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === 'jwtToken');
  if (cookieMatch && cookieMatch[1]) {
    const decoded = decodeURIComponent(cookieMatch[1]);
    if (decoded) {
      return decoded;
    }
  }

  try {
    const resp = await fetch('/admin/access-token', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { data?: { token?: string } };
    return data?.data?.token ?? null;
  } catch {
    return null;
  }
}

export function SsoBridge(): JSX.Element {
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = params.get('next') ?? '/admin';
    (async () => {
      const token = await getAdminToken();
      if (!token) {
        setError('No admin session detected. Please log in and try again.');
        return;
      }
      try {
        const resp = await fetch('/oauth/sso-handoff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ adminToken: token, next }),
        });
        if (!resp.ok) throw new Error(`handoff failed: ${resp.status}`);
        const data = (await resp.json()) as { next?: string };
        window.location.replace(data.next ?? next);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [params]);

  return (
    <Box padding={6}>
      <Typography>{error ?? 'Completing MCP authorization…'}</Typography>
    </Box>
  );
}
