import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResendMailer } from './mailer.js';

// Capture the JSON body the Resend driver POSTs, without hitting the wire.
function stubFetch() {
  const calls: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '' } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('createResendMailer', () => {
  afterEach(() => vi.unstubAllGlobals());

  const base = { apiKey: 'k', from: 'Thalermark <hello@thalermark.com>' };
  const msg = { to: 'c@x.test', subject: 's', html: '<p>h</p>', text: 't' };

  it('uses the driver default from when no override is given', async () => {
    const calls = stubFetch();
    await createResendMailer(base).send(msg);
    expect(calls[0]?.from).toBe('Thalermark <hello@thalermark.com>');
    expect(calls[0]).not.toHaveProperty('reply_to');
  });

  it('applies a per-message from override', async () => {
    const calls = stubFetch();
    await createResendMailer(base).send({ ...msg, from: '"Sunny" <hello@thalermark.com>' });
    expect(calls[0]?.from).toBe('"Sunny" <hello@thalermark.com>');
  });

  it('sends reply_to (snake_case) only when replyTo is set', async () => {
    const calls = stubFetch();
    await createResendMailer(base).send({ ...msg, replyTo: 'me@biz.test' });
    expect(calls[0]?.reply_to).toBe('me@biz.test');
  });

  it('throws when Resend returns a non-ok status', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 422, text: async () => 'bad' }));
    await expect(createResendMailer(base).send(msg)).rejects.toThrow('resend_send_failed: 422');
  });
});
