/**
 * Same-origin path only — never follow `javascript:`, absolute or `//host` URLs.
 * Mirrors the server's check (control characters and `\` refused, since URL
 * parsing turns `/<TAB>/host` into `//host`), then confirms the resolved origin.
 */
export function isSafeLocalPath(p: unknown, origin = window.location.origin): p is string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return false;
  try {
    return new URL(p, origin).origin === origin;
  } catch {
    return false;
  }
}
