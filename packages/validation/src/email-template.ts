import { z } from 'zod';

// The three customer-facing emails a business can customize. Platform emails
// (verification, invitation) are Thalermark's voice + a security surface, so
// they stay hardcoded and are intentionally NOT in this list.
export const EMAIL_TEMPLATE_TYPES = ['invoice', 'estimate', 'statement'] as const;
export const emailTemplateTypeSchema = z.enum(EMAIL_TEMPLATE_TYPES);
export type EmailTemplateType = z.infer<typeof emailTemplateTypeSchema>;

// Allowed {{placeholders}} per type. The business edits the subject + body
// prose; these are the only tokens that resolve at send time. Anything else is
// left literal at render time and rejected at save time. Keep in lockstep with
// the value maps in apps/api/src/lib/email-templates.ts — the api computes a
// value for each of these from the send context. The fixed chrome (CTA button,
// the estimate "valid until" line, the statement ledger table, the reply-to
// note, the footer) lives in code and is deliberately not a placeholder.
export const EMAIL_TEMPLATE_PLACEHOLDERS = {
  invoice: ['customer_name', 'invoice_number', 'amount', 'due_date', 'company_name'],
  estimate: ['customer_name', 'estimate_number', 'amount', 'company_name'],
  statement: ['customer_name', 'company_name', 'statement_date', 'balance_due'],
} as const satisfies Record<EmailTemplateType, readonly string[]>;

// Matches a `{{ token }}` (tolerant of inner whitespace). Names are lowercase
// snake_case; the same shape the renderer substitutes against.
const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

// Every placeholder name referenced in a string, in order, with duplicates.
export function extractPlaceholders(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(PLACEHOLDER_RE)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

// The distinct placeholder names used across the given strings that aren't
// valid for this template type. Empty array = all good. Shared so the PUT route
// (400 on non-empty) and the editor UI (live "unknown token" flag) agree.
export function unknownPlaceholders(type: EmailTemplateType, ...parts: string[]): string[] {
  const allowed = new Set<string>(EMAIL_TEMPLATE_PLACEHOLDERS[type]);
  const bad = new Set<string>();
  for (const part of parts) {
    for (const name of extractPlaceholders(part)) {
      if (!allowed.has(name)) bad.add(name);
    }
  }
  return [...bad];
}

// PUT /api/companies/:id/email-templates/:type body — the two editable fields.
// Length caps keep the email sane and bound the column. Placeholder validity is
// type-dependent (the :type param), so it's enforced in the route via
// unknownPlaceholders, not here.
export const emailTemplateUpdateSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
});
export type EmailTemplateUpdate = z.infer<typeof emailTemplateUpdateSchema>;
