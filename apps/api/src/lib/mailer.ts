import { getLogger } from '@thalermark/logger';

// Mailer abstraction. Two drivers in MVP:
//   - resend  — SaaS default. Posts to api.resend.com via fetch; no SDK dep
//               (keeps node_modules light and avoids a transitive surface).
//   - console — dev / self-host fallback. Logs the message + URL so operators
//               can grab the recipient link without running a transport.
// SMTP via nodemailer lands in a later slice when the first self-host
// operator needs it (JIT — no second consumer yet).
//
// Driver selection happens in server.ts: RESEND_API_KEY set → resend, else
// console. Integration tests inject their own recorder.

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  // Per-message sender override. When set, replaces the driver's default
  // `from` — used to swap the display name to the sending company's name while
  // keeping the verified envelope address (see formatSender). Omitted →
  // driver default.
  from?: string;
  // Reply-To header. Set to the sending company's contact address so customer
  // replies reach the business, not the platform sender. Omitted → no header.
  replyTo?: string;
};

export type Mailer = {
  send(msg: MailMessage): Promise<void>;
};

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function createResendMailer(opts: { apiKey: string; from: string }): Mailer {
  const log = getLogger(['api', 'mailer', 'resend']);
  return {
    async send(msg) {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: msg.from ?? opts.from,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          // Resend's field is snake_case; only send it when set so the absence
          // of a company reply address leaves the header off entirely.
          ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
        }),
      });
      if (!res.ok) {
        // Read the body once for diagnostics; throw so the caller can surface
        // a 502 to the user. Resend's error shape is `{ name, message }`.
        const detail = await res.text().catch(() => '');
        log.error('resend send failed', { status: res.status, detail });
        throw new Error(`resend_send_failed: ${res.status}`);
      }
    },
  };
}

export function createConsoleMailer(opts: { from: string }): Mailer {
  const log = getLogger(['api', 'mailer', 'console']);
  return {
    async send(msg) {
      log.info('[email] from={from} replyTo={replyTo} to={to} subject={subject}\n{text}', {
        from: msg.from ?? opts.from,
        replyTo: msg.replyTo ?? '(none)',
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
      });
    },
  };
}
