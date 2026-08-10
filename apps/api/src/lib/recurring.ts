import { randomBytes } from 'node:crypto';
import {
  type Database,
  type RecurringInvoice,
  SYSTEM_USER_ID,
  type Transaction,
  companies,
  contacts,
  invoiceLineItems,
  invoices,
  recurringInvoiceLineItems,
  recurringInvoices,
  withAccountContext,
} from '@thalermark/db';
import { getLogger } from '@thalermark/logger';
import type { RecurringFrequency } from '@thalermark/validation';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { type AuditWriter, createAuditWriter } from '../middleware/audit.js';
import { recordSendAccepted, recordSendFailed } from './delivery.js';
import { resolveEmailTemplate } from './email-templates.js';
import { type EntitlementProvider, communityEntitlements } from './entitlement.js';
import { sendInvoiceEmail } from './invoice-email.js';
import { suggestNextInvoiceNumber } from './invoice-number.js';
import { postInvoiceTransition } from './ledger.js';
import type { Mailer } from './mailer.js';
import { expenseDateToPostedAt } from './route-helpers.js';
import { createSearchSession } from './search/session.js';

const log = getLogger(['api', 'recurring']);

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return isoDate(dt);
}

// Advance an ISO date by one cadence step. Month / year math clamps the day to
// the last valid day of the target month so Jan 31 +1mo → Feb 28 (not Mar 3),
// and Feb 29 +1yr → Feb 28. Works in UTC to dodge DST/local-tz drift.
export function advanceDate(
  dateIso: string,
  frequency: RecurringFrequency,
  intervalCount: number,
): string {
  if (frequency === 'weekly') {
    return addDaysIso(dateIso, 7 * intervalCount);
  }
  const [y, m, d] = dateIso.split('-').map(Number);
  const year = y ?? 1970;
  const monthIndex = (m ?? 1) - 1;
  const day = d ?? 1;

  let targetYear = year;
  let targetMonth = monthIndex;
  if (frequency === 'monthly') targetMonth += intervalCount;
  else targetYear += intervalCount; // yearly

  // Normalise month overflow into years (no-op for the yearly path).
  targetYear += Math.floor(targetMonth / 12);
  targetMonth = ((targetMonth % 12) + 12) % 12;

  // Clamp to the last day of the target month (day 0 of next month = last day).
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return isoDate(new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay))));
}

export type RecurringMailDeps = {
  mailer?: Mailer;
  emailFrom?: string;
  publicAppUrl?: string;
};

export type GenerateResult = {
  invoiceId: string;
  number: string;
  emailed: boolean;
};

// Generate ONE invoice from a schedule, inside an existing tenant transaction.
// Clones the template header + line items into a fresh invoice minted directly
// in `sent` status (stamps sent_at, mints public_token, sets recurring
// provenance), posts the draft→sent ledger entry, emails the customer
// best-effort, then advances the schedule (next_run_date forward to the next
// future occurrence, occurrence_count++, status→ended when an end condition is
// reached). The email send is best-effort: a mailer failure is logged but does
// NOT roll the generated+sent invoice back (same trade-off as /send).
//
// The `audit` writer carries the actor: SYSTEM_USER_ID for the sweeper,
// the request user for run-now.
export async function generateOnce(
  tx: Transaction,
  args: {
    schedule: RecurringInvoice;
    audit: AuditWriter;
    mail: RecurringMailDeps;
    now?: Date;
  },
): Promise<GenerateResult> {
  const { schedule, audit, mail } = args;
  const now = args.now ?? new Date();
  const accountId = schedule.accountId;
  const todayIso = isoDate(now);
  // Issue the invoice dated today (the day it actually goes out) rather than a
  // possibly-stale next_run_date — avoids back-dating after a downtime gap.
  const issueDate = todayIso;
  const dueDate = addDaysIso(issueDate, schedule.netTermsDays);

  // Auto-number from the company's latest invoice, bumped past any number a
  // manual invoice may already hold.
  const number = await nextFreeNumber(tx, accountId, schedule.companyId);

  const sourceLines = await tx
    .select()
    .from(recurringInvoiceLineItems)
    .where(
      and(
        eq(recurringInvoiceLineItems.recurringInvoiceId, schedule.id),
        eq(recurringInvoiceLineItems.accountId, accountId),
      ),
    )
    .orderBy(asc(recurringInvoiceLineItems.position));

  // Auto-generated invoices go straight out as `sent`, so they must honor the
  // company's from-block display defaults (the recipient never sees a draft to
  // edit). Schedules carry no per-invoice flags of their own.
  const [showCompany] = await tx
    .select({
      showAddress: companies.showAddressOnInvoice,
      showPhone: companies.showPhoneOnInvoice,
      showEmail: companies.showEmailOnInvoice,
    })
    .from(companies)
    .where(and(eq(companies.id, schedule.companyId), eq(companies.accountId, accountId)))
    .limit(1);

  const invoiceId = uuidv7();
  const publicToken = randomBytes(32).toString('hex');
  await tx.insert(invoices).values({
    id: invoiceId,
    accountId,
    companyId: schedule.companyId,
    contactId: schedule.contactId,
    number,
    status: 'sent',
    issueDate,
    dueDate,
    currency: schedule.currency,
    subtotal: schedule.subtotal,
    tax: schedule.tax,
    total: schedule.total,
    notes: schedule.notes,
    showAddress: showCompany?.showAddress ?? true,
    showPhone: showCompany?.showPhone ?? true,
    showEmail: showCompany?.showEmail ?? true,
    sentAt: now,
    publicToken,
    recurringInvoiceId: schedule.id,
  });
  if (sourceLines.length > 0) {
    await tx.insert(invoiceLineItems).values(
      sourceLines.map((li) => ({
        id: uuidv7(),
        accountId,
        invoiceId,
        position: li.position,
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        amount: li.amount,
        // Clone the unit-of-measure snapshot so each generated invoice reads
        // identically to the template.
        unitLabel: li.unitLabel,
        // Clone the product/service type so each generated invoice posts to the
        // same revenue accounts as the template implies.
        type: li.type,
        // Clone the template line's tax snapshot so each generated invoice is
        // taxed identically (the header tax was already copied above).
        taxable: li.taxable,
        taxRatePct: li.taxRatePct,
        taxAmount: li.taxAmount,
        taxPolicyId: li.taxPolicyId,
        // Carry the catalog breadcrumb from the schedule's template line onto
        // each generated invoice line so the report counts recurring sales.
        sourceItemId: li.sourceItemId,
      })),
    );
  }

  await audit({
    entityType: 'invoice',
    entityId: invoiceId,
    action: 'create',
    after: {
      id: invoiceId,
      companyId: schedule.companyId,
      contactId: schedule.contactId,
      number,
      status: 'sent',
      issueDate,
      dueDate,
      total: schedule.total,
      recurringInvoiceId: schedule.id,
    },
    companyId: schedule.companyId,
  });

  // Ledger: the economic event is a draft→sent posting (AR / Revenue, plus
  // Sales Tax Payable when tax > 0). Runs in the same tenant tx so the
  // sum-to-zero trigger fires at commit alongside the invoice insert.
  await postInvoiceTransition(tx, {
    invoice: {
      id: invoiceId,
      number,
      subtotal: schedule.subtotal,
      tax: schedule.tax,
      total: schedule.total,
      // A freshly-minted invoice has never been paid, and draft→sent touches
      // neither Cash nor fees — explicit null rather than an optional field so
      // any future caller has to make the same call consciously.
      processingFee: null,
    },
    prevStatus: 'draft',
    nextStatus: 'sent',
    accountId,
    companyId: schedule.companyId,
    // The invoice's own issue date, matching what a hand-sent invoice does.
    // Generation dates them today so this is the same instant either way —
    // stated explicitly so the two paths can't drift if generation ever learns
    // to backdate.
    postedAt: expenseDateToPostedAt(issueDate),
  });

  // Email best-effort.
  let emailed = false;
  if (mail.mailer) {
    const [customer] = await tx
      .select({ name: contacts.name, email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.id, schedule.contactId), eq(contacts.accountId, accountId)))
      .limit(1);
    const [company] = await tx
      .select({ name: companies.name, replyToEmail: companies.replyToEmail })
      .from(companies)
      .where(and(eq(companies.id, schedule.companyId), eq(companies.accountId, accountId)))
      .limit(1);
    const to = customer?.email?.trim() ?? '';
    if (to) {
      try {
        // Same per-company override resolution as the hand-send route, so an
        // auto-generated invoice matches a hand-sent one.
        const template = await resolveEmailTemplate(tx, accountId, schedule.companyId, 'invoice');
        const { subject } = await sendInvoiceEmail(mail.mailer, to, {
          invoice: {
            number,
            total: schedule.total,
            currency: schedule.currency,
            dueDate,
            publicToken,
          },
          customerName: customer?.name ?? null,
          companyName: company?.name ?? 'Thalermark',
          publicAppUrl: mail.publicAppUrl,
          emailFrom: mail.emailFrom,
          replyToEmail: company?.replyToEmail ?? null,
          template,
        });
        emailed = true;
        await recordSendAccepted(tx, { accountId, documentId: invoiceId, kind: 'invoice' });
        await audit({
          entityType: 'invoice',
          entityId: invoiceId,
          action: 'email-sent',
          after: { to, subject },
          companyId: schedule.companyId,
        });
      } catch (err) {
        // Record it where the operator will see it, not only in the log
        // (TMC-226). This sweep is the worst place for a silent failure: nobody
        // is watching when it runs, so a month of auto-billing could deliver
        // nothing at all while the dashboard looked perfectly healthy.
        await recordSendFailed(tx, { accountId, documentId: invoiceId, kind: 'invoice' }, err);
        // Don't roll back a generated+sent invoice over a mailer hiccup; the
        // invoice is payable from its public link regardless and the operator
        // can re-send from the UI.
        log.warn('recurring invoice {number} generated but email failed: {msg}', {
          number,
          msg: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      log.info('recurring invoice {number} generated; customer has no email, skipping send', {
        number,
      });
    }
  }

  // Advance the schedule. Collapse missed occurrences into one: step the
  // next_run_date forward by the cadence until it is strictly in the future,
  // preserving the anchor day. Then apply end conditions.
  let nextRun = advanceDate(
    schedule.nextRunDate,
    schedule.frequency as RecurringFrequency,
    schedule.intervalCount,
  );
  while (nextRun <= todayIso) {
    nextRun = advanceDate(
      nextRun,
      schedule.frequency as RecurringFrequency,
      schedule.intervalCount,
    );
  }
  const newOccurrenceCount = schedule.occurrenceCount + 1;
  const reachedMax =
    schedule.maxOccurrences !== null && newOccurrenceCount >= schedule.maxOccurrences;
  const pastEnd = schedule.endDate !== null && nextRun > schedule.endDate;
  const ended = reachedMax || pastEnd;

  await tx
    .update(recurringInvoices)
    .set({
      nextRunDate: nextRun,
      occurrenceCount: newOccurrenceCount,
      status: ended ? 'ended' : schedule.status,
      updatedAt: now,
    })
    .where(and(eq(recurringInvoices.id, schedule.id), eq(recurringInvoices.accountId, accountId)));

  return { invoiceId, number, emailed };
}

// Find the next invoice number free within (account, company): the smart-detect
// suggestion off the latest number, bumped past any manually-taken collisions.
async function nextFreeNumber(
  tx: Transaction,
  accountId: string,
  companyId: string,
): Promise<string> {
  const rows = await tx
    .select({ number: invoices.number })
    .from(invoices)
    .where(and(eq(invoices.accountId, accountId), eq(invoices.companyId, companyId)));
  const taken = new Set(rows.map((r) => r.number));
  // Seed from the lexically/serially latest by reusing the suggestion helper on
  // the max trailing number; simplest correct approach is to scan from the
  // suggestion and bump while colliding.
  let candidate = suggestNextInvoiceNumber(maxNumber(rows.map((r) => r.number)));
  let guard = 0;
  while (taken.has(candidate) && guard < 10_000) {
    candidate = suggestNextInvoiceNumber(candidate);
    guard += 1;
  }
  return candidate;
}

const TRAILING_INT = /(\d+)\s*$/;
function maxNumber(numbers: string[]): string | undefined {
  // Pick the number with the largest trailing integer (matches how the manual
  // create/next-number path increments). Falls back to undefined → first
  // default when there are none.
  let best: string | undefined;
  let bestVal = -1n;
  for (const n of numbers) {
    const m = TRAILING_INT.exec(n);
    const val = m ? BigInt(m[1] ?? '0') : -1n;
    if (val > bestVal) {
      bestVal = val;
      best = n;
    }
  }
  return best;
}

export type SweepResult = { due: number; generated: number; skipped: number; failed: number };

// Scan ALL tenants for due schedules (status=active, next_run_date <= today)
// via the bootstrap (BYPASSRLS) handle, then generate each inside its own
// tenant transaction (withAccountContext on the app-role handle) so every write
// is RLS-correct and attributed to the system user. One schedule's failure is
// logged and skipped — it stays due and retries on the next sweep.
export async function sweepRecurringInvoices(args: {
  bootstrapDb: Database;
  tenantDb: Database;
  mail: RecurringMailDeps;
  // Plan-entitlement gate (open-core seam). Recurring generation is a freeze
  // door: a lapsed account must stop auto-generating + emailing invoices while
  // its data stays readable (§5). Community default (self-host) allows every
  // account, so the sweep is unchanged without a provider. A denied schedule is
  // skipped and left due, so it resumes on the next sweep once the account is
  // entitled again.
  entitlement?: EntitlementProvider;
  now?: Date;
}): Promise<SweepResult> {
  const now = args.now ?? new Date();
  const todayIso = isoDate(now);
  const entitlement = args.entitlement ?? communityEntitlements;

  // Retired companies are excluded at the source. This is customer-visible, not
  // just a ledger concern: a business that has stopped trading must not keep
  // emailing invoices under its old name. The join is the belt — the handoff also
  // ends the predecessor's schedules explicitly — but the belt is what protects a
  // company retired by any other route.
  const due = await args.bootstrapDb
    .select({ schedule: recurringInvoices })
    .from(recurringInvoices)
    .innerJoin(companies, eq(companies.id, recurringInvoices.companyId))
    .where(
      and(
        eq(recurringInvoices.status, 'active'),
        lte(recurringInvoices.nextRunDate, todayIso),
        isNull(companies.retiredAt),
      ),
    )
    .then((rows) => rows.map((r) => r.schedule));

  let generated = 0;
  let skipped = 0;
  let failed = 0;
  for (const schedule of due) {
    if (!entitlement.can({ accountId: schedule.accountId }, 'documents:write')) {
      skipped += 1;
      continue;
    }
    try {
      await withAccountContext(args.tenantDb, { accountId: schedule.accountId }, async (tx) => {
        // Same search session the request path uses, so an invoice generated at
        // 6am is findable the moment it exists rather than at the next weekly
        // reindex.
        const search = createSearchSession(tx, schedule.accountId);
        const audit = createAuditWriter({
          tx,
          accountId: schedule.accountId,
          actorUserId: SYSTEM_USER_ID,
          onWrite: (entry) => search.note(entry.entityType, entry.entityId),
        });
        await generateOnce(tx, { schedule, audit, mail: args.mail, now });
        await search.flush();
      });
      generated += 1;
    } catch (err) {
      failed += 1;
      log.error('recurring sweep failed for schedule {id}: {msg}', {
        id: schedule.id,
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (due.length > 0) {
    log.info('recurring sweep: {generated}/{due} generated ({skipped} skipped, {failed} failed)', {
      generated,
      due: due.length,
      skipped,
      failed,
    });
  }
  return { due: due.length, generated, skipped, failed };
}
