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
};

export function buildEstimateEmail(input: EstimateEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { estimate, customerName, companyName, publicAppUrl, template } = input;
  const publicUrl = publicAppUrl
    ? `${publicAppUrl}/e/${estimate.publicToken}`
    : `/e/${estimate.publicToken}`;
  const amount = `${estimate.total} ${estimate.currency}`;

  const { subject, textBody, htmlBody } = renderTemplate(template ?? DEFAULT_TEMPLATES.estimate, {
    customer_name: customerName?.trim() || 'there',
    estimate_number: estimate.number,
    amount,
    company_name: companyName,
  });

  const validUntilText = estimate.expiresOn
    ? `\nThis estimate is valid until ${estimate.expiresOn}.`
    : '';
  const validUntilHtml = estimate.expiresOn
    ? `<p style="margin:14px 0 0;">This estimate is valid until ${escapeHtml(estimate.expiresOn)}.</p>`
    : '';
  const text = `${textBody}${validUntilText}\n\nView the estimate: ${publicUrl}\n\n— ${companyName}\n\n${emailFooterText(true)}`;
  const html = renderEmailHtml({
    brandName: companyName,
    preheader: `Estimate ${estimate.number} · ${amount}${estimate.expiresOn ? ` · valid until ${estimate.expiresOn}` : ''}`,
    heading: `Estimate ${estimate.number}`,
    bodyHtml: `${htmlBody}${validUntilHtml}`,
    cta: { label: 'View estimate', url: publicUrl },
    poweredBy: true,
  });
  return { subject, text, html };
}

// Build + send in one step. Throws on mailer failure (the caller maps it to a
// 502, same as the invoice-send route).
export async function sendEstimateEmail(
  mailer: Mailer,
  to: string,
  input: EstimateEmailInput,
): Promise<{ subject: string }> {
  const { subject, text, html } = buildEstimateEmail(input);
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
