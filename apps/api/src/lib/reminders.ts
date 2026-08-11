import {
  type Database,
  type Transaction,
  invoiceReminders,
  withAccountContext,
} from '@thalermark/db';
import { getLogger } from '@thalermark/logger';
import {
  centsToMoney,
  formatDateDisplay,
  formatMoneyDisplay,
  toCents,
} from '@thalermark/validation';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { recordSendFailed } from './delivery.js';
import { renderTemplate, resolveEmailTemplate } from './email-templates.js';
import { type EntitlementProvider, communityEntitlements } from './entitlement.js';
import { type Mailer, mailerDelivers } from './mailer.js';
import { resolveReplyTo } from './sender.js';

const log = getLogger(['thalermark', 'api', 'reminders']);

// Automated payment reminders (TMC-189). The third pg-boss sweep, alongside
// recurring invoices and depreciation, and deliberately shaped like them.
//
// This is the only sweep that sends mail to a THIRD PARTY — the customer of the
// person using this software, in that person's name. Every guard below exists
// because the failure mode is not a wrong number on a screen, it is an email
// that should not have been sent, to someone who is not our user, which cannot
// be taken back.

export type ReminderMailDeps = {
  mailer?: Mailer;
  emailFrom?: string;
  publicAppUrl?: string;
};

export type ReminderSweepResult = {
  sent: number;
  skipped: number;
  failed: number;
  scanned: number;
};

// How long to stay quiet after money arrives.
//
// THE SCENARIO THIS EXISTS FOR: a landscaper takes a deposit on Friday for a job
// starting Saturday. Without this, the "5 days before it's due" reminder fires
// the next morning and the customer — who paid yesterday — is told their invoice
// is coming due. It reads as the business not noticing they paid, which is worse
// than never reminding them at all.
//
// Three days rather than one because "I paid you this week" is the window a
// person actually feels, and a reminder inside it damages the relationship the
// feature is supposed to protect.
const QUIET_DAYS_AFTER_PAYMENT = 3;

type DueReminder = {
  invoiceId: string;
  accountId: string;
  companyId: string;
  number: string;
  dueDate: string;
  currency: string;
  customerName: string;
  customerEmail: string;
  companyName: string;
  replyToEmail: string | null;
  businessEmail: string | null;
  offsetDays: number;
  companyToday: string;
  outstanding: string;
};

// Which invoices are due a reminder right now.
//
// TWO GUARDS ARE LOAD-BEARING HERE AND BOTH ARE EASY TO GET WRONG.
//
// 1. EXACT-DAY MATCHING, not `<=`. The natural way to write this is
//    "due_date + offset <= today AND not already sent", and that is a live
//    incident: the day an owner enables reminders, every invoice that has been
//    overdue for months fires ALL of its stages at once, in one burst, to real
//    customers. Matching the exact day means an invoice simply has no `-5` day
//    if it was issued four days before it fell due, and enabling the feature is
//    quiet by construction. Nothing retroactive, no backfill, no special case.
//
// 2. THE COMPANY'S TODAY, not UTC's. `= today` only means anything against the
//    operator's calendar. Resolved through companies.timezone, the same way
//    every date-windowed report does (TMC-157), or a reminder fires on the wrong
//    day for anyone far enough east or west.
//
// The rest are ordinary but each one is a real email if it is missing: the
// company has to have switched this on, the company must not be retired (a
// business that stopped trading must not keep chasing under its old name), the
// invoice must be issued and unsettled, this invoice must not be opted out,
// something must actually still be owed, this exact stage must not already have
// been sent, and no money may have arrived recently.
//
// `nowTs` is a bound parameter rather than now() so a test can wind the clock.
async function findDueReminders(db: Database, nowTs: Date): Promise<DueReminder[]> {
  const rows = await db.execute<{
    invoice_id: string;
    account_id: string;
    company_id: string;
    number: string;
    due_date: string;
    currency: string;
    customer_name: string;
    customer_email: string;
    company_name: string;
    reply_to_email: string | null;
    business_email: string | null;
    offset_days: number;
    company_today: string;
    outstanding: string;
  }>(sql`
    SELECT
      i.id            AS invoice_id,
      i.account_id    AS account_id,
      i.company_id    AS company_id,
      i.number        AS number,
      i.due_date      AS due_date,
      i.currency      AS currency,
      ct.name         AS customer_name,
      ct.email        AS customer_email,
      c.name          AS company_name,
      c.reply_to_email AS reply_to_email,
      c.business_email AS business_email,
      o.offset_days   AS offset_days,
      (${nowTs}::timestamptz AT TIME ZONE c.timezone)::date AS company_today,
      (i.total - COALESCE((
        SELECT SUM(p.amount) FROM invoice_payments p WHERE p.invoice_id = i.id
      ), 0))::numeric(15,2) AS outstanding
    FROM invoices i
    JOIN companies c ON c.id = i.company_id
    -- INNER join, and NOT NULL on the address below: a reminder with nowhere to
    -- go is not a reminder. Without this the sweep would record a send row for
    -- an invoice whose customer has no email, marking the stage done forever
    -- while nothing was ever delivered.
    JOIN contacts ct ON ct.id = i.contact_id
    CROSS JOIN LATERAL unnest(c.reminder_offsets) AS o(offset_days)
    WHERE c.reminders_enabled
      AND ct.email IS NOT NULL
      AND ct.email <> ''
      AND c.retired_at IS NULL
      AND i.status = 'sent'
      AND NOT i.reminders_opted_out
      -- Guard 1 + 2: the exact day, in the company's zone.
      AND i.due_date + o.offset_days::int
          = (${nowTs}::timestamptz AT TIME ZONE c.timezone)::date
      -- Nothing owed, nothing to chase. A fully refunded invoice still has a
      -- balance and is still a legitimate target, which is why this reads the
      -- payment rows rather than trusting the status column alone.
      AND (i.total - COALESCE((
        SELECT SUM(p.amount) FROM invoice_payments p WHERE p.invoice_id = i.id
      ), 0)) > 0
      -- Send exactly once per stage. The unique index is the real guarantee;
      -- this keeps the sweep from trying and failing on every run.
      AND NOT EXISTS (
        SELECT 1 FROM invoice_reminders r
        WHERE r.invoice_id = i.id AND r.offset_days = o.offset_days
      )
      -- Guard: money arrived recently — stay quiet.
      --
      -- A BOUNDED WINDOW, not an open-ended "after". A bare
      -- received_on > today - 3 also matches every FUTURE-dated receipt, so
      -- recording a post-dated cheque would silently suppress every remaining
      -- stage on that invoice forever — no error, no reminder, no way to
      -- notice. Caught by smoke-testing the query against real rows, not by
      -- reading it.
      AND NOT EXISTS (
        SELECT 1 FROM invoice_payments p
        WHERE p.invoice_id = i.id
          -- ::int on the bound parameter is load-bearing. Untyped, Postgres
          -- resolves date-minus-parameter as date-minus-DATE, which yields an
          -- integer, and the comparison then fails with "operator does not exist:
          -- date > integer". A literal 3 types correctly, which is why this
          -- passed a hand-run psql check and failed the moment it ran
          -- parameterised.
          AND p.received_on
              > (${nowTs}::timestamptz AT TIME ZONE c.timezone)::date
                - ${QUIET_DAYS_AFTER_PAYMENT}::int
          AND p.received_on <= (${nowTs}::timestamptz AT TIME ZONE c.timezone)::date
      )
    ORDER BY i.id, o.offset_days
  `);

  return rows.rows.map((r) => ({
    invoiceId: r.invoice_id,
    accountId: r.account_id,
    companyId: r.company_id,
    number: r.number,
    dueDate: r.due_date,
    currency: r.currency,
    customerName: r.customer_name,
    customerEmail: r.customer_email,
    companyName: r.company_name,
    replyToEmail: r.reply_to_email,
    businessEmail: r.business_email,
    offsetDays: Number(r.offset_days),
    companyToday: r.company_today,
    outstanding: centsToMoney(toCents(r.outstanding)),
  }));
}

// Scans every tenant on the bootstrap handle, then does each send inside its own
// tenant context — same shape as the recurring-invoice sweep.
export async function sweepInvoiceReminders(args: {
  bootstrapDb: Database;
  tenantDb: Database;
  mail: ReminderMailDeps;
  // Freeze door, like the recurring sweep: a lapsed account stops sending mail
  // while its data stays readable. A denied invoice is skipped and left due, so
  // it does NOT silently lose its stage — but note it will only fire again if
  // the exact day comes round, which for a one-off offset it will not. That is
  // the correct trade: a reminder that arrives three weeks late is worse than
  // one that never arrives.
  entitlement?: EntitlementProvider;
  now?: Date;
}): Promise<ReminderSweepResult> {
  const now = args.now ?? new Date();
  const entitlement = args.entitlement ?? communityEntitlements;

  const due = await findDueReminders(args.bootstrapDb, now);

  // Bail before banking anything if mail cannot actually go out (TMC-212).
  //
  // The per-item guard below has always said the right thing — a stage must not
  // be marked sent for an email that never left — but it tested `!mailer`, and
  // bootstrap always wires the console driver, so it never fired. Every sweep
  // on a self-host without email quietly wrote a full set of reminder rows for
  // messages that went to stdout, and configuring email later found every stage
  // already "sent" with the customer never chased. Checked once, up front,
  // rather than per item, so an unconfigured install logs one line instead of a
  // page of failures on every sweep.
  if (due.length > 0 && !mailerDelivers(args.mail.mailer)) {
    log.warn(
      'reminder sweep: email is not configured, so {scanned} due reminder(s) were left for a later sweep',
      { scanned: due.length },
    );
    return { sent: 0, skipped: due.length, failed: 0, scanned: due.length };
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of due) {
    if (!entitlement.can({ accountId: item.accountId }, 'documents:write')) {
      skipped += 1;
      continue;
    }
    try {
      await withAccountContext(
        args.tenantDb,
        { accountId: item.accountId },
        async (tx: Transaction) => {
          // The row goes in FIRST, inside the same transaction as the send. If the
          // insert loses a race with a concurrent sweep the unique index raises,
          // the transaction rolls back, and no mail goes out — which is the right
          // way round. Sending first and recording after leaves a window where a
          // retry re-sends to a real customer.
          await tx.insert(invoiceReminders).values({
            id: uuidv7(),
            accountId: item.accountId,
            companyId: item.companyId,
            invoiceId: item.invoiceId,
            offsetDays: item.offsetDays,
            sentOn: item.companyToday,
            outstanding: item.outstanding,
          });
          // Rendered inside the tenant tx so the company's own edited copy is
          // used, and sent while the row is still uncommitted. A mailer failure
          // throws, the transaction rolls back, the send row disappears — and
          // the stage is retried on the next sweep rather than marked done for
          // an email that never left.
          const template = await resolveEmailTemplate(
            tx,
            item.accountId,
            item.companyId,
            'reminder',
          );
          const { subject, textBody, htmlBody } = renderTemplate(template, {
            customer_name: item.customerName,
            invoice_number: item.number,
            // OUTSTANDING, never the invoice total. Same shape the invoice
            // email uses for its own amount — including the formatting, so a
            // reminder and the original invoice read alike.
            outstanding: formatMoneyDisplay(item.outstanding, item.currency),
            due_date: formatDateDisplay(item.dueDate),
            company_name: item.companyName,
          });
          // No mailer configured (a self-host without SMTP) must NOT bank the
          // row — otherwise switching mail on later finds every stage already
          // "sent" and the customer never hears anything.
          if (!args.mail.mailer) throw new Error('no mailer configured');
          await args.mail.mailer.send({
            to: item.customerEmail,
            subject,
            text: textBody,
            html: htmlBody,
            from: args.mail.emailFrom,
            // Same chain the invoice/estimate/statement sends use: an unset
            // reply-to must not aim a chased customer at the platform.
            replyTo:
              resolveReplyTo(
                { replyToEmail: item.replyToEmail, businessEmail: item.businessEmail },
                args.mail.emailFrom ?? '',
              ) || undefined,
          });
        },
      );
      sent += 1;
    } catch (err) {
      failed += 1;
      // The reminder row rolled back with the transaction above, so the stage
      // will be retried — but the operator still needs to know the chase email
      // is not landing (TMC-226). Its own tx precisely because the one that
      // failed is gone; without this the only trace is a log line nobody reads.
      await withAccountContext(
        args.tenantDb,
        { accountId: item.accountId },
        async (tx: Transaction) => {
          await recordSendFailed(
            tx,
            { accountId: item.accountId, documentId: item.invoiceId, kind: 'invoice' },
            err,
          );
        },
      ).catch(() => {
        // A failure recording a failure is not worth losing the sweep over —
        // the remaining invoices still deserve their reminders.
      });
      log.error('reminder failed for invoice {number}: {err}', {
        number: item.number,
        err: String(err),
      });
    }
  }

  log.info('reminder sweep: {sent} sent, {skipped} skipped, {failed} failed ({scanned} due)', {
    sent,
    skipped,
    failed,
    scanned: due.length,
  });
  return { sent, skipped, failed, scanned: due.length };
}
