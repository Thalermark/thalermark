import { emailFooterText, renderEmailHtml } from './email-layout.js';
import { DEFAULT_TEMPLATES, renderTemplate } from './email-templates.js';
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
  // Resolved subject+body (the company's override or the in-code default). The
  // route/recurring engine resolves it; omitted → DEFAULT_TEMPLATES.invoice.
  template?: { subject: string; body: string };
};

export function buildInvoiceEmail(input: InvoiceEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { invoice, customerName, companyName, publicAppUrl, replyToEmail, template } = input;
  const publicUrl = publicAppUrl
    ? `${publicAppUrl}/i/${invoice.publicToken}`
    : `/i/${invoice.publicToken}`;
  const amount = `${invoice.total} ${invoice.currency}`;

  // The editable subject + greeting/message prose. customer_name falls back to
  // "there" so a nameless customer reads "Hi there," not "Hi ,".
  const { subject, textBody, htmlBody } = renderTemplate(template ?? DEFAULT_TEMPLATES.invoice, {
    customer_name: customerName?.trim() || 'there',
    invoice_number: invoice.number,
    amount,
    due_date: invoice.dueDate,
    company_name: companyName,
  });

  // Only invite a reply when one will actually reach the business (the company
  // set a contact address). Without it, replies hit the platform envelope.
  const replyNote = replyToEmail
    ? `Questions about this invoice? Just reply to this email and it'll reach ${companyName}.`
    : undefined;

  // The public link is the HTML CTA button; text has no button, so it carries
  // the URL as a line (also what the integration test asserts on).
  const text = [
    textBody,
    '',
    `View your invoice: ${publicUrl}`,
    ...(replyNote ? ['', replyNote] : []),
    '',
    `— ${companyName}`,
    '',
    emailFooterText(true),
  ].join('\n');

  const html = renderEmailHtml({
    brandName: companyName,
    preheader: `Invoice ${invoice.number} · ${amount} · due ${invoice.dueDate}`,
    heading: `Invoice ${invoice.number}`,
    bodyHtml: htmlBody,
    cta: { label: 'View invoice', url: publicUrl },
    footnote: replyNote,
    poweredBy: true,
  });
  return { subject, text, html };
}

// Build + send in one step. Throws on mailer failure (the caller decides
// whether that's a 502 to the user or a logged best-effort in the sweeper).
export async function sendInvoiceEmail(
  mailer: Mailer,
  to: string,
  input: InvoiceEmailInput,
): Promise<{ subject: string; messageId: string | null }> {
  const { subject, text, html } = buildInvoiceEmail(input);
  const receipt = await mailer.send({
    to,
    subject,
    html,
    text,
    from: input.emailFrom ? formatSender(input.emailFrom, input.companyName) : undefined,
    replyTo: input.replyToEmail ?? undefined,
  });
  // Passed back so the caller can store it against the invoice — it is what a
  // later delivery webhook quotes to identify this message. Null on any driver
  // that reports no id (TMC-226).
  return { subject, messageId: receipt?.id ?? null };
}
