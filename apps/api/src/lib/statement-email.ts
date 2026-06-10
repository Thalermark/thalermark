import type { CustomerStatement } from './customer-statement.js';
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
};

const money = (v: string) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function buildStatementEmail(input: StatementEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { statement } = input;
  const companyName = statement.company.name || 'Thalermark';
  const greeting = `Hi ${statement.customer.name},`;
  const subject = `Statement from ${companyName} — balance due ${money(statement.balanceDue)}`;

  const textLines = statement.lines.map(
    (l) =>
      `${l.date}  ${l.description}  ` +
      `${l.charge ? `+${money(l.charge)}` : l.payment ? `-${money(l.payment)}` : ''}  ` +
      `(${money(l.balance)})`,
  );
  const text =
    `${greeting}\n\n` +
    `Here's your account statement from ${companyName} as of ${statement.statementDate}.\n\n` +
    (textLines.length ? `${textLines.join('\n')}\n\n` : 'No invoices on file.\n\n') +
    `Total invoiced: ${money(statement.totalCharges)}\n` +
    `Total paid: ${money(statement.totalPayments)}\n` +
    `Balance due: ${money(statement.balanceDue)}\n\n` +
    `— ${companyName}`;

  const rows = statement.lines
    .map(
      (l) =>
        `<tr>` +
        `<td style="padding:4px 8px;">${escapeHtml(l.date)}</td>` +
        `<td style="padding:4px 8px;">${escapeHtml(l.description)}</td>` +
        `<td style="padding:4px 8px;text-align:right;">${l.charge ? escapeHtml(money(l.charge)) : ''}</td>` +
        `<td style="padding:4px 8px;text-align:right;">${l.payment ? escapeHtml(money(l.payment)) : ''}</td>` +
        `<td style="padding:4px 8px;text-align:right;">${escapeHtml(money(l.balance))}</td>` +
        `</tr>`,
    )
    .join('');
  const table = statement.lines.length
    ? `<table style="border-collapse:collapse;width:100%;font-size:14px;">` +
      `<thead><tr style="text-align:left;border-bottom:1px solid #ccc;">` +
      `<th style="padding:4px 8px;">Date</th><th style="padding:4px 8px;">Description</th>` +
      `<th style="padding:4px 8px;text-align:right;">Charge</th>` +
      `<th style="padding:4px 8px;text-align:right;">Payment</th>` +
      `<th style="padding:4px 8px;text-align:right;">Balance</th>` +
      `</tr></thead><tbody>${rows}</tbody></table>`
    : `<p>No invoices on file.</p>`;
  const html =
    `<p>${escapeHtml(greeting)}</p>` +
    `<p>Here's your account statement from <strong>${escapeHtml(companyName)}</strong> as of ${escapeHtml(statement.statementDate)}.</p>` +
    table +
    `<p style="margin-top:16px;">Total invoiced: ${escapeHtml(money(statement.totalCharges))}<br>` +
    `Total paid: ${escapeHtml(money(statement.totalPayments))}<br>` +
    `<strong>Balance due: ${escapeHtml(money(statement.balanceDue))}</strong></p>` +
    `<p>— ${escapeHtml(companyName)}</p>`;

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
