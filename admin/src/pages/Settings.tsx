import { useEffect, useState } from 'react';
import { Box, Flex, Typography, TextInput, Textarea, Grid } from '@strapi/design-system';
import { useMcpApi } from '../lib/api';
import { PageHeader } from '../components/PageHeader';

interface McpConfig {
  enabled: boolean;
  resourceUrl: string;
  allowedOrigins: string[];
  oauth: {
    mode: string;
    accessTokenTtlSec: number;
    refreshTokenTtlSec: number;
    authCodeTtlSec: number;
    ssoCookieTtlSec: number;
    dcr: { enabled: boolean; ratelimitPerHour: number };
    consent: { rememberDays: number };
    introspection: { allowedIps: string[] };
    external?: {
      issuer: string;
      jwksUri: string;
      adminLookupClaim?: string;
      enforceScopes?: boolean;
    };
  };
  session: {
    idleTtlMs: number;
    hardTtlMs: number;
    maxPerPrincipal: number;
    maxTotal: number;
    sweepIntervalMs: number;
  };
  rateLimit: {
    perPrincipal: { capacity: number; refillPerSec: number };
    perIp: { capacity: number; refillPerSec: number };
  };
  upload: {
    maxBytes: number;
    mimeAllowlist: string[];
    allowSvg: boolean;
  };
  audit: {
    retentionDays: number;
    redactKeyPatterns: string[];
    drainIntervalMs: number;
    drainBatchSize: number;
  };
  tools: { enabled: Record<string, boolean> };
  redis?: {
    enabled: boolean;
    url: string;
    keyPrefix?: string;
    instanceId?: string;
    internalAddress?: string;
    internalSecret?: string;
    heartbeatIntervalMs?: number;
    heartbeatTtlMs?: number;
  };
}

function Field({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number | boolean;
  hint?: string;
}): JSX.Element {
  return (
    <Box>
      <Typography variant="pi" fontWeight="bold" textColor="neutral800">
        {label}
      </Typography>
      <Box paddingTop={2}>
        <TextInput name={label} value={String(value)} disabled aria-readonly />
      </Box>
      {hint && (
        <Box paddingTop={1}>
          <Typography variant="pi" textColor="neutral600">
            {hint}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

function MultilineField({
  label,
  value,
  hint,
  rows = 3,
}: {
  label: string;
  value: string;
  hint?: string;
  rows?: number;
}): JSX.Element {
  return (
    <Box>
      <Typography variant="pi" fontWeight="bold" textColor="neutral800">
        {label}
      </Typography>
      <Box paddingTop={2}>
        <Textarea name={label} value={value} disabled rows={rows} />
      </Box>
      {hint && (
        <Box paddingTop={1}>
          <Typography variant="pi" textColor="neutral600">
            {hint}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <Box background="neutral0" padding={6} hasRadius shadow="tableShadow">
      <Box paddingBottom={4}>
        <Typography variant="delta" tag="h2">
          {title}
        </Typography>
      </Box>
      {children}
    </Box>
  );
}

function formatToolsEnabled(record: Record<string, boolean>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return '(empty — all tools enabled)';
  return entries.map(([name, on]) => `${name} = ${on}`).join('\n');
}

export function Settings(): JSX.Element {
  const api = useMcpApi();
  const [cfg, setCfg] = useState<McpConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then(setCfg)
      .catch((err: Error) => setError(err.message ?? String(err)));
  }, []);

  return (
    <Box>
      <PageHeader title="Settings" />

      {error && (
        <Box background="danger100" padding={4} hasRadius marginBottom={6}>
          <Typography textColor="danger700">Failed to load settings: {error}</Typography>
        </Box>
      )}

      {!cfg && !error && <Typography>Loading…</Typography>}

      {cfg && (
        <Flex direction="column" gap={6} alignItems="stretch">
          <Box background="neutral150" padding={4} hasRadius>
            <Typography variant="omega" textColor="neutral700">
              These values are configured in <code>config/plugins.js</code>. Secrets
              (Redis password, internal secret) are masked.
            </Typography>
          </Box>

          <Card title="Server">
            <Grid.Root gap={5}>
              <Grid.Item col={4} s={12} direction="column" alignItems="stretch">
                <Field
                  label="Enabled"
                  value={cfg.enabled}
                  hint="Master switch. When false, /mcp and /oauth/* are unmounted and the plugin does nothing."
                />
              </Grid.Item>
              <Grid.Item col={8} s={12} direction="column" alignItems="stretch">
                <Field
                  label="Resource URL"
                  value={cfg.resourceUrl}
                  hint="Canonical URL clients reach this MCP server at. Used as the JWT aud claim and the OAuth resource indicator. Must match what clients actually connect to."
                />
              </Grid.Item>
              <Grid.Item col={12} direction="column" alignItems="stretch">
                <MultilineField
                  label="Allowed origins"
                  value={cfg.allowedOrigins.join('\n')}
                  hint="One per line — used for DNS-rebinding protection on /mcp and /oauth/*. Requests with an Origin header outside this list are rejected."
                />
              </Grid.Item>
            </Grid.Root>
          </Card>

          <Card title="OAuth">
            <Grid.Root gap={5}>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Mode"
                  value={cfg.oauth.mode}
                  hint="embedded = this plugin issues tokens. external = trust JWTs from an outside IdP (Auth0, Keycloak, …)."
                />
              </Grid.Item>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Access token TTL (sec)"
                  value={cfg.oauth.accessTokenTtlSec}
                  hint="Lifetime of bearer tokens minted at /oauth/token. Short on purpose to limit damage from a leaked token."
                />
              </Grid.Item>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Refresh token TTL (sec)"
                  value={cfg.oauth.refreshTokenTtlSec}
                  hint="Lifetime of the refresh token that can mint new access tokens. Rotated on every use; reuse invalidates the whole family."
                />
              </Grid.Item>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Auth code TTL (sec)"
                  value={cfg.oauth.authCodeTtlSec}
                  hint="Lifetime of the one-shot code returned to the redirect URI. Single-use and short to mitigate interception."
                />
              </Grid.Item>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="SSO cookie TTL (sec)"
                  value={cfg.oauth.ssoCookieTtlSec}
                  hint="How long the consent-screen session is remembered after a successful admin login before re-authentication is required."
                />
              </Grid.Item>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="DCR enabled"
                  value={cfg.oauth.dcr.enabled}
                  hint="Dynamic Client Registration — when on, MCP clients can self-register via POST /oauth/register. Admin still approves consent."
                />
              </Grid.Item>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="DCR rate limit / hour"
                  value={cfg.oauth.dcr.ratelimitPerHour}
                  hint="Max self-registrations per source IP per hour. Excess returns 429."
                />
              </Grid.Item>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Consent remember (days)"
                  value={cfg.oauth.consent.rememberDays}
                  hint="0 = always prompt the admin. N > 0 = skip prompt if the same client + scope set was approved in the last N days."
                />
              </Grid.Item>
              <Grid.Item col={12} direction="column" alignItems="stretch">
                <MultilineField
                  label="Introspection allowed IPs"
                  value={cfg.oauth.introspection.allowedIps.join('\n')}
                  hint="Source IPs allowed to call POST /oauth/introspect. Defaults to loopback only — RFC 7662 is meant for internal RS callers, not the public internet."
                />
              </Grid.Item>
              {cfg.oauth.external && (
                <>
                  <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
                    <Field
                      label="External issuer"
                      value={cfg.oauth.external.issuer}
                      hint="OIDC issuer URL of the external IdP. Used to verify the iss claim on inbound JWTs."
                    />
                  </Grid.Item>
                  <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
                    <Field
                      label="External JWKS URI"
                      value={cfg.oauth.external.jwksUri}
                      hint="Public keys URL used to verify JWT signatures from the external IdP."
                    />
                  </Grid.Item>
                  <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
                    <Field
                      label="Admin lookup claim"
                      value={cfg.oauth.external.adminLookupClaim ?? 'email'}
                      hint="JWT claim used to find the matching Strapi admin user. Default: email."
                    />
                  </Grid.Item>
                  <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
                    <Field
                      label="Enforce scopes"
                      value={cfg.oauth.external.enforceScopes ?? false}
                      hint="When true, JWTs must carry strapi:* scopes (you must define them in your IdP). When false (default), Strapi RBAC alone gates tool access."
                    />
                  </Grid.Item>
                </>
              )}
            </Grid.Root>
          </Card>

          <Card title="Sessions">
            <Grid.Root gap={5}>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Idle TTL (ms)"
                  value={cfg.session.idleTtlMs}
                  hint="A session is evicted if it sees no traffic for this long."
                />
              </Grid.Item>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Hard TTL (ms)"
                  value={cfg.session.hardTtlMs}
                  hint="A session is force-closed at this age regardless of activity."
                />
              </Grid.Item>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Max per principal"
                  value={cfg.session.maxPerPrincipal}
                  hint="Cap on concurrent sessions per admin user. Oldest is evicted past this."
                />
              </Grid.Item>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Max total"
                  value={cfg.session.maxTotal}
                  hint="Cap on concurrent sessions per Node process. New connects beyond this get 503."
                />
              </Grid.Item>
              <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Sweep interval (ms)"
                  value={cfg.session.sweepIntervalMs}
                  hint="How often the in-process sweeper scans for expired sessions to evict."
                />
              </Grid.Item>
            </Grid.Root>
          </Card>

          <Card title="Rate limit">
            <Grid.Root gap={5}>
              <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
                <Field
                  label="Per principal — capacity"
                  value={cfg.rateLimit.perPrincipal.capacity}
                  hint="Token bucket size per admin user. Burst budget before throttling kicks in."
                />
              </Grid.Item>
              <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
                <Field
                  label="Per principal — refill / sec"
                  value={cfg.rateLimit.perPrincipal.refillPerSec}
                  hint="Bucket refill rate per admin user — the steady-state requests-per-second allowance."
                />
              </Grid.Item>
              <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
                <Field
                  label="Per IP — capacity"
                  value={cfg.rateLimit.perIp.capacity}
                  hint="Token bucket size per source IP. Defense layer above the per-principal limit."
                />
              </Grid.Item>
              <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
                <Field
                  label="Per IP — refill / sec"
                  value={cfg.rateLimit.perIp.refillPerSec}
                  hint="Bucket refill rate per source IP."
                />
              </Grid.Item>
            </Grid.Root>
          </Card>

          <Card title="Uploads">
            <Grid.Root gap={5}>
              <Grid.Item col={4} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Max bytes"
                  value={cfg.upload.maxBytes}
                  hint="Largest single file accepted by strapi.media.upload."
                />
              </Grid.Item>
              <Grid.Item col={4} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Allow SVG"
                  value={cfg.upload.allowSvg}
                  hint="When false (recommended), SVG uploads are rejected. SVG can carry script tags and is XSS-risky if served in an img element."
                />
              </Grid.Item>
              <Grid.Item col={12} direction="column" alignItems="stretch">
                <MultilineField
                  label="MIME allowlist"
                  value={cfg.upload.mimeAllowlist.join('\n')}
                  hint="Only files whose detected MIME type appears in this list may be uploaded. One per line."
                />
              </Grid.Item>
            </Grid.Root>
          </Card>

          <Card title="Audit">
            <Grid.Root gap={5}>
              <Grid.Item col={4} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Retention (days)"
                  value={cfg.audit.retentionDays}
                  hint="Audit rows older than this are deleted by the nightly cron."
                />
              </Grid.Item>
              <Grid.Item col={4} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Drain interval (ms)"
                  value={cfg.audit.drainIntervalMs}
                  hint="How often the in-memory audit queue is flushed to the DB."
                />
              </Grid.Item>
              <Grid.Item col={4} s={6} xs={12} direction="column" alignItems="stretch">
                <Field
                  label="Drain batch size"
                  value={cfg.audit.drainBatchSize}
                  hint="Buffered audit writes also flush when the queue reaches this size, so bursts don't sit in memory."
                />
              </Grid.Item>
              <Grid.Item col={12} direction="column" alignItems="stretch">
                <MultilineField
                  label="Redact key patterns"
                  value={cfg.audit.redactKeyPatterns.join('\n')}
                  hint="Tool-call param keys matching any of these (case-insensitive substring) are stored as [redacted]. One pattern per line."
                />
              </Grid.Item>
            </Grid.Root>
          </Card>

          <Card title="Tools">
            <Grid.Root gap={5}>
              <Grid.Item col={12} direction="column" alignItems="stretch">
                <MultilineField
                  label="Per-tool toggles"
                  value={formatToolsEnabled(cfg.tools.enabled)}
                  hint="Override individual tool availability. Anything not listed defaults to enabled. Listed with `= false` is hidden from the catalog."
                  rows={Math.max(3, Object.keys(cfg.tools.enabled).length + 1)}
                />
              </Grid.Item>
            </Grid.Root>
          </Card>

          <Card title="Redis (horizontal scale)">
            {!cfg.redis ? (
              <Typography variant="omega" textColor="neutral600">
                Redis is not configured. The plugin runs single-instance with process-local
                state. Add a <code>redis</code> block to plugin config to share rate-limit
                buckets across nodes (and optionally enable session routing).
              </Typography>
            ) : (
              <Grid.Root gap={5}>
                <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
                  <Field
                    label="Enabled"
                    value={cfg.redis.enabled}
                    hint="When off, process-local state only. When on, rate-limiter buckets are shared across instances."
                  />
                </Grid.Item>
                <Grid.Item col={9} s={12} direction="column" alignItems="stretch">
                  <Field
                    label="URL"
                    value={cfg.redis.url}
                    hint="Redis connection string. Must start with redis:// or rediss://. Password is masked."
                  />
                </Grid.Item>
                <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
                  <Field
                    label="Key prefix"
                    value={cfg.redis.keyPrefix ?? ''}
                    hint="Prefix on every Redis key this plugin creates. Helps coexist with other apps on a shared Redis."
                  />
                </Grid.Item>
                <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
                  <Field
                    label="Instance ID"
                    value={cfg.redis.instanceId ?? ''}
                    hint="This Node process's identifier in the cluster. Auto-generated when blank."
                  />
                </Grid.Item>
                <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
                  <Field
                    label="Internal address"
                    value={cfg.redis.internalAddress ?? ''}
                    hint="Internal URL peers use to proxy session traffic to this instance. Setting this AND the secret enables cross-instance session routing — any node can serve any session."
                  />
                </Grid.Item>
                <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
                  <Field
                    label="Internal secret"
                    value={cfg.redis.internalSecret ?? ''}
                    hint="Shared HMAC secret used to authenticate cross-instance proxy calls. Must be at least 32 high-entropy characters. Stored value masked here."
                  />
                </Grid.Item>
                <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
                  <Field
                    label="Heartbeat interval (ms)"
                    value={cfg.redis.heartbeatIntervalMs ?? 10000}
                    hint="How often this instance refreshes its alive-key. Peers use this to know which instances are reachable."
                  />
                </Grid.Item>
                <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
                  <Field
                    label="Heartbeat TTL (ms)"
                    value={cfg.redis.heartbeatTtlMs ?? 30000}
                    hint="Lifetime of the heartbeat key. Should be at least 3x the interval to avoid spurious 'instance is dead' detections on transient hiccups."
                  />
                </Grid.Item>
              </Grid.Root>
            )}
          </Card>
        </Flex>
      )}
    </Box>
  );
}
