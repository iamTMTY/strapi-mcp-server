'use strict';

import { createHmac } from 'crypto';
import { verifySignature } from '../../server/src/services/proxy-client';

const SECRET = 'a'.repeat(64);

function sign(method: string, sessionId: string, body: string, ts: number): string {
  const bodyHash = body ? createHmac('sha256', SECRET).update(body).digest('hex') : '';
  const payload = `${method.toUpperCase()}|${sessionId}|${ts}|${bodyHash}`;
  const mac = createHmac('sha256', SECRET).update(payload).digest('hex');
  return `t=${ts};s=${mac}`;
}

describe('proxy-client.verifySignature', () => {
  const sessionId = 'abc-123';
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' });

  it('accepts a freshly-signed header', () => {
    const ts = Date.now();
    const header = sign('POST', sessionId, body, ts);
    expect(
      verifySignature({
        header,
        method: 'POST',
        sessionId,
        body,
        secret: SECRET,
      })
    ).toBe(true);
  });

  it('accepts mixed-case method (case-insensitive normalization)', () => {
    const ts = Date.now();
    const header = sign('POST', sessionId, body, ts);
    expect(
      verifySignature({ header, method: 'post', sessionId, body, secret: SECRET })
    ).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(
      verifySignature({
        header: undefined,
        method: 'POST',
        sessionId,
        body,
        secret: SECRET,
      })
    ).toBe(false);
  });

  it('rejects a malformed header', () => {
    expect(
      verifySignature({
        header: 'garbage',
        method: 'POST',
        sessionId,
        body,
        secret: SECRET,
      })
    ).toBe(false);
  });

  it('rejects when method is tampered', () => {
    const ts = Date.now();
    const header = sign('POST', sessionId, body, ts);
    expect(
      verifySignature({ header, method: 'GET', sessionId, body, secret: SECRET })
    ).toBe(false);
  });

  it('rejects when sessionId is tampered', () => {
    const ts = Date.now();
    const header = sign('POST', sessionId, body, ts);
    expect(
      verifySignature({ header, method: 'POST', sessionId: 'other', body, secret: SECRET })
    ).toBe(false);
  });

  it('rejects when body is tampered', () => {
    const ts = Date.now();
    const header = sign('POST', sessionId, body, ts);
    expect(
      verifySignature({
        header,
        method: 'POST',
        sessionId,
        body: '{"jsonrpc":"2.0","method":"tools/call"}',
        secret: SECRET,
      })
    ).toBe(false);
  });

  it('rejects when secret is wrong', () => {
    const ts = Date.now();
    const header = sign('POST', sessionId, body, ts);
    expect(
      verifySignature({
        header,
        method: 'POST',
        sessionId,
        body,
        secret: 'b'.repeat(64),
      })
    ).toBe(false);
  });

  it('rejects a stale timestamp (older than 30s)', () => {
    const ts = Date.now() - 60_000;
    const header = sign('POST', sessionId, body, ts);
    expect(
      verifySignature({ header, method: 'POST', sessionId, body, secret: SECRET })
    ).toBe(false);
  });

  it('rejects a future timestamp (clock skew > 30s)', () => {
    const ts = Date.now() + 60_000;
    const header = sign('POST', sessionId, body, ts);
    expect(
      verifySignature({ header, method: 'POST', sessionId, body, secret: SECRET })
    ).toBe(false);
  });

  it('rejects non-numeric timestamp', () => {
    expect(
      verifySignature({
        header: 't=notanumber;s=deadbeef',
        method: 'POST',
        sessionId,
        body,
        secret: SECRET,
      })
    ).toBe(false);
  });

  it('rejects empty signature', () => {
    expect(
      verifySignature({
        header: `t=${Date.now()};s=`,
        method: 'POST',
        sessionId,
        body,
        secret: SECRET,
      })
    ).toBe(false);
  });

  it('accepts empty body when both sign and verify pass empty', () => {
    const ts = Date.now();
    const header = sign('GET', sessionId, '', ts);
    expect(
      verifySignature({ header, method: 'GET', sessionId, body: '', secret: SECRET })
    ).toBe(true);
  });

  it('does not throw on signatures of wrong byte length', () => {
    const header = `t=${Date.now()};s=ff`; // 1 byte instead of 32
    expect(() =>
      verifySignature({ header, method: 'POST', sessionId, body, secret: SECRET })
    ).not.toThrow();
    expect(
      verifySignature({ header, method: 'POST', sessionId, body, secret: SECRET })
    ).toBe(false);
  });
});
