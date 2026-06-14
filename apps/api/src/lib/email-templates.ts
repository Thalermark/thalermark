import { type Database, type Transaction, emailTemplates } from '@thalermark/db';
import type { EmailTemplateType } from '@thalermark/validation';
import { and, eq } from 'drizzle-orm';
import { escapeHtml } from './html.js';

// Default copy for the customer-facing emails, in the same {{placeholder}}
// format a business edits. This is the floor: an empty email_templates table
// means every company sends these. The build path resolves an override row or
// falls back here (resolveEmailTemplate). Keep the {{tokens}} in lockstep with
// @thalermark/validation EMAIL_TEMPLATE_PLACEHOLDERS — only those resolve; the
// fixed chrome (CTA button, the estimate "valid until" line, the statement
// ledger table, the reply-to note, the footer) is added by the builders and is
// deliberately not editable.
export const DEFAULT_TEMPLATES: Record<EmailTemplateType, { subject: string; body: string }> = {
  invoice: {
    subject: 'Invoice {{invoice_number}} from {{company_name}}',
    body: "Hi {{customer_name}},\n\nThanks for your business. Invoice {{invoice_number}} for {{amount}} is ready — it's due {{due_date}}.",
  },
  estimate: {
    subject: 'Estimate {{estimate_number}} from {{company_name}}',
    body: "Hi {{customer_name}},\n\nHere's estimate {{estimate_number}} for {{amount}}, ready for your review. Take a look and let us know if you'd like to go ahead.",
  },
  statement: {
    subject: 'Statement from {{company_name}} — balance due {{balance_due}}',
    body: "Hi {{customer_name}},\n\nHere's your account statement from {{company_name}} as of {{statement_date}}.",
  },
};

// Substitute {{ key }} → value (tolerant of inner whitespace). A key not in
// `values` is left literal — placeholders are validated at save time, so at
// render time the set is always known; the passthrough is just belt-and-braces.
const TOKEN_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;
export function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(TOKEN_RE, (whole, key: string) => {
    const value = values[key];
    return value === undefined ? whole : value;
  });
}

// Turn an already-HTML-escaped plain-text body into shell-ready paragraphs:
// blank lines split paragraphs, single newlines become <br>. Margins match the
// other builders' inline-styled <p>s.
function paragraphize(escaped: string): string {
  return escaped
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p, i) => `<p style="margin:${i === 0 ? '0' : '14px 0 0'};">${p.replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
}

// Render a resolved template against its send-time values into the three pieces
// every builder needs: a header-safe subject, a plain-text body, and an
// HTML-escaped paragraphized body (the inner content the shell wraps). The
// builders add the fixed chrome (CTA, type-specific extras, footer) around it.
//
// HTML escaping order matters: escape the template body FIRST (so any < or &
// the user typed is neutralized — {{tokens}} survive, braces aren't special),
// then substitute ESCAPED values. User text never reaches the recipient
// unescaped.
export function renderTemplate(
  template: { subject: string; body: string },
  values: Record<string, string>,
): { subject: string; textBody: string; htmlBody: string } {
  const subject = applyTemplate(template.subject, values)
    .replace(/[\r\n]+/g, ' ')
    .trim();
  const textBody = applyTemplate(template.body, values);
  const escapedValues: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) escapedValues[k] = escapeHtml(v);
  const htmlBody = paragraphize(applyTemplate(escapeHtml(template.body), escapedValues));
  return { subject, textBody, htmlBody };
}

// Send-path resolver: the company's override for this type, or the in-code
// default. account_id is filtered explicitly (defense in depth alongside RLS,
// matching every other tenant SELECT).
export async function resolveEmailTemplate(
  tx: Database | Transaction,
  accountId: string,
  companyId: string,
  type: EmailTemplateType,
): Promise<{ subject: string; body: string }> {
  const [row] = await tx
    .select({ subject: emailTemplates.subject, body: emailTemplates.body })
    .from(emailTemplates)
    .where(
      and(
        eq(emailTemplates.accountId, accountId),
        eq(emailTemplates.companyId, companyId),
        eq(emailTemplates.type, type),
      ),
    )
    .limit(1);
  return row ?? DEFAULT_TEMPLATES[type];
}
