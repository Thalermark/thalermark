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

  // The join key for the delivery webhook (TMC-226). Resend answers a send with
  // `{ id }`, and that same value arrives later as `data.email_id` on every
  // event about the message — so without it, a bounce is something we can
  // verify and then cannot attach to any document.
  describe('the send receipt', () => {
    it('returns the id Resend assigned the message', async () => {
      vi.stubGlobal('fetch', async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: '38bc46e6-12d0-4d26-9a58-36f35c52a283' }),
      }));
      const receipt = await createResendMailer(base).send(msg);
      expect(receipt?.id).toBe('38bc46e6-12d0-4d26-9a58-36f35c52a283');
    });

    it('still resolves when the body cannot be read', async () => {
      // The mail is already sent by the time the body is parsed. Losing the id
      // costs delivery tracking; throwing here would cost the invoice — the
      // route would answer 502 and the caller would mark a delivered message
      // as failed. Note the SYNCHRONOUS throw: a response with no json method
      // is what the other stubs in this file are, and a trailing .catch()
      // never sees it.
      vi.stubGlobal('fetch', async () => ({ ok: true, status: 200 }));
      await expect(createResendMailer(base).send(msg)).resolves.toEqual({});
    });

    it('ignores a body with no usable id', async () => {
      vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }));
      await expect(createResendMailer(base).send(msg)).resolves.toEqual({});
    });
  });

  it('reports nothing from the console driver, which has no provider id', async () => {
    // Which is why the whole webhook half is inert on a self-host with no
    // email provider, rather than half-wired.
    const receipt = await createConsoleMailer({ from: base.from }).send(msg);
    expect(receipt).toBeUndefined();
  });
});
