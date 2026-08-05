import { describe, expect, it } from 'vitest';
import { constructWebhookEvent, createStripeBundle, decimalDollarsToCents } from './stripe.js';

describe('createStripeBundle', () => {
  it('returns null when any required value is missing', () => {
    expect(createStripeBundle({})).toBeNull();
    expect(createStripeBundle({ secretKey: 'sk_test_x' })).toBeNull();
    expect(createStripeBundle({ secretKey: 'sk_test_x', publishableKey: 'pk_test_x' })).toBeNull();
  });

  it('builds the bundle when all three are present', () => {
    const bundle = createStripeBundle({
      secretKey: 'sk_test_xxx',
      publishableKey: 'pk_test_xxx',
      webhookSecret: 'whsec_xxx',
    });
    expect(bundle).not.toBeNull();
    expect(bundle?.publishableKey).toBe('pk_test_xxx');
    expect(bundle?.webhookSecrets).toEqual(['whsec_xxx']);
    expect(bundle?.client).toBeDefined();
  });

  it('treats whitespace-only env vars as missing', () => {
    expect(
      createStripeBundle({ secretKey: '  ', publishableKey: 'pk', webhookSecret: 'whsec' }),
    ).toBeNull();
  });

  // TMC-176 — a Connect install needs an endpoint per delivery scope, and each
  // endpoint has its own secret.
  it('splits a comma-separated webhook secret list', () => {
    const bundle = createStripeBundle({
      secretKey: 'sk_test_xxx',
      publishableKey: 'pk_test_xxx',
      webhookSecret: 'whsec_platform,whsec_connect',
    });
    expect(bundle?.webhookSecrets).toEqual(['whsec_platform', 'whsec_connect']);
  });

  it('trims entries and drops empties so a trailing comma is harmless', () => {
    const bundle = createStripeBundle({
      secretKey: 'sk_test_xxx',
      publishableKey: 'pk_test_xxx',
      webhookSecret: ' whsec_a , whsec_b ,',
    });
    expect(bundle?.webhookSecrets).toEqual(['whsec_a', 'whsec_b']);
  });

  it('returns null when the list holds nothing but separators', () => {
    expect(
      createStripeBundle({ secretKey: 'sk', publishableKey: 'pk', webhookSecret: ' , ' }),
    ).toBeNull();
  });
});

// TMC-176. Signature verification is exercised with the SDK's own sync test-header
// helper, so these stay unit tests — no DB, no network.
describe('constructWebhookEvent', () => {
  const payload = JSON.stringify({
    id: 'evt_test',
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_test' } },
  });

  function bundleWith(webhookSecret: string) {
    const bundle = createStripeBundle({
      secretKey: 'sk_test_signature_only',
      publishableKey: 'pk_test_x',
      webhookSecret,
    });
    if (!bundle) throw new Error('expected a bundle');
    return bundle;
  }

  it('verifies a delivery signed with the first secret', async () => {
    const bundle = bundleWith('whsec_platform,whsec_connect');
    const header = bundle.client.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_platform',
    });
    const event = await constructWebhookEvent(bundle, payload, header);
    expect(event.id).toBe('evt_test');
  });

  // The regression this ticket exists for: before the change, only the first
  // secret was ever tried, so the other endpoint's events were dropped as
  // invalid signatures and a captured payment went unrecorded.
  it('verifies a delivery signed with a later secret', async () => {
    const bundle = bundleWith('whsec_platform,whsec_connect');
    const header = bundle.client.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_connect',
    });
    const event = await constructWebhookEvent(bundle, payload, header);
    expect(event.id).toBe('evt_test');
  });

  it('throws when no configured secret matches', async () => {
    const bundle = bundleWith('whsec_platform,whsec_connect');
    const header = bundle.client.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_some_other_platform',
    });
    await expect(constructWebhookEvent(bundle, payload, header)).rejects.toThrow();
  });

  it('still verifies the single-secret install', async () => {
    const bundle = bundleWith('whsec_only');
    const header = bundle.client.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_only',
    });
    const event = await constructWebhookEvent(bundle, payload, header);
    expect(event.id).toBe('evt_test');
  });
});

describe('decimalDollarsToCents', () => {
  it('handles whole numbers', () => {
    expect(decimalDollarsToCents('150')).toBe(15000);
  });

  it('handles two-decimal money strings', () => {
    expect(decimalDollarsToCents('150.00')).toBe(15000);
    expect(decimalDollarsToCents('150.55')).toBe(15055);
    expect(decimalDollarsToCents('0.05')).toBe(5);
    expect(decimalDollarsToCents('0.50')).toBe(50);
  });

  it('handles single-decimal money strings', () => {
    expect(decimalDollarsToCents('10.5')).toBe(1050);
  });

  it('survives values that would lose precision via float multiplication', () => {
    expect(decimalDollarsToCents('0.10')).toBe(10);
    expect(decimalDollarsToCents('0.20')).toBe(20);
    expect(decimalDollarsToCents('0.30')).toBe(30);
  });

  it('rejects malformed input', () => {
    expect(() => decimalDollarsToCents('')).toThrow();
    expect(() => decimalDollarsToCents('abc')).toThrow();
    expect(() => decimalDollarsToCents('-1.00')).toThrow();
    expect(() => decimalDollarsToCents('1.2.3')).toThrow();
  });
});
