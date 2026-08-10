import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeFailure, mapResendEvent, verifyResendSignature } from './resend-webhook.js';

// Asserted against payloads CAPTURED FROM RESEND, not written from memory
// (TMC-226).
//
// The whole point of tunnelling a live webhook into a local sink before writing
// this file was to stop guessing. Two of the assertions below only exist
// because the real events disagreed with what I would have assumed: bounces
// carry a `type` that is not always Permanent, and `email.delivered` can arrive
// before the `email.sent` for the same message.
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(
  readFileSync(resolve(here, '../../tests/fixtures/resend-webhook-events.json'), 'utf8'),
) as Record<string, { type: string; created_at: string; data: Record<string, unknown> }>;

const SECRET = 'whsec_dGhpcyBpcyBub3QgYSByZWFsIHNlY3JldCwgaXQgaXMgYSB0ZXN0';

function sign(rawBody: string, opts: { id?: string; timestamp?: string } = {}) {
  const id = opts.id ?? 'msg_2abc';
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');
  return { id, timestamp, signature: `v1,${signature}` };
}

describe('verifyResendSignature', () => {
  const rawBody = JSON.stringify(FIXTURES['email.delivered']);

  it('accepts a correctly signed delivery', () => {
    expect(verifyResendSignature({ secret: SECRET, headers: sign(rawBody), rawBody })).toEqual({
      ok: true,
    });
  });

  it('rejects a body that changed after signing', () => {
    const headers = sign(rawBody);
    // The attack this endpoint exists to refuse: a real signature stapled to a
    // payload naming somebody else's message.
    const tampered = rawBody.replace(/"email_id":"[^"]*"/, '"email_id":"attacker-chosen"');
    const result = verifyResendSignature({ secret: SECRET, headers, rawBody: tampered });
    expect(result).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects a signature made with a different secret', () => {
    const headers = sign(rawBody);
    const result = verifyResendSignature({
      secret: 'whsec_c29tZXRoaW5nIGVsc2U=',
      headers,
      rawBody,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a replay from outside the tolerance window', () => {
    const old = String(Math.floor(Date.now() / 1000) - 60 * 60);
    const headers = sign(rawBody, { timestamp: old });
    // Correctly signed — the signature is genuine and still verifies. Age is
    // what disqualifies it, which is the only thing standing between a captured
    // request and an unlimited replay.
    expect(verifyResendSignature({ secret: SECRET, headers, rawBody })).toEqual({
      ok: false,
      reason: 'timestamp outside tolerance',
    });
  });

  it('rejects a delivery with no signature headers at all', () => {
    const result = verifyResendSignature({
      secret: SECRET,
      headers: { id: undefined, timestamp: undefined, signature: undefined },
      rawBody,
    });
    expect(result).toEqual({ ok: false, reason: 'missing signature headers' });
  });

  it('accepts when any one of several offered signatures matches, for rotation', () => {
    const good = sign(rawBody);
    const headers = { ...good, signature: `v1,ZmFrZQ== ${good.signature}` };
    expect(verifyResendSignature({ secret: SECRET, headers, rawBody }).ok).toBe(true);
  });
});

describe('mapResendEvent', () => {
  it('maps a delivery to delivered', () => {
    const event = mapResendEvent(FIXTURES['email.delivered']);
    expect(event).toMatchObject({ status: 'delivered', detail: null });
    expect(event?.messageId).toBe(FIXTURES['email.delivered']?.data.email_id);
  });

  it('maps a permanent bounce to bounced, quoting the far end', () => {
    const event = mapResendEvent(FIXTURES['email.bounced']);
    expect(event?.status).toBe('bounced');
    // The far end's own words, not Resend's paragraph about sender reputation
    // — "user unknown" is the half the operator can act on.
    expect(event?.detail).toContain('user unknown');
  });

  it('does NOT treat a transient bounce as a bounce', () => {
    // The dangerous false positive. A soft bounce is a full mailbox or a
    // greylisting server; the provider retries and it usually lands. Flying a
    // red "this bounced" banner for mail that then arrives makes the user
    // re-key a correct address or apologise to a customer who got the message.
    const soft = structuredClone(FIXTURES['email.bounced']) as unknown as {
      data: { bounce: { type: string } };
    };
    soft.data.bounce.type = 'Transient';
    expect(mapResendEvent(soft)).toBeNull();
  });

  it('ignores a delivery delay', () => {
    // Captured from a real send to a domain with no MX record. Same reasoning
    // as the soft bounce: still in flight, not yet a failure.
    expect(mapResendEvent(FIXTURES['email.delivery_delayed'])).toBeNull();
  });

  it('maps a complaint to complained, adding no detail of its own', () => {
    // The banner already explains a spam report better than a second sentence
    // under it could.
    expect(mapResendEvent(FIXTURES['email.complained'])).toMatchObject({
      status: 'complained',
      detail: null,
    });
  });

  it('maps a send failure to failed, in words rather than a code', () => {
    const event = mapResendEvent(FIXTURES['email.failed']);
    expect(event?.status).toBe('failed');
    // `reached_daily_quota` must never reach a screen — the browser suite fails
    // the build on snake_case rendered as copy, which is the bug class this
    // catalogue exists to prevent.
    expect(event?.detail).not.toMatch(/_/);
    expect(event?.detail).toContain('daily limit');
  });

  it('prefers the event time over the dispatch time, for ordering', () => {
    const event = mapResendEvent(FIXTURES['email.delivered']);
    expect(event?.occurredAt.toISOString()).toBe(
      new Date(FIXTURES['email.delivered']?.data.created_at as string).toISOString(),
    );
  });

  it('ignores an event type it does not know', () => {
    expect(
      mapResendEvent({ type: 'email.opened', data: { email_id: 'x', created_at: '2026-01-01' } }),
    ).toBeNull();
  });

  it('ignores a payload with no message id, which is the only join key', () => {
    expect(
      mapResendEvent({ type: 'email.delivered', data: { created_at: '2026-01-01' } }),
    ).toBeNull();
  });

  it('ignores junk instead of throwing', () => {
    // This endpoint is reachable from the internet by anyone holding the
    // signing secret's output; a parse error must not be a 500.
    expect(mapResendEvent(null)).toBeNull();
    expect(mapResendEvent({})).toBeNull();
    expect(mapResendEvent({ type: 'email.delivered', data: { email_id: 'x' } })).toBeNull();
  });
});

describe('describeFailure', () => {
  it('says whose problem it is', () => {
    // A quota failure is OUR account, not the customer's address. Copy that
    // sends the user to check the recipient would cost them a phone call to
    // fix something that was never broken.
    const text = describeFailure('reached_daily_quota');
    expect(text).toContain('sending account');
    expect(text).not.toContain('address');
  });

  it('renders an unmapped code safely', () => {
    // Resend is free to add reasons. An unknown one still has to be printable.
    expect(describeFailure('some_future_reason')).toBe(
      'The email provider refused it: some future reason.',
    );
    expect(describeFailure('some_future_reason')).not.toMatch(/_/);
  });
});
