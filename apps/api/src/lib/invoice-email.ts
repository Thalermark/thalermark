import { escapeHtml } from './html.js';
import type { Mailer } from './mailer.js';
import { formatSender } from './sender.js';

// Shared invoice-email builder + sender. Extracted from the /api/invoices/:id/
// send route so the recurring-invoice generation engine (slice R3) emits the
// byte-for-byte identical email — a hand-sent invoice and an auto-generated
// one look the same to the recipient, and the two paths can't drift.

export type InvoiceEmailInvoice = {
  number: string;
  total: string;
  currency: string;
  dueDate: string;
  publicToken: string;
};

export type InvoiceEmailInput = {
  invoice: InvoiceEmailInvoice;
  customerName: string | null;
  companyName: string;
  // Absolute base URL for the public view; when absent the link is relative
  // (works behind any proxy, matches the self-host default).
  publicAppUrl?: string;
  // From header address (the verified EMAIL_FROM); the display name is swapped
  // to the company's name. Undefined → the mailer's default From.
  emailFrom?: string;
  // Company contact address replies route to, when set.
  replyToEmail?: string | null;
};

export function buildInvoiceEmail(input: InvoiceEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { invoice, customerName, companyName, publicAppUrl } = input;
  const publicUrl = publicAppUrl
    ? `${publicAppUrl}/i/${invoice.publicToken}`
    : `/i/${invoice.publicToken}`;
  const subject = `Invoice ${invoice.number} from ${companyName}`;
  const greeting = customerName ? `Hi ${customerName},` : 'Hi,';
  const text =
    `${greeting}\n\n` +
    `Invoice ${invoice.number} for ${invoice.total} ${invoice.currency} is ready.\n` +
    `Due ${invoice.dueDate}.\n\n` +
    `View it: ${publicUrl}\n\n` +
    `— ${companyName}`;
  const html =
    `<p>${escapeHtml(greeting)}</p>` +
    `<p>Invoice <strong>${escapeHtml(invoice.number)}</strong> for ` +
    `<strong>${escapeHtml(invoice.total)} ${escapeHtml(invoice.currency)}</strong> is ready. ` +
    `Due ${escapeHtml(invoice.dueDate)}.</p>` +
    `<p><a href="${escapeHtml(publicUrl)}">View invoice</a></p>` +
    `<p>— ${escapeHtml(companyName)}</p>`;
  return { subject, text, html };
}

// Build + send in one step. Throws on mailer failure (the caller decides
// whether that's a 502 to the user or a logged best-effort in the sweeper).
export async function sendInvoiceEmail(
  mailer: Mailer,
  to: string,
  input: InvoiceEmailInput,
): Promise<{ subject: string }> {
  const { subject, text, html } = buildInvoiceEmail(input);
  await mailer.send({
    to,
    subject,
    html,
    text,
    from: input.emailFrom ? formatSender(input.emailFrom, input.companyName) : undefined,
    replyTo: input.replyToEmail ?? undefined,
  });
  return { subject };
}
