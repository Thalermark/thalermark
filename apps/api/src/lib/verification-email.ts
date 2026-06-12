import { escapeHtml } from './html.js';

// The email/password verification message. Plain transactional HTML, same lean
// style as the invitation email — the recipient just needs the link. Better
// Auth supplies the one-time `url`; clicking it verifies + (autoSignIn) drops
// them into the app.
export function verificationEmail(args: { name?: string | null; url: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const named = args.name?.trim();
  const greeting = named ? `Hi ${named},` : 'Welcome to Thalermark,';
  const url = escapeHtml(args.url);
  return {
    subject: 'Verify your email for Thalermark',
    html: [
      `<p>${escapeHtml(greeting)}</p>`,
      '<p>Confirm your email address to finish setting up your Thalermark account.</p>',
      `<p><a href="${url}">Verify my email</a></p>`,
      "<p>If you didn't create a Thalermark account, you can ignore this email.</p>",
    ].join(''),
    text: `${greeting}\n\nConfirm your email address to finish setting up your Thalermark account:\n${args.url}\n\nIf you didn't create a Thalermark account, you can ignore this email.\n`,
  };
}
