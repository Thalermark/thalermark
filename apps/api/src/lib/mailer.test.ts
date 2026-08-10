import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Mailer, createConsoleMailer, createResendMailer, mailerDelivers } from './mailer.js';

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

// TMC-212. The console driver resolves successfully having sent nothing, which
// is indistinguishable from a real send — so the app claimed delivery it could
// not vouch for. This is the one predicate everything else keys off.
describe('mailerDelivers', () => {
  it('is false for the console driver, which only logs', () => {
    const console = createConsoleMailer({ from: 'Thalermark <hello@thalermark.com>' });
    expect(console.logsOnly).toBe(true);
    expect(mailerDelivers(console)).toBe(false);
  });

  it('is true for the Resend driver', () => {
    const resend = createResendMailer({ apiKey: 'k', from: 'Thalermark <hello@thalermark.com>' });
    expect(resend.logsOnly).toBeUndefined();
    expect(mailerDelivers(resend)).toBe(true);
  });

  it('treats an unmarked mailer as a real transport', () => {
    // The default that keeps the change additive: every recorder in the
    // integration suite, and any transport a commercial embedder wires through
    // the public barrel, omits the marker and must still count as delivering.
    const custom: Mailer = { async send() {} };
    expect(mailerDelivers(custom)).toBe(true);
  });

  it('treats a missing mailer as delivering nothing', () => {
    expect(mailerDelivers(undefined)).toBe(false);
    expect(mailerDelivers(null)).toBe(false);
  });
});

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
