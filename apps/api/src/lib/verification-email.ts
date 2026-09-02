import { renderEmailHtml } from './email-layout.js';

// The email/password verification message. Branded transactional email built on
// the shared email shell — same chrome as invoice/estimate/statement, but the
// wordmark is Thalermark (this goes to a Thalermark *user*, not a customer).
// Better Auth supplies the one-time `url`; clicking it verifies + (autoSignIn)
// drops them into the app.
export function verificationEmail(args: { name?: string | null; url: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const named = args.name?.trim();
  const greeting = named ? `Hi ${named},` : 'Welcome to Thalermark,';
  const ignore = "If you didn't create a Thalermark account, you can safely ignore this email.";
  return {
    subject: 'Confirm your email for Thalermark',
    html: renderEmailHtml({
      brandName: 'Thalermark',
      preheader: 'Confirm your email to finish setting up your account.',
      heading: 'Confirm your email',
      bodyHtml: `<p style="margin:0;">${greeting}</p><p style="margin:14px 0 0;">You're almost there. Confirm your email address to finish setting up your Thalermark account.</p>`,
      cta: { label: 'Verify my email', url: args.url },
      footnote: ignore,
    }),
    text: `${greeting}\n\nYou're almost there. Confirm your email address to finish setting up your Thalermark account:\n${args.url}\n\n${ignore}\n`,
  };
}
