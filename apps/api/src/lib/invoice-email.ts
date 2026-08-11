import { formatDateDisplay, formatMoneyDisplay } from '@thalermark/validation';
import { emailFooterText, renderEmailHtml } from './email-layout.js';
import { DEFAULT_TEMPLATES, renderTemplate } from './email-templates.js';
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
  // Resolved subject+body (the company's override or the in-code default). The
  // route/recurring engine resolves it; omitted → DEFAULT_TEMPLATES.invoice.
  template?: { subject: string; body: string };
  // Set only when THIS send is re-issuing an invoice that was pulled back and
  // corrected (TMC-227). Turns the ordinary email into an amended one.
  //
  // Fixed copy rather than a fifth editable template type, deliberately. The
  // apology and the changed figure are the honest core of the feature — a
  // business editing them to say nothing changed would be using Thalermark to
  // hide a correction, which is the opposite of the point. The editable
  // template still renders inside it untouched.
  revision?: { previousTotal: string };
};

export function buildInvoiceEmail(input: InvoiceEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { invoice, customerName, companyName, publicAppUrl, replyToEmail, template, revision } =
    input;
  const publicUrl = publicAppUrl
    ? `${publicAppUrl}/i/${invoice.publicToken}`
    : `/i/${invoice.publicToken}`;
  // Both of these are read by a customer, not by an accountant: "$1,500.00" and
  // "September 15, 2026", never the stored "1500.00 USD" and "2026-09-15".
  const amount = formatMoneyDisplay(invoice.total, invoice.currency);
  const dueDate = formatDateDisplay(invoice.dueDate);

  // The editable subject + greeting/message prose. customer_name falls back to
  // "there" so a nameless customer reads "Hi there," not "Hi ,".
  const { subject, textBody, htmlBody } = renderTemplate(template ?? DEFAULT_TEMPLATES.invoice, {
    customer_name: customerName?.trim() || 'there',
    invoice_number: invoice.number,
    amount,
    due_date: dueDate,
    company_name: companyName,
  });

  // Only invite a reply when one will actually reach the business (the company
  // set a contact address). Without it, replies hit the platform envelope.
  const replyNote = replyToEmail
    ? `Questions about this invoice? Just reply to this email and it'll reach ${companyName}.`
    : undefined;

  // The correction preamble, when this send is a re-issue. It leads — a
  // recipient who skims the first line has to learn that the invoice they
  // already have is superseded, and burying that under the greeting would let
  // them pay the old figure.
  //
  // The second sentence appears only when the total actually moved. Plenty of
  // corrections are a wrong date or a wrong description, and "the total changed
  // from $450.00 to $450.00" would read as a mistake in its own right.
  const correction = revision
    ? [
        'Sorry — the earlier invoice was wrong. This is the corrected one.',
        ...(revision.previousTotal !== invoice.total
          ? [
              `The total changed from ${formatMoneyDisplay(revision.previousTotal, invoice.currency)} to ${amount}.`,
            ]
          : []),
      ].join(' ')
    : undefined;

  // The public link is the HTML CTA button; text has no button, so it carries
  // the URL as a line (also what the integration test asserts on).
  const text = [
    ...(correction ? [correction, ''] : []),
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
    preheader: correction
      ? `Corrected invoice ${invoice.number} · ${amount} · due ${dueDate}`
      : `Invoice ${invoice.number} · ${amount} · due ${dueDate}`,
    heading: `Invoice ${invoice.number}`,
    // Escaped and styled like the template's own paragraphs, so it reads as
    // part of the message rather than a system banner bolted above it. The
    // template's own body is wrapped rather than string-edited — paragraphize
    // owns those margins and this must not depend on their exact text.
    bodyHtml: correction
      ? `<p style="margin:0;">${escapeHtml(correction)}</p><div style="margin:14px 0 0;">${htmlBody}</div>`
      : htmlBody,
    cta: { label: 'View invoice', url: publicUrl },
    footnote: replyNote,
    poweredBy: true,
  });
  // Prefixed rather than replaced: the business's own subject line is how the
  // customer recognises the thread, and "Corrected:" in front of it is what
  // makes the new message win a skim of the inbox.
  return { subject: correction ? `Corrected: ${subject}` : subject, text, html };
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
