'use strict';

import type { Core } from '@strapi/strapi';
import { createHmac, timingSafeEqual } from 'crypto';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import type { Context } from 'koa';
import { URL } from 'url';
import { getConfig } from '../config';

const HEADER = 'x-mcp-proxy-auth';
const SKEW_MS = 30_000;

interface SignArgs {
  method: string;
  sessionId: string;
  body: string;
  secret: string;
  ts?: number;
}

function sign({ method, sessionId, body, secret, ts = Date.now() }: SignArgs): {
  header: string;
  ts: number;
} {
  const bodyHash = body
    ? createHmac('sha256', secret).update(body).digest('hex')
    : '';
  const payload = `${method.toUpperCase()}|${sessionId}|${ts}|${bodyHash}`;
  const mac = createHmac('sha256', secret).update(payload).digest('hex');
  return { header: `t=${ts};s=${mac}`, ts };
}

/**
 * Verify a `X-MCP-Proxy-Auth` header. Returns true on success; the receiver
 * MUST refuse the request on false.
 *
 * Defense-in-depth note: timing-safe compare of MACs, ±30s window on the
 * timestamp to bound replay. The HMAC includes the method, session id, and a
 * hash of the body so a stolen header can't be reused on a different request.
 */
export function verifySignature(args: {
  header: string | undefined;
  method: string;
  sessionId: string;
  body: string;
  secret: string;
}): boolean {
  if (!args.header) return false;
  const parts = Object.fromEntries(
    args.header.split(';').map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)];
    })
  );
  const ts = Number(parts.t);
  const provided = parts.s;
  if (!Number.isFinite(ts) || !provided) return false;
  if (Math.abs(Date.now() - ts) > SKEW_MS) return false;
  const { header } = sign({
    method: args.method,
    sessionId: args.sessionId,
    body: args.body,
    secret: args.secret,
    ts,
  });
  const expected = header.split(';')[1].slice(2);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Forward the current request to `address` (e.g. `http://10.0.0.5:1337`).
   * Streams the response (including SSE) back to the original client.
   *
   * Throws on transport-level failure (peer unreachable, TLS error). Callers
   * should catch and either respond 502 or invalidate the directory entry.
   */
  async forward(ctx: Context, address: string, sessionId: string): Promise<void> {
    const cfg = getConfig(strapi);
    const secret = cfg.redis?.internalSecret;
    if (!secret) {
      throw new Error('redis.internalSecret is required for cross-instance proxying');
    }

    const peer = new URL(address);
    peer.pathname = `/__mcp/proxy/${encodeURIComponent(sessionId)}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = (ctx.request as any).body;
    const bodyStr = parsed === undefined || parsed === null ? '' : JSON.stringify(parsed);
    const { header: authHeader } = sign({
      method: ctx.method,
      sessionId,
      body: bodyStr,
      secret,
    });

    const headers: Record<string, string> = {
      [HEADER]: authHeader,
      // Pass through what the SDK needs.
      accept: (ctx.request.header.accept as string) ?? 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    };
    if (bodyStr) {
      headers['content-type'] = (ctx.request.header['content-type'] as string) ?? 'application/json';
      headers['content-length'] = String(Buffer.byteLength(bodyStr));
    }
    // Forward the original Authorization header so audit / debugging can
    // trace it on the owner instance, though the owner trusts the HMAC and
    // does not re-verify the JWT.
    if (ctx.request.header.authorization) {
      headers.authorization = ctx.request.header.authorization as string;
    }

    const isHttps = peer.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;

    return new Promise<void>((resolve, reject) => {
      const upstream = reqFn(
        {
          protocol: peer.protocol,
          hostname: peer.hostname,
          port: peer.port || (isHttps ? 443 : 80),
          method: ctx.method,
          path: peer.pathname,
          headers,
          // SSE: never timeout
          timeout: 0,
        },
        (res) => {
          ctx.respond = false;
          ctx.res.statusCode = res.statusCode ?? 502;
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) ctx.res.setHeader(k, v as string | string[]);
          }
          res.on('error', (err) => {
            strapi.log.warn(`[mcp-server] proxy upstream error: ${err.message}`);
            try {
              ctx.res.end();
            } catch {
              /* socket already closed */
            }
          });
          res.pipe(ctx.res);
          res.on('end', () => resolve());
          ctx.req.on('close', () => {
            // Client disconnected — tear down the upstream connection so we
            // don't leak open sockets on the owner instance.
            upstream.destroy();
          });
        }
      );

      upstream.on('error', (err) => reject(err));

      if (bodyStr) upstream.write(bodyStr);
      upstream.end();
    });
  },

  /** Re-export verify helper so the receiver controller can use it. */
  verify: verifySignature,
});
