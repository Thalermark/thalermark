import type { CustomerStatement, StatementLine } from './customer-statement.js';
import { emailFooterText, renderEmailHtml } from './email-layout.js';
import { DEFAULT_TEMPLATES, renderTemplate } from './email-templates.js';
import { escapeHtml } from './html.js';
import type { Mailer } from './mailer.js';
import { formatSender } from './sender.js';

// Statement-email builder + sender, mirroring invoice-email.ts. The statement
// isn't publicly addressable (no public token), so the email carries the ledger
// itself — the same charge/payment table the printed document shows — rather
// than a link. USD formatting (the app's default); revisit if multi-currency
// statements land.

export type StatementEmailInput = {
  statement: CustomerStatement;
  emailFrom?: string;
  replyToEmail?: string | null;
  // Resolved subject+intro (override or default). The route resolves it;
  // omitted → DEFAULT_TEMPLATES.statement. The ledger table + totals are fixed
  // chrome appended after the templated intro, not editable.
  template?: { subject: string; body: string };
};

const money = (v: string) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function buildStatementEmail(input: StatementEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { statement, template } = input;
  const companyName = statement.company.name || 'Thalermark';
  const balanceDue = money(statement.balanceDue);

  // Editable subject + intro. The ledger table + totals + signoff below are
  // fixed chrome (the data, not prose).
  const { subject, textBody, htmlBody } = renderTemplate(template ?? DEFAULT_TEMPLATES.statement, {
    customer_name: statement.customer.name,
    company_name: companyName,
    statement_date: statement.statementDate,
    balance_due: balanceDue,
  });

  const sign = (l: StatementLine) =>
    l.charge ? `+${money(l.charge)}` : l.payment ? `-${money(l.payment)}` : '';
  const textLines = statement.lines.map(
    (l) => `${l.date}  ${l.description}  ${sign(l)}  (${money(l.balance)})`,
  );
  const text = [
    textBody,
    '',
    ...(textLines.length ? textLines : ['No invoices on file.']),
    '',
    `Total invoiced: ${money(statement.totalCharges)}`,
    `Total paid: ${money(statement.totalPayments)}`,
    `Balance due: ${balanceDue}`,
    '',
    `— ${companyName}`,
    '',
    emailFooterText(true),
  ].join('\n');

  const cell = (v: string, right = false) =>
    `<td style="padding:6px 8px;border-bottom:1px solid #ece3cf;${right ? 'text-align:right;white-space:nowrap;' : ''}">${v}</td>`;
  const rows = statement.lines
    .map(
      (l) =>
        `<tr>${cell(escapeHtml(l.date))}${cell(escapeHtml(l.description))}${cell(l.charge ? escapeHtml(money(l.charge)) : '', true)}${cell(l.payment ? escapeHtml(money(l.payment)) : '', true)}${cell(escapeHtml(money(l.balance)), true)}</tr>`,
    )
    .join('');
  const head =
    '<thead><tr style="text-align:left;border-bottom:2px solid #d9ccad;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#6b6f7e;"><th style="padding:6px 8px;font-weight:600;">Date</th><th style="padding:6px 8px;font-weight:600;">Description</th><th style="padding:6px 8px;text-align:right;font-weight:600;">Charge</th><th style="padding:6px 8px;text-align:right;font-weight:600;">Payment</th><th style="padding:6px 8px;text-align:right;font-weight:600;">Balance</th></tr></thead>';
  const table = statement.lines.length
    ? `<table style="border-collapse:collapse;width:100%;font-size:14px;margin:18px 0 4px;">${head}<tbody>${rows}</tbody></table>`
    : '<p style="margin:14px 0 0;">No invoices on file.</p>';
  const html = renderEmailHtml({
    brandName: companyName,
    preheader: `Balance due ${balanceDue} · statement as of ${statement.statementDate}`,
    heading: 'Account statement',
    bodyHtml: `${htmlBody}${table}<p style="margin:16px 0 0;">Total invoiced: ${escapeHtml(money(statement.totalCharges))}<br>Total paid: ${escapeHtml(money(statement.totalPayments))}<br><strong>Balance due: ${escapeHtml(balanceDue)}</strong></p>`,
    poweredBy: true,
  });

  return { subject, text, html };
}

// Build + send in one step. Throws on mailer failure (the caller maps it to a
// 502, same as the invoice-send route).
export async function sendStatementEmail(
  mailer: Mailer,
  to: string,
  input: StatementEmailInput,
): Promise<{ subject: string }> {
  const { subject, text, html } = buildStatementEmail(input);
  const companyName = input.statement.company.name || 'Thalermark';
  await mailer.send({
    to,
    subject,
    html,
    text,
    from: input.emailFrom ? formatSender(input.emailFrom, companyName) : undefined,
    replyTo: input.replyToEmail ?? undefined,
  });
  return { subject };
}
