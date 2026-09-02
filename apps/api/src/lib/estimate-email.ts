import { formatDateDisplay, formatMoneyDisplay } from '@thalermark/validation';
import { emailFooterText, renderEmailHtml } from './email-layout.js';
import { DEFAULT_TEMPLATES, renderTemplate } from './email-templates.js';
import { escapeHtml } from './html.js';
import type { Mailer } from './mailer.js';
import { formatSender } from './sender.js';

// Shared estimate-email builder + sender, mirroring invoice-email.ts. Extracted
// from the /api/estimates/:id/send route so the template-preview endpoint
// renders the same email the recipient gets — preview and send can't drift.
// The editable subject + greeting/message prose come from the resolved
// template; the "valid until" line, the text view-link, the CTA, and the footer
// are fixed chrome.

export type EstimateEmailEstimate = {
  number: string;
  total: string;
  currency: string;
  expiresOn: string | null;
  publicToken: string;
};

export type EstimateEmailInput = {
  estimate: EstimateEmailEstimate;
  customerName: string | null;
  companyName: string;
  publicAppUrl?: string;
  emailFrom?: string;
  replyToEmail?: string | null;
  // Resolved subject+body (override or default); omitted → DEFAULT_TEMPLATES.estimate.
  template?: { subject: string; body: string };
  // Set only when THIS send is re-issuing an estimate that was pulled back and
  // corrected (TMC-227). Fixed copy, not a fifth editable template — see
  // invoice-email.ts for why the apology is not the business's to edit away.
  revision?: { previousTotal: string };
};

export function buildEstimateEmail(input: EstimateEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { estimate, customerName, companyName, publicAppUrl, template, revision } = input;
  const publicUrl = publicAppUrl
    ? `${publicAppUrl}/e/${estimate.publicToken}`
    : `/e/${estimate.publicToken}`;
  // Customer-facing, so formatted for a reader: "$1,500.00", not "1500.00 USD".
  const amount = formatMoneyDisplay(estimate.total, estimate.currency);
  const expiresOn = estimate.expiresOn ? formatDateDisplay(estimate.expiresOn) : null;

  const { subject, textBody, htmlBody } = renderTemplate(template ?? DEFAULT_TEMPLATES.estimate, {
    customer_name: customerName?.trim() || 'there',
    estimate_number: estimate.number,
    amount,
    company_name: companyName,
  });

  // Leads the message when this send is a re-issue, so a recipient who skims
  // the first line learns the quote they already have is superseded. The second
  // sentence appears only when the number actually moved — plenty of
  // corrections are a wrong date or a wrong line description.
  const correction = revision
    ? [
        'Sorry, the earlier estimate was wrong. This is the corrected one.',
        ...(revision.previousTotal !== estimate.total
          ? [
              `The total changed from ${formatMoneyDisplay(revision.previousTotal, estimate.currency)} to ${amount}.`,
            ]
          : []),
      ].join(' ')
    : undefined;

  const validUntilText = expiresOn ? `\nThis estimate is valid until ${expiresOn}.` : '';
  const validUntilHtml = expiresOn
    ? `<p style="margin:14px 0 0;">This estimate is valid until ${escapeHtml(expiresOn)}.</p>`
    : '';
  const text = `${correction ? `${correction}\n\n` : ''}${textBody}${validUntilText}\n\nView the estimate: ${publicUrl}\n\n${companyName}\n\n${emailFooterText(true)}`;
  const html = renderEmailHtml({
    brandName: companyName,
    preheader: correction
      ? `Corrected estimate ${estimate.number} · ${amount}${expiresOn ? ` · valid until ${expiresOn}` : ''}`
      : `Estimate ${estimate.number} · ${amount}${expiresOn ? ` · valid until ${expiresOn}` : ''}`,
    heading: `Estimate ${estimate.number}`,
    bodyHtml: correction
      ? `<p style="margin:0;">${escapeHtml(correction)}</p><div style="margin:14px 0 0;">${htmlBody}${validUntilHtml}</div>`
      : `${htmlBody}${validUntilHtml}`,
    cta: { label: 'View estimate', url: publicUrl },
    poweredBy: true,
  });
  return { subject: correction ? `Corrected: ${subject}` : subject, text, html };
}

// Build + send in one step. Throws on mailer failure (the caller maps it to a
// 502, same as the invoice-send route).
export async function sendEstimateEmail(
  mailer: Mailer,
  to: string,
  input: EstimateEmailInput,
): Promise<{ subject: string; messageId: string | null }> {
  const { subject, text, html } = buildEstimateEmail(input);
  const receipt = await mailer.send({
    to,
    subject,
    html,
    text,
    from: input.emailFrom ? formatSender(input.emailFrom, input.companyName) : undefined,
    replyTo: input.replyToEmail ?? undefined,
  });
  // Same as the invoice path — the provider's id for this message, so a later
  // delivery report can find the estimate again (TMC-226).
  return { subject, messageId: receipt?.id ?? null };
}
