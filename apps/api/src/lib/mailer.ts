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
          from: opts.from,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
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
      log.info('[email] from={from} to={to} subject={subject}\n{text}', {
        from: opts.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
      });
    },
  };
}
