import { renderEmailHtml } from './email-layout.js';

// The password-reset message. Branded transactional email on the shared email
// shell — same chrome as verification/invoice/estimate, but the wordmark is
// Thalermark (this goes to a Thalermark *user*, not a customer). The api builds
// the one-time `url` (→ the web app's /reset-password page) from publicAppUrl;
// clicking it lets the user choose a new password. The copy never confirms the
// account exists — the same neutral framing the request endpoint uses — and the
// "you didn't request this" line covers the case where the email reaches the
// wrong inbox.
export function resetPasswordEmail(args: { name?: string | null; url: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const named = args.name?.trim();
  const greeting = named ? `Hi ${named},` : 'Hello,';
  const ignore =
    "If you didn't request a password reset, you can safely ignore this email. Your password won't change.";
  return {
    subject: 'Reset your Thalermark password',
    html: renderEmailHtml({
      brandName: 'Thalermark',
      preheader: 'Choose a new password for your Thalermark account.',
      heading: 'Reset your password',
      bodyHtml: `<p style="margin:0;">${greeting}</p><p style="margin:14px 0 0;">We received a request to reset your Thalermark password. Choose a new one using the button below. This link expires in one hour.</p>`,
      cta: { label: 'Choose a new password', url: args.url },
      footnote: ignore,
    }),
    text: `${greeting}\n\nWe received a request to reset your Thalermark password. Choose a new one:\n${args.url}\n\nThis link expires in one hour.\n\n${ignore}\n`,
  };
}
