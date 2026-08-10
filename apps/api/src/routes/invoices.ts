import { randomBytes } from 'node:crypto';
import {
  type InvoicePayment,
  type Transaction,
  companies,
  contacts,
  expenseAllocations,
  expenses,
  invoiceLineItems,
  invoicePayments,
  invoices,
  timeEntries,
} from '@thalermark/db';
import { emit } from '@thalermark/telemetry';
import {
  centsToMoney,
  invoiceCreateSchema,
  invoiceDepositSchema,
  invoiceMarkPaidSchema,
  invoicePaymentCreateSchema,
  invoiceRemindersSchema,
  invoiceSendSchema,
  invoiceUpdateSchema,
  toCents,
} from '@thalermark/validation';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import type { AppDeps } from '../app.js';
import { resolveEmailTemplate } from '../lib/email-templates.js';
import { sendInvoiceEmail } from '../lib/invoice-email.js';
import { suggestNextInvoiceNumber } from '../lib/invoice-number.js';
import {
  checkPaymentEligibility,
  paidCentsForInvoice,
  paymentCountForInvoice,
  summarizeSettlement,
  syncInvoiceSettlement,
} from '../lib/invoice-payments.js';
import {
  BILLED_INVOICE_STATUSES,
  assertJobInCompany,
  jobMade,
  stampBilledTimeEntries,
  validateBilledTimeEntries,
} from '../lib/job-costing.js';
import {
  postInvoicePayment,
  postInvoicePaymentReversal,
  postInvoiceTransition,
  receiptCreditForInvoice,
  repostInvoicePaymentDate,
} from '../lib/ledger.js';
import { mailerDelivers } from '../lib/mailer.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import {
  EMAIL_RE,
  UUID_RE,
  escapeLike,
  expenseDateToPostedAt,
  isValidDateParam,
  localToday,
} from '../lib/route-helpers.js';
import type { AuditWriter } from '../middleware/audit.js';
import { requireCapability } from '../middleware/authz.js';
import { requireEntitlement } from '../middleware/entitlement.js';
import { RATE_LIMITS, rateLimit } from '../middleware/rate-limit.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// invoices — the sales-invoice domain: CRUD + duplicate-as-template, the
// next-number suggestion, the draft-only PATCH, the status transitions
// (mark-sent / mark-paid / void / edit-payment), and the email send. A
// deps-taking sub-app (the /send route closes over deps.mailer /
// deps.emailFrom). The invoice status state machine + ledger posting live in
// transitionInvoice below. Mounted on createApp via .route() so its schema
// rides on its own InvoicesAppType instead of bloating AppType past TS7056.
// Route order is load-bearing: literal /next-number is declared before
// /:id so Hono's first-match doesn't capture it as an id.
// The receipt a previous request already wrote under this idempotency key, if
// there is one (TMC-218).
//
// WHY A SELECT IS SAFE HERE AND NOWHERE ELSE. Asking "does this key already
// exist?" BEFORE inserting is a race with nothing behind it: two concurrent
// requests both read nothing and both insert. This is only ever called after
// something else has already refused the write — either
// invoice_payments_idempotency_uq turned the insert into a no-op, or a status
// transition refused to re-run. Both mean the winning transaction has committed,
// so this read is looking at settled history rather than guessing at it.
//
// Deliberately NOT scoped to an invoice: the unique index is account-wide, and
// the callers need to SEE a key that was reused against a different invoice
// rather than silently miss it.
async function paymentForIdempotencyKey(
  tx: Transaction,
  args: { accountId: string; idempotencyKey: string },
): Promise<InvoicePayment | undefined> {
  const [row] = await tx
    .select()
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.accountId, args.accountId),
        eq(invoicePayments.idempotencyKey, args.idempotencyKey),
      ),
    )
    .limit(1);
  return row;
}

// Invoice status state machine. Allowed transitions:
//   draft → sent     (mark-sent)
//   draft → paid     (mark-paid, manual mark-paid without sending)
//   sent  → paid     (mark-paid)
//   draft → voided   (void)
//   sent  → voided   (void)
// `paid` and `voided` are terminal. Each transition stamps its dedicated
// timestamp column; the stamps are write-once via the state machine. Driven
// off a single table so the three endpoints below stay symmetric and any
// future transition (e.g. `unvoid`) is a one-line addition here.
type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'voided';
type TransitionKey = 'mark-sent' | 'mark-paid' | 'void';
type TransitionSpec = {
  from: readonly InvoiceStatus[];
  to: InvoiceStatus;
  stamp: 'sentAt' | 'paidAt' | 'voidedAt';
};
const INVOICE_TRANSITIONS: Record<TransitionKey, TransitionSpec> = {
  'mark-sent': { from: ['draft'], to: 'sent', stamp: 'sentAt' },
  'mark-paid': { from: ['draft', 'sent'], to: 'paid', stamp: 'paidAt' },
  void: { from: ['draft', 'sent'], to: 'voided', stamp: 'voidedAt' },
};

// Which ledger date a transition belongs on.
//
// draft→sent recognises revenue, and revenue is earned when the invoice is
// ISSUED — not when someone got round to clicking send. Billing on 2 June and
// sending on 27 July is one economic event dated 2 June; posting it in July
// moves income between reporting periods and, if the two fall either side of a
// year end, onto the wrong return.
//
// sent→voided has to follow it. Both sides post at `now` today, so they net
// within a period by accident; moving only the first would swap a hidden bug for
// a visible one — revenue in June, its reversal in July.
//
// The cash transitions are deliberately NOT here. draft→paid and sent→paid
// belong on the day the money actually arrived, which the caller already
// supplies as `paidOn`.
function postsOnIssueDate(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return (from === 'draft' && to === 'sent') || (from === 'sent' && to === 'voided');
}

type TransitionResult =
  | { ok: true; invoice: typeof invoices.$inferSelect; from: InvoiceStatus }
  | { ok: false; error: 'invoice_not_found' }
  | { ok: false; error: 'invalid_transition'; from: string; to: InvoiceStatus };

// The ONE path that moves an invoice between statuses, status flip and ledger
// posting welded together.
//
// It is a tx-level helper rather than a route handler because two routes need
// it: the mark-* endpoints and the email send, which runs its flip inside a
// larger transaction so the connection is released before Resend is called.
// /send used to do its own inline UPDATE instead — it shipped five days before
// ledger posting was wired into transitions and never got it, so every emailed
// invoice was off the books entirely. Having one function own both halves is
// what stops that recurring; a new caller cannot flip a status without posting.
//
// Telemetry stays with the callers: the two send paths report different
// delivery methods for the same transition.
async function applyInvoiceTransition(
  tx: Transaction,
  audit: AuditWriter,
  args: {
    accountId: string;
    id: string;
    key: TransitionKey;
    spec: TransitionSpec;
    // `patch` adds columns merged after the base patch (payment method/
    // reference); `effectiveAt` overrides the economic date used for the status
    // stamp and, for the cash transitions, the ledger posting date — so a
    // backdated payment lands in the right reporting period. Defaults to now.
    patch?: Record<string, unknown>;
    effectiveAt?: Date;
    // mark-paid posts a RECEIPT instead of a whole-document entry (TMC-196), so
    // it suppresses the transition's own posting rather than double-banking the
    // money. Nothing else sets this: draft→sent and sent→voided are genuine
    // document-level events with no receipt behind them.
    skipLedgerPosting?: boolean;
  },
): Promise<TransitionResult> {
  const { accountId, id, key, spec } = args;

  const [current] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
    .limit(1);
  if (!current) return { ok: false, error: 'invoice_not_found' };

  if (!(spec.from as readonly string[]).includes(current.status)) {
    return { ok: false, error: 'invalid_transition', from: current.status, to: spec.to };
  }
  const from = current.status as InvoiceStatus;

  const now = new Date();
  // updatedAt is always record-time; the stamp (paidAt/sentAt/voidedAt) uses the
  // economic date, which a caller can backdate via effectiveAt.
  const effectiveAt = args.effectiveAt ?? now;
  // sentAt deliberately stays at `now` even when the posting is backdated. When
  // the invoice went out is an operational fact and the ledger date is an
  // economic one; only mark-paid's `paidOn` is genuinely both.
  const postedAt = postsOnIssueDate(from, spec.to)
    ? expenseDateToPostedAt(current.issueDate)
    : effectiveAt;
  const patch: Record<string, unknown> = {
    status: spec.to,
    updatedAt: now,
    [spec.stamp]: effectiveAt,
  };
  // mark-sent mints the public-view token if the invoice doesn't have one
  // yet. 32 random bytes hex matches the invitation token pattern (large
  // enough that brute-force enumeration is uneconomical even without rate
  // limiting). Idempotent: a future re-send transition would keep the same
  // token so the shared URL stays stable for the recipient.
  if (key === 'mark-sent' && !current.publicToken) {
    patch.publicToken = randomBytes(32).toString('hex');
  }
  if (args.patch) Object.assign(patch, args.patch);
  // Re-assert the exact status we validated above so a concurrent transition
  // (an overlapping mark-paid, or the Stripe webhook flipping sent → paid)
  // can't double-apply. Under READ COMMITTED the losing UPDATE re-checks this
  // predicate against the freshly committed row, matches 0 rows, and bails
  // before postInvoiceTransition double-posts to the ledger. A 0-row result
  // here means the row moved out from under us → same 409 as the SELECT-time
  // invalid-transition check.
  const [updated] = await tx
    .update(invoices)
    .set(patch)
    .where(
      and(
        eq(invoices.id, id),
        eq(invoices.accountId, accountId),
        eq(invoices.status, current.status),
      ),
    )
    .returning();
  if (!updated) {
    return { ok: false, error: 'invalid_transition', from: current.status, to: spec.to };
  }

  // Voiding releases any tracked hours the invoice was carrying (TMC-180).
  //
  // Cancelling the invoice cancels the claim on that time, so the hours go back
  // to unbilled and can be billed again. Without this they stay stamped to a
  // voided invoice forever: never listed as unbilled, never billable to a new
  // one — the work silently becomes unchargeable. There is no invoice DELETE
  // endpoint, so void is the ONLY way out of a wrong invoice, which makes this
  // the only recovery path rather than an edge case.
  //
  // Same reasoning as billed_invoice_id being ON DELETE SET NULL rather than
  // cascade: cancel the document, keep the record that the work happened.
  if (spec.to === 'voided') {
    await tx
      .update(timeEntries)
      .set({ billedInvoiceId: null, updatedAt: now })
      .where(and(eq(timeEntries.accountId, accountId), eq(timeEntries.billedInvoiceId, id)));
  }

  await audit({
    entityType: 'invoice',
    entityId: id,
    action: key,
    before: {
      status: current.status,
      sentAt: current.sentAt,
      paidAt: current.paidAt,
      voidedAt: current.voidedAt,
      publicToken: current.publicToken,
      paymentMethod: current.paymentMethod,
      paymentReference: current.paymentReference,
    },
    after: {
      status: updated.status,
      sentAt: updated.sentAt,
      paidAt: updated.paidAt,
      voidedAt: updated.voidedAt,
      publicToken: updated.publicToken,
      paymentMethod: updated.paymentMethod,
      paymentReference: updated.paymentReference,
    },
    companyId: updated.companyId,
  });

  // Ledger posting (slice L2). Runs inside the same tenant tx so the
  // deferred sum-to-zero trigger on journal_lines fires at commit and a
  // posting failure rolls the status flip + audit back together. Empty-
  // amount transitions (draft → voided, total=0 invoice) post nothing.
  if (!args.skipLedgerPosting) {
    await postInvoiceTransition(tx, {
      invoice: updated,
      prevStatus: from,
      nextStatus: updated.status as InvoiceStatus,
      accountId,
      companyId: updated.companyId,
      postedAt,
    });
  }

  return { ok: true, invoice: updated, from };
}

// Route-handler wrapper: runs the transition on the request's tenant tx and maps
// the outcome to JSON. The mark-* endpoints use this; /send drives
// applyInvoiceTransition directly because its flip belongs inside a wider tx.
async function transitionInvoice(
  c: Context<{ Variables: RlsVariables }>,
  id: string,
  key: TransitionKey,
  spec: TransitionSpec,
  opts?: { patch?: Record<string, unknown>; effectiveAt?: Date },
) {
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
  const tx = c.get('tx');
  const accountId = c.get('accountId');

  const result = await applyInvoiceTransition(tx, c.var.audit, {
    accountId,
    id,
    key,
    spec,
    patch: opts?.patch,
    effectiveAt: opts?.effectiveAt,
  });
  if (!result.ok) {
    if (result.error === 'invoice_not_found') return c.json({ error: result.error }, 404);
    return c.json({ error: result.error, from: result.from, to: result.to }, 409);
  }

  // Telemetry (opt-in; no-op unless the account enabled it). mark-sent here is
  // the "share a link" delivery; the /send route emits invoice_sent{email}
  // separately for the email path. void emits nothing (TELEMETRY.md).
  if (key === 'mark-sent') {
    await emit(tx, { name: 'invoice_sent', delivery_method: 'link' });
  } else if (key === 'mark-paid') {
    await emit(tx, { name: 'invoice_marked_paid' });
  }

  return c.json(result.invoice);
}

export function invoicesRoutes(deps: AppDeps) {
  return (
    new Hono<{ Variables: RlsVariables }>()
      .post(
        '/api/invoices',
        requireCapability('sales:write'),
        requireEntitlement(deps, 'documents:write'),
        async (c) => {
          const body = await c.req.json().catch(() => null);
          const parsed = invoiceCreateSchema.safeParse(body);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }

          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const { companyId, contactId, lineItems, ...header } = parsed.data;
          // Which hours this invoice bills is DERIVED from the lines, not sent
          // alongside them. One source of truth: a line carries its entry, so a
          // line the client dropped takes its entry with it and the two can
          // never disagree.
          const billedTimeEntryIds = lineItems
            .map((li) => li.timeEntryId)
            .filter((v): v is string => v !== undefined);

          // Customer must belong to this account AND match the requested companyId.
          // The schema does not enforce the customer↔company link at the DB level
          // (contacts carry companyId; invoices independently set companyId), so
          // we check it here to avoid an invoice that disagrees with its customer.
          const [customer] = await tx
            .select({ id: contacts.id, companyId: contacts.companyId })
            .from(contacts)
            .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
            .limit(1);
          if (!customer) return c.json({ error: 'contact_not_found' }, 404);
          if (customer.companyId !== companyId) {
            return c.json({ error: 'customer_company_mismatch' }, 400);
          }

          // Pre-check the (company_id, number) unique constraint so we can return
          // a clean 409 without aborting the tenant tx (a constraint violation
          // would poison the tx and force the rls-context wrapper to roll back
          // everything, including any audit row we'd want to write).
          const [taken] = await tx
            .select({ id: invoices.id })
            .from(invoices)
            .where(
              and(
                eq(invoices.accountId, accountId),
                eq(invoices.companyId, companyId),
                eq(invoices.number, header.number),
              ),
            )
            .limit(1);
          if (taken) return c.json({ error: 'invoice_number_taken' }, 409);

          const jobError = await assertJobInCompany(tx, accountId, companyId, header.jobId);
          if (jobError) return c.json({ error: jobError.error }, jobError.status);

          // Validated BEFORE the insert. A failure discovered afterwards would
          // still commit the invoice — the tenant tx only rolls back on a thrown
          // error, not a returned one — leaving billable hours attached to
          // nothing and free to be billed a second time.
          const billError = await validateBilledTimeEntries(
            tx,
            accountId,
            companyId,
            header.jobId ?? null,
            billedTimeEntryIds,
            null,
          );
          if (billError) return c.json({ error: billError.error }, billError.status);

          // Seed the per-invoice from-block "show" flags from the company's
          // defaults when the client didn't send them (e.g. an API client that
          // doesn't render the toggles). The web/mobile forms send explicit
          // values, which win via the ?? below. The customer↔company check above
          // guarantees this company exists.
          const [companyDefaults] = await tx
            .select({
              showAddressOnInvoice: companies.showAddressOnInvoice,
              showPhoneOnInvoice: companies.showPhoneOnInvoice,
              showEmailOnInvoice: companies.showEmailOnInvoice,
            })
            .from(companies)
            .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
            .limit(1);
          if (!companyDefaults) return c.json({ error: 'company_not_found' }, 404);
          const showFlags = {
            showAddress: header.showAddress ?? companyDefaults.showAddressOnInvoice,
            showPhone: header.showPhone ?? companyDefaults.showPhoneOnInvoice,
            showEmail: header.showEmail ?? companyDefaults.showEmailOnInvoice,
          };

          // First-invoice onboarding milestone (server-authoritative). Checked
          // BEFORE the insert so "the account's first invoice" is honest.
          const [priorInvoice] = await tx
            .select({ id: invoices.id })
            .from(invoices)
            .where(eq(invoices.accountId, accountId))
            .limit(1);

          const invoiceId = uuidv7();
          await tx.insert(invoices).values({
            id: invoiceId,
            accountId,
            companyId,
            contactId,
            ...header,
            ...showFlags,
          });
          const lineRows = lineItems.map((li) => ({
            id: uuidv7(),
            accountId,
            invoiceId,
            ...li,
          }));
          await tx.insert(invoiceLineItems).values(lineRows);

          await stampBilledTimeEntries(tx, accountId, invoiceId, billedTimeEntryIds);

          await c.var.audit({
            entityType: 'invoice',
            entityId: invoiceId,
            action: 'create',
            after: { id: invoiceId, ...parsed.data, ...showFlags },
            companyId,
          });

          // Telemetry (opt-in; no-op unless the account enabled it). Count only —
          // no amounts (TELEMETRY.md).
          await emit(tx, { name: 'invoice_created', line_item_count: lineItems.length });
          if (!priorInvoice) {
            await emit(tx, { name: 'onboarding_step_completed', step: 'first_invoice' });
          }

          return c.json({ id: invoiceId, ...parsed.data, ...showFlags }, 201);
        },
      )
      // Duplicate-as-template: clone any invoice into a fresh draft to reuse as
      // a starting point. Copies customer + line items + header amounts/notes;
      // gives it a new number and today/Net-30 dates; status, stamps, and the
      // public token are deliberately NOT copied (it starts clean at draft, no
      // ledger posting until mark-sent). Unlike estimate→invoice convert this is
      // intentionally repeatable — no idempotency link. Any source status is a
      // valid template (draft/sent/paid/voided).
      .post('/api/invoices/:id/duplicate', requireCapability('sales:write'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [source] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
          .limit(1);
        if (!source) return c.json({ error: 'invoice_not_found' }, 404);

        const sourceLines = await tx
          .select()
          .from(invoiceLineItems)
          .where(and(eq(invoiceLineItems.invoiceId, id), eq(invoiceLineItems.accountId, accountId)))
          .orderBy(asc(invoiceLineItems.position));

        const today = new Date();
        const todayIso = today.toISOString().slice(0, 10);
        const dueIso = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);

        const [latest] = await tx
          .select({ number: invoices.number })
          .from(invoices)
          .where(and(eq(invoices.accountId, accountId), eq(invoices.companyId, source.companyId)))
          .orderBy(desc(invoices.createdAt))
          .limit(1);
        const number = suggestNextInvoiceNumber(latest?.number);

        const [taken] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.accountId, accountId),
              eq(invoices.companyId, source.companyId),
              eq(invoices.number, number),
            ),
          )
          .limit(1);
        if (taken) return c.json({ error: 'invoice_number_collision', number }, 409);

        const invoiceId = uuidv7();
        await tx.insert(invoices).values({
          id: invoiceId,
          accountId,
          companyId: source.companyId,
          contactId: source.contactId,
          number,
          issueDate: todayIso,
          dueDate: dueIso,
          currency: source.currency,
          subtotal: source.subtotal,
          tax: source.tax,
          total: source.total,
          notes: source.notes,
          // A duplicate is a template — carry the source's from-block display
          // choices forward rather than re-seeding from company defaults.
          showAddress: source.showAddress,
          showPhone: source.showPhone,
          showEmail: source.showEmail,
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
              // Carry the unit-of-measure snapshot forward (duplicate = same terms).
              unitLabel: li.unitLabel,
              // Carry the product/service type forward so the duplicate posts
              // to the same revenue accounts.
              type: li.type,
              // Carry the line's tax snapshot forward — a duplicate keeps the
              // same taxability/rate it was sold at.
              taxable: li.taxable,
              taxRatePct: li.taxRatePct,
              taxAmount: li.taxAmount,
              taxPolicyId: li.taxPolicyId,
              // Carry the catalog breadcrumb forward — a duplicated line is
              // still the same product, so the top-products report counts it.
              sourceItemId: li.sourceItemId,
            })),
          );
        }

        await c.var.audit({
          entityType: 'invoice',
          entityId: invoiceId,
          action: 'create',
          after: {
            id: invoiceId,
            companyId: source.companyId,
            contactId: source.contactId,
            number,
            issueDate: todayIso,
            dueDate: dueIso,
            currency: source.currency,
            subtotal: source.subtotal,
            tax: source.tax,
            total: source.total,
            notes: source.notes,
            duplicatedFromInvoiceId: id,
          },
          companyId: source.companyId,
        });

        return c.json({ id: invoiceId }, 201);
      })
      .get('/api/invoices', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const status = c.req.query('status');
        // Filters (slice mirrors the web/mobile filter bars): q searches the
        // invoice number OR the joined customer name; from/to bound issueDate
        // (inclusive); contactId narrows to one customer. All compose with the
        // keyset scan as plain extra WHERE conditions.
        const q = c.req.query('q');
        const from = c.req.query('from');
        const to = c.req.query('to');
        const contactId = c.req.query('contactId');
        if (from !== undefined && !isValidDateParam(from))
          return c.json({ error: 'invalid_from' }, 400);
        if (to !== undefined && !isValidDateParam(to)) return c.json({ error: 'invalid_to' }, 400);
        if (contactId !== undefined && !UUID_RE.test(contactId))
          return c.json({ error: 'invalid_customer_id' }, 400);
        const limit = parseLimit(c.req.query('limit'));
        if (limit === null) return c.json({ error: 'invalid_limit' }, 400);
        const keys = [
          { col: invoices.createdAt, revive: (v: unknown) => new Date(v as string) },
          { col: invoices.id },
        ];
        const keyset = applyCursor(c.req.query('cursor'), keys, 'desc');
        if (keyset === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);
        const conditions = [eq(invoices.accountId, accountId)];
        if (companyId) conditions.push(eq(invoices.companyId, companyId));
        if (status) conditions.push(eq(invoices.status, status));
        if (contactId) conditions.push(eq(invoices.contactId, contactId));
        if (from) conditions.push(gte(invoices.issueDate, from));
        if (to) conditions.push(lte(invoices.issueDate, to));
        // Derived date-partition filters over the sent-but-unpaid pool (no such
        // stored status): overdue = sent AND past due; awaiting = sent AND not
        // yet due. Back the Overdue / Awaiting metric tiles' click-through so
        // the filtered list matches the tile count exactly. Compose with the
        // keyset scan like the other conditions.
        if (c.req.query('overdue') === 'true') {
          const today = new Date().toISOString().slice(0, 10);
          // biome-ignore lint/style/noNonNullAssertion: and() with >=1 arg is non-null
          conditions.push(and(eq(invoices.status, 'sent'), lt(invoices.dueDate, today))!);
        }
        if (c.req.query('awaiting') === 'true') {
          const today = new Date().toISOString().slice(0, 10);
          // biome-ignore lint/style/noNonNullAssertion: and() with >=1 arg is non-null
          conditions.push(and(eq(invoices.status, 'sent'), gte(invoices.dueDate, today))!);
        }
        if (q) {
          const term = `%${escapeLike(q)}%`;
          // biome-ignore lint/style/noNonNullAssertion: or() with >=1 arg is non-null
          conditions.push(or(ilike(invoices.number, term), ilike(contacts.name, term))!);
        }
        if (keyset) conditions.push(keyset);
        // LEFT JOIN the customer name so the list renders without the client
        // fetching every customer (which paginated lists can't do at volume).
        const rows = await tx
          .select({ ...getTableColumns(invoices), customerName: contacts.name })
          .from(invoices)
          .leftJoin(contacts, eq(contacts.id, invoices.contactId))
          .where(and(...conditions))
          .orderBy(keysetOrderBy(keys, 'desc'))
          .limit(limit + 1);
        const page = slicePage(rows, limit, (r) => [r.createdAt, r.id]);
        return c.json({ invoices: page.rows, nextCursor: page.nextCursor });
      })
      // Status summary powering the invoices-page metric strip and the
      // dashboard count tiles. Point-in-time, NOT period-bound. 'awaiting' and
      // 'overdue' partition the sent-but-unpaid pool by due date (mutually
      // exclusive → their $ sum to total outstanding with no double count);
      // 'draft' is count-only. One round-trip of COUNT/SUM ... FILTER over the
      // status index. Declared before /:id — Hono is first-match.
      //
      // The money here is what is STILL OWED, net of receipts — same figure as
      // the A/R aging report and the dashboard's ledger-derived arBalance. The
      // counts are still whole invoices: a part-paid invoice is one invoice
      // awaiting payment, for less money.
      .get('/api/invoices/summary', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const today = new Date().toISOString().slice(0, 10);
        const conditions = [eq(invoices.accountId, accountId)];
        if (companyId) conditions.push(eq(invoices.companyId, companyId));
        const awaiting = sql`${invoices.status} = 'sent' and ${invoices.dueDate} >= ${today}::date`;
        const overdue = sql`${invoices.status} = 'sent' and ${invoices.dueDate} < ${today}::date`;
        // Receipts per invoice, grouped once and LEFT JOINed, so the strip
        // reports what is still owed rather than what was originally billed
        // (TMC-216). One row per invoice, so the join cannot multiply the
        // counts. Kept as a join rather than a correlated subquery to preserve
        // the single round trip this endpoint was written for.
        const paidPerInvoice = tx
          .select({
            invoiceId: invoicePayments.invoiceId,
            paid: sql<string>`sum(${invoicePayments.amount})`.as('paid'),
          })
          .from(invoicePayments)
          .where(eq(invoicePayments.accountId, accountId))
          .groupBy(invoicePayments.invoiceId)
          .as('paid_per_invoice');
        const owed = sql`${invoices.total} - coalesce(${paidPerInvoice.paid}, 0)`;
        const [row] = await tx
          .select({
            draftCount: sql<number>`(count(*) filter (where ${invoices.status} = 'draft'))::int`,
            awaitingCount: sql<number>`(count(*) filter (where ${awaiting}))::int`,
            // ::numeric(15,2) before ::text, so an empty bucket renders '0.00'
            // like every other money value on the wire rather than a bare '0'.
            awaitingTotal: sql<string>`coalesce(sum(${owed}) filter (where ${awaiting}), 0)::numeric(15,2)::text`,
            overdueCount: sql<number>`(count(*) filter (where ${overdue}))::int`,
            overdueTotal: sql<string>`coalesce(sum(${owed}) filter (where ${overdue}), 0)::numeric(15,2)::text`,
          })
          .from(invoices)
          .leftJoin(paidPerInvoice, eq(paidPerInvoice.invoiceId, invoices.id))
          .where(and(...conditions));
        return c.json({
          draft: { count: row?.draftCount ?? 0 },
          awaiting: { count: row?.awaitingCount ?? 0, total: row?.awaitingTotal ?? '0' },
          overdue: { count: row?.overdueCount ?? 0, total: row?.overdueTotal ?? '0' },
        });
      })
      .get('/api/invoices/next-number', async (c) => {
        // Must be declared before /api/invoices/:id — Hono is first-match, and
        // 'next-number' would otherwise hit the :id handler and fail the UUID
        // regex with a 400.
        const companyId = c.req.query('companyId');
        if (!companyId || !UUID_RE.test(companyId)) {
          return c.json({ error: 'invalid_company_id' }, 400);
        }
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        const [latest] = await tx
          .select({ number: invoices.number })
          .from(invoices)
          .where(and(eq(invoices.accountId, accountId), eq(invoices.companyId, companyId)))
          .orderBy(desc(invoices.createdAt))
          .limit(1);

        return c.json({ suggestion: suggestNextInvoiceNumber(latest?.number) });
      })
      .get('/api/invoices/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [invoice] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)));
        if (!invoice) return c.json({ error: 'invoice_not_found' }, 404);
        const lines = await tx
          .select()
          .from(invoiceLineItems)
          .where(and(eq(invoiceLineItems.invoiceId, id), eq(invoiceLineItems.accountId, accountId)))
          .orderBy(asc(invoiceLineItems.position));
        // Job costing (TMC-174). INTERNAL ONLY — this must never reach the
        // recipient. The public view lives in routes/public.ts and builds its
        // own payload field by field, so nothing here leaks by default; that
        // separation is the safeguard and it is covered by a test.
        //
        // Billed is the SUBTOTAL, not the total: sales tax he collects is not
        // his money, and counting it would inflate every taxed job's margin.
        //
        // Computed fresh, never stored — edit the invoice or fix a receipt
        // amount and the number moves with it.
        const costRows = await tx
          .select({ amount: expenses.amount, share: expenseAllocations.share })
          .from(expenseAllocations)
          .innerJoin(expenses, eq(expenses.id, expenseAllocations.expenseId))
          .where(
            and(
              eq(expenseAllocations.invoiceId, id),
              eq(expenseAllocations.accountId, accountId),
              isNull(expenses.deletedAt),
            ),
          );
        const costCents = costRows.reduce(
          (total, row) => total + Math.round(Number(row.amount) * 100 * Number(row.share)),
          0,
        );
        // Recognised revenue, not the raw subtotal (TMC-204). This block had no
        // notion of status at all, so one $900 invoice with $340 of receipts
        // reported "made $560" identically whether it was sent, still a draft,
        // or VOIDED — reporting a profit on revenue that had been cancelled.
        //
        // That is the TMC-183 defect at a fourth call site, and it survived that
        // cleanup because there was no wrong predicate to find: the filter was
        // absent rather than mistaken, so no grep for 'void' could surface it.
        const recognised = BILLED_INVOICE_STATUSES.includes(
          invoice.status as (typeof BILLED_INVOICE_STATUSES)[number],
        );
        const billedCents = recognised ? Math.round(Number(invoice.subtotal) * 100) : 0;
        const jobCosting = {
          billed: (billedCents / 100).toFixed(2),
          // What this invoice would bill once sent. Zero unless it is a draft —
          // a voided invoice is not pending, it is cancelled.
          drafted: invoice.status === 'draft' ? invoice.subtotal : '0.00',
          costs: (costCents / 100).toFixed(2),
          // Same rule the job screen and the report use: withheld while the
          // revenue is still coming, stated as a real loss once it never will.
          made: jobMade(billedCents, costCents, invoice.status === 'draft'),
          costCount: costRows.length,
        };
        return c.json({ ...invoice, lineItems: lines, jobCosting });
      })
      .patch(
        '/api/invoices/:id',
        requireCapability('sales:write'),
        validator('json', (value, c) => {
          const parsed = invoiceUpdateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const data = c.req.valid('json');

          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const { contactId, lineItems, ...header } = data;
          // Derived from the submitted lines, so removing an hour line releases
          // its entry — the whole reason the line carries the link.
          const billedTimeEntryIds = lineItems
            .map((li) => li.timeEntryId)
            .filter((v): v is string => v !== undefined);

          const [current] = await tx
            .select()
            .from(invoices)
            .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'invoice_not_found' }, 404);

          // Edits are draft-only. Once an invoice is sent / paid / voided the
          // numbers + line items are part of the customer-facing record and
          // mutating them silently is a footgun (and an audit-trail
          // misdirection — the audit row would say "update" but the
          // counterparty has the old version). Future work: allow corrections
          // that explicitly supersede a sent invoice with a credit note.
          if (current.status !== 'draft') {
            return c.json({ error: 'not_editable', status: current.status }, 409);
          }

          // contactId is mutable on edit, so the customer↔company invariant
          // needs the same check the create endpoint does. companyId is fixed
          // (omitted from the update schema) — the invoice cannot move
          // between companies — so we compare against current.companyId.
          const [customer] = await tx
            .select({ id: contacts.id, companyId: contacts.companyId })
            .from(contacts)
            .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
            .limit(1);
          if (!customer) return c.json({ error: 'contact_not_found' }, 404);
          if (customer.companyId !== current.companyId) {
            return c.json({ error: 'customer_company_mismatch' }, 400);
          }

          // Same 409 pre-check as create: if the number changed and the new
          // one is taken, return cleanly without poisoning the tenant tx.
          // Numbers are unique per (account_id, company_id) — no-op when
          // nothing changed.
          if (header.number !== current.number) {
            const [taken] = await tx
              .select({ id: invoices.id })
              .from(invoices)
              .where(
                and(
                  eq(invoices.accountId, accountId),
                  eq(invoices.companyId, current.companyId),
                  eq(invoices.number, header.number),
                ),
              )
              .limit(1);
            if (taken) return c.json({ error: 'invoice_number_taken' }, 409);
          }

          const jobError = await assertJobInCompany(tx, accountId, current.companyId, header.jobId);
          if (jobError) return c.json({ error: jobError.error }, jobError.status);

          // Same ordering rule as create: every check that can fail runs before
          // the first write, because a returned error still commits.
          const nextJobId = header.jobId === undefined ? current.jobId : header.jobId;
          const billError = await validateBilledTimeEntries(
            tx,
            accountId,
            current.companyId,
            nextJobId,
            billedTimeEntryIds,
            id,
          );
          if (billError) return c.json({ error: billError.error }, billError.status);

          // Read the existing lines so the audit row diff carries the prior
          // state. Done before delete so we don't lose the data on rollback.
          const beforeLines = await tx
            .select()
            .from(invoiceLineItems)
            .where(
              and(eq(invoiceLineItems.invoiceId, id), eq(invoiceLineItems.accountId, accountId)),
            )
            .orderBy(asc(invoiceLineItems.position));

          // Line items: full replacement. Delete the old set, insert the new
          // — simpler than diffing positions + ids, and the edit form always
          // submits the whole set anyway. Both writes run in the same tenant
          // tx so a failure rolls everything back.
          await tx
            .delete(invoiceLineItems)
            .where(
              and(eq(invoiceLineItems.invoiceId, id), eq(invoiceLineItems.accountId, accountId)),
            );
          const newLineRows = lineItems.map((li) => ({
            id: uuidv7(),
            accountId,
            invoiceId: id,
            ...li,
          }));
          await tx.insert(invoiceLineItems).values(newLineRows);

          const [updated] = await tx
            .update(invoices)
            .set({
              contactId,
              number: header.number,
              issueDate: header.issueDate,
              dueDate: header.dueDate,
              currency: header.currency ?? current.currency,
              subtotal: header.subtotal,
              tax: header.tax ?? '0',
              total: header.total,
              notes: header.notes ?? null,
              // From-block display flags — keep current values if the client
              // didn't send them (the edit form always does).
              showAddress: header.showAddress ?? current.showAddress,
              showPhone: header.showPhone ?? current.showPhone,
              showEmail: header.showEmail ?? current.showEmail,
              // Undefined leaves the job alone; explicit null detaches.
              jobId: nextJobId,
              updatedAt: new Date(),
            })
            .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'invoice_not_found' }, 404);

          await stampBilledTimeEntries(tx, accountId, id, billedTimeEntryIds);

          await c.var.audit({
            entityType: 'invoice',
            entityId: id,
            action: 'update',
            before: { ...current, lineItems: beforeLines },
            after: { ...updated, lineItems: newLineRows },
            companyId: current.companyId,
          });

          return c.json({ ...updated, lineItems: newLineRows });
        },
      )
      .post('/api/invoices/:id/mark-sent', requireCapability('sales:write'), (c) =>
        transitionInvoice(c, c.req.param('id'), 'mark-sent', INVOICE_TRANSITIONS['mark-sent']),
      )
      // mark-paid carries a JSON body recording how the money arrived. The
      // validator middleware is required so hc<AppType>() sees `json` on the
      // typed Input (per the path-param POST-with-body footgun).
      .post(
        '/api/invoices/:id/mark-paid',
        requireCapability('sales:write'),
        validator('json', (value, c) => {
          const parsed = invoiceMarkPaidSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const data = c.req.valid('json');
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          // The status flip, the audit entry and the concurrency re-assert are
          // unchanged. Only the ledger posting moves: the receipt below posts in
          // its place, so mark-paid stops being a second way to move money and
          // becomes what TMC-187 always described it as — the special case of
          // recording a payment (TMC-196).
          const result = await applyInvoiceTransition(tx, c.var.audit, {
            accountId,
            id,
            key: 'mark-paid',
            spec: INVOICE_TRANSITIONS['mark-paid'],
            patch: { paymentMethod: data.method, paymentReference: data.reference ?? null },
            // Backdated payment date drives paidAt + the ledger posting date;
            // omitted → now (the quick caret-menu path).
            effectiveAt: data.paidOn ? new Date(data.paidOn) : undefined,
            skipLedgerPosting: true,
          });
          if (!result.ok) {
            if (result.error === 'invoice_not_found') return c.json({ error: result.error }, 404);
            return c.json({ error: result.error, from: result.from, to: result.to }, 409);
          }
          const invoice = result.invoice;

          // Record what actually ARRIVED — the balance still outstanding, not
          // the invoice total. A part-paid invoice is still 'sent', so mark-paid
          // lands on one perfectly happily, and posting the whole total on top of
          // a deposit already banked books the same money twice.
          const alreadyPaidCents = await paidCentsForInvoice(tx, { accountId, invoiceId: id });
          const outstandingCents = toCents(invoice.total) - alreadyPaidCents;

          // A zero-total invoice has nothing to receive, and a zero-amount
          // receipt is refused by the payment schema for good reason. Settled by
          // the status flip alone — the same carve-out migration 0032 made when
          // it skipped total = 0.
          if (outstandingCents <= 0) {
            await emit(tx, { name: 'invoice_marked_paid' });
            return c.json(invoice);
          }

          // No date supplied (the caret-menu tap) means "today" — and today is
          // the operator's, not UTC's. Truncating `now` to a UTC date files a
          // Tokyo morning under yesterday.
          let receivedOn = data.paidOn;
          if (!receivedOn) {
            const [company] = await tx
              .select({ timezone: companies.timezone })
              .from(companies)
              .where(and(eq(companies.id, invoice.companyId), eq(companies.accountId, accountId)))
              .limit(1);
            receivedOn = localToday(company?.timezone ?? 'UTC');
          }

          const [payment] = await tx
            .insert(invoicePayments)
            .values({
              id: uuidv7(),
              accountId,
              companyId: invoice.companyId,
              invoiceId: id,
              amount: centsToMoney(outstandingCents),
              receivedOn,
              method: data.method,
              reference: data.reference ?? null,
            })
            .returning();
          if (!payment) return c.json({ error: 'invoice_not_found' }, 404);

          await postInvoicePayment(tx, {
            payment,
            invoice,
            accountId,
            companyId: invoice.companyId,
            postedAt: expenseDateToPostedAt(payment.receivedOn),
            // Never-issued invoice → a counter sale, crediting revenue rather
            // than a receivable nobody ever owed.
            credit: await receiptCreditForInvoice(tx, { accountId, invoice }),
          });

          // Re-derive the header from the rows so the two cannot disagree. It
          // rewrites the same status/paid_at/method the transition just set —
          // deliberately, because the rows are the authority now.
          const synced = await syncInvoiceSettlement(tx, {
            accountId,
            invoiceId: id,
            totalCents: toCents(invoice.total),
            // Never issued → unwinding the last receipt returns it to draft,
            // not to a 'sent' it never reached (TMC-215).
            issued: invoice.sentAt !== null,
          });
          if (!synced) return c.json({ error: 'invoice_not_found' }, 404);

          await emit(tx, { name: 'invoice_marked_paid' });
          return c.json(synced.invoice);
        },
      )
      // Take a deposit on a draft, in ONE step (TMC-199).
      //
      // The person calling this is standing in a customer's yard holding cash.
      // They know one number. Issuing the invoice so a receivable exists is the
      // system's job, and doing it here rather than making them do it first is
      // the whole point — the previous flow was three actions and an
      // explanation of our state machine.
      //
      // ATOMIC BY CONSTRUCTION. Both halves run on the request's tenant tx, so
      // a failed payment rolls the issue back with it. Two client calls could
      // not give that: a mark-sent that succeeded followed by a payment that
      // failed would leave an invoice issued that nobody meant to issue, with
      // the money still unrecorded.
      //
      // AND IT SIDESTEPS UNEARNED REVENUE. Taking money against a document that
      // was never issued would need a liability account across five entity COA
      // seeds. Issuing first means the receivable exists and the deposit
      // relieves it exactly like any other payment — ordinary double-entry, no
      // new accounts, no new concepts.
      .post(
        '/api/invoices/:id/deposit',
        requireCapability('sales:write'),
        validator('json', (value, c) => {
          const parsed = invoiceDepositSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const data = c.req.valid('json');
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const key = data.idempotencyKey;

          // The deposit this key already bought, rendered read-only: no second
          // issue, no second posting, no second audit event. Returns null if the
          // invoice has since vanished.
          const replayOf = async (prior: InvoicePayment) => {
            const [current] = await tx
              .select()
              .from(invoices)
              .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
              .limit(1);
            if (!current) return null;
            const summary = summarizeSettlement({
              totalCents: toCents(current.total),
              paidCents: await paidCentsForInvoice(tx, { accountId, invoiceId: id }),
              issued: current.sentAt !== null,
            });
            return { payment: prior, invoice: current, ...summary, replayed: true };
          };

          // ASKED BEFORE ISSUING, unlike the payments route (TMC-218).
          //
          // This endpoint welds a state transition to the insert, and the two
          // have to be refused together. Once applyInvoiceTransition has run,
          // every `return c.json(...)` COMMITS — the tenant tx rolls back only on
          // a throw — so a duplicate noticed after the issue would leave an
          // invoice issued with no deposit behind it: exactly the half-done state
          // this endpoint's atomicity exists to prevent. Refusing before the
          // first write is what keeps the refusal free.
          //
          // A PRE-CHECK, NOT THE GUARD — it cannot be one, because two concurrent
          // requests both read nothing here. The guards are the compare-and-swap
          // inside applyInvoiceTransition and the unique index at the insert.
          if (key) {
            const prior = await paymentForIdempotencyKey(tx, { accountId, idempotencyKey: key });
            if (prior && prior.invoiceId !== id) {
              return c.json({ error: 'idempotency_key_reused' }, 409);
            }
            const replayed = prior ? await replayOf(prior) : null;
            if (replayed) return c.json(replayed, 200);
          }

          // Issue it. Reuses the one path that owns status + ledger together,
          // so the AR posting lands on the ISSUE date exactly as a normal send
          // would — this is not a special kind of issuing.
          const issued = await applyInvoiceTransition(tx, c.var.audit, {
            accountId,
            id,
            key: 'mark-sent',
            spec: INVOICE_TRANSITIONS['mark-sent'],
          });
          if (!issued.ok) {
            // A double-click's second request lands here whenever the first one
            // committed in the window between the pre-check above and this
            // transition — mark-sent accepts only a draft.
            //
            // WORTH BEING PRECISE ABOUT WHAT THIS FIXES. It is not a double-post:
            // applyInvoiceTransition re-asserts the old status in its UPDATE's
            // WHERE, so the concurrent pair is compare-and-swapped and the loser
            // writes nothing. The deposit path never booked the money twice. What
            // it did was LIE — the user's deposit went through and they were told
            // 'invalid_transition', which invites the one recovery that really
            // does double-book it: re-recording the deposit through the payments
            // route, which had no state guard at all. The key turns that
            // misleading 409 into the truthful answer.
            if (key) {
              const prior = await paymentForIdempotencyKey(tx, { accountId, idempotencyKey: key });
              const replayed = prior && prior.invoiceId === id ? await replayOf(prior) : null;
              if (replayed) return c.json(replayed, 200);
            }
            if (issued.error === 'invoice_not_found') return c.json({ error: issued.error }, 404);
            return c.json({ error: issued.error, from: issued.from, to: issued.to }, 409);
          }
          const invoice = issued.invoice;

          const [company] = await tx
            .select({ timezone: companies.timezone })
            .from(companies)
            .where(and(eq(companies.id, invoice.companyId), eq(companies.accountId, accountId)))
            .limit(1);
          const receivedOn = data.receivedOn ?? localToday(company?.timezone ?? 'UTC');

          // NO onConflictDoNothing here, deliberately — the one place in this
          // change where letting the database RAISE is the correct answer.
          //
          // The issue transition has already written by the time we get here.
          // Swallowing a conflicting insert would commit an issued invoice with
          // no deposit behind it, and returning a 409 would commit the same
          // thing, because only a throw rolls the tenant tx back. Letting
          // invoice_payments_idempotency_uq raise takes both halves down
          // together, which is the only books-safe outcome available after a
          // write. Reachable only by aiming one key at two different draft
          // invoices CONCURRENTLY; the pre-check above answers the sequential
          // form of that with a clean 409 and no writes at all.
          const [payment] = await tx
            .insert(invoicePayments)
            .values({
              id: uuidv7(),
              accountId,
              companyId: invoice.companyId,
              invoiceId: id,
              amount: data.amount,
              receivedOn,
              method: data.method ?? 'cash',
              idempotencyKey: key ?? null,
            })
            .returning();
          if (!payment) return c.json({ error: 'invoice_not_found' }, 404);

          await postInvoicePayment(tx, {
            payment,
            invoice,
            accountId,
            companyId: invoice.companyId,
            postedAt: expenseDateToPostedAt(payment.receivedOn),
            credit: await receiptCreditForInvoice(tx, { accountId, invoice }),
          });

          const synced = await syncInvoiceSettlement(tx, {
            accountId,
            invoiceId: id,
            totalCents: toCents(invoice.total),
            // Never issued → unwinding the last receipt returns it to draft,
            // not to a 'sent' it never reached (TMC-215).
            issued: invoice.sentAt !== null,
          });
          if (!synced) return c.json({ error: 'invoice_not_found' }, 404);

          await c.var.audit({
            entityType: 'invoice',
            entityId: id,
            action: 'deposit-taken',
            before: { status: 'draft' },
            after: {
              status: synced.invoice.status,
              settlement: synced.summary.settlement,
              amount: payment.amount,
              receivedOn: payment.receivedOn,
            },
            companyId: invoice.companyId,
          });

          return c.json(
            { payment, invoice: synced.invoice, ...synced.summary, replayed: false },
            201,
          );
        },
      )
      // Per-invoice reminder opt-out (TMC-189). "I've spoken to them, don't
      // chase this one" — a conversation the software cannot see and must not
      // override.
      //
      // ITS OWN ROUTE, not part of the invoice PATCH, because that PATCH is
      // draft-only and reminders are only ever sent for a SENT invoice. Folding
      // it in would have produced a control that 409s on every invoice it
      // actually matters for.
      //
      // Allowed on anything but a voided invoice — including a PAID one, which
      // is not redundant: a refund reopens an invoice to 'sent' and it starts
      // being chased again, so opting a settled invoice out is a real thing to
      // want.
      .post(
        '/api/invoices/:id/reminders',
        requireCapability('sales:write'),
        validator('json', (value, c) => {
          const parsed = invoiceRemindersSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const { optedOut } = c.req.valid('json');
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [current] = await tx
            .select()
            .from(invoices)
            .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'invoice_not_found' }, 404);
          if (current.status === 'voided') {
            return c.json({ error: 'invoice_voided', status: current.status }, 409);
          }

          const [updated] = await tx
            .update(invoices)
            .set({ remindersOptedOut: optedOut, updatedAt: new Date() })
            .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'invoice_not_found' }, 404);

          // Audited like every other mutation: silencing a chase is a decision
          // someone made, and "why did this customer never get reminded" is
          // exactly the question the trail exists to answer.
          await c.var.audit({
            entityType: 'invoice',
            entityId: id,
            action: 'reminders-opt-out',
            before: { remindersOptedOut: current.remindersOptedOut },
            after: { remindersOptedOut: updated.remindersOptedOut },
            companyId: updated.companyId,
          });

          return c.json(updated);
        },
      )
      // Void refuses an invoice that is still holding the customer's money
      // (TMC-188). The sent → voided posting credits AR for the FULL total,
      // which was always correct while a 'sent' invoice could not have cash
      // against it. Partial payments broke that assumption: a half-paid invoice
      // is still 'sent', so voiding it credited AR by the whole total on top of
      // the payment's own credit — driving AR negative and stranding the
      // customer's cash against a receivable that no longer exists.
      //
      // The guard is on the NET, not on the row count, so the legitimate
      // "they paid, we refunded them in full, now cancel the invoice" flow
      // still voids cleanly: those two rows net to zero and AR is back at the
      // full total, which is exactly what the void posting reverses.
      //
      // Refusing is the right answer rather than a partial reversal: money
      // actually changed hands, and the honest sequence is to refund it (or
      // remove the receipt if it was recorded in error) and then void.
      .post('/api/invoices/:id/void', requireCapability('sales:write'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const paidCents = await paidCentsForInvoice(tx, { accountId, invoiceId: id });
        if (paidCents !== 0) {
          return c.json({ error: 'has_payments', paidCents }, 409);
        }
        return transitionInvoice(c, id, 'void', INVOICE_TRANSITIONS.void);
      })
      // Edit the recorded payment on an already-paid invoice. Method/reference
      // are plain column updates. A changed payment date is an append-only
      // ledger correction (journal tables are insert-only, migration 0026):
      // reverse the original paid posting at its old date and re-post at the
      // new one via repostInvoicePaymentDate, so the cash moves to the right
      // reporting period. Only valid while status === 'paid'.
      .post(
        '/api/invoices/:id/edit-payment',
        requireCapability('sales:write'),
        validator('json', (value, c) => {
          const parsed = invoiceMarkPaidSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const data = c.req.valid('json');
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [current] = await tx
            .select()
            .from(invoices)
            .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'invoice_not_found' }, 404);
          if (current.status !== 'paid') {
            return c.json({ error: 'not_paid', status: current.status }, 409);
          }

          const now = new Date();
          // paidAt is a timestamp; the wire value is YYYY-MM-DD — compare date
          // portions to decide whether the ledger needs a date correction.
          const oldDate = current.paidAt ? current.paidAt.toISOString().slice(0, 10) : null;
          if (data.paidOn && current.paidAt && data.paidOn !== oldDate) {
            await repostInvoicePaymentDate(tx, {
              invoice: current,
              prevStatus: current.sentAt ? 'sent' : 'draft',
              accountId,
              companyId: current.companyId,
              fromDate: current.paidAt,
              toDate: new Date(data.paidOn),
            });
          }

          const patch: Record<string, unknown> = {
            updatedAt: now,
            paymentMethod: data.method,
            paymentReference: data.reference ?? null,
          };
          if (data.paidOn) patch.paidAt = new Date(data.paidOn);

          const [updated] = await tx
            .update(invoices)
            .set(patch)
            .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'invoice_not_found' }, 404);

          await c.var.audit({
            entityType: 'invoice',
            entityId: id,
            action: 'edit-payment',
            before: {
              paidAt: current.paidAt,
              paymentMethod: current.paymentMethod,
              paymentReference: current.paymentReference,
            },
            after: {
              paidAt: updated.paidAt,
              paymentMethod: updated.paymentMethod,
              paymentReference: updated.paymentReference,
            },
            companyId: updated.companyId,
          });

          return c.json(updated);
        },
      )
      // Send the invoice via email. Distinct from /mark-sent (pure status
      // transition, no I/O) because this endpoint adds a real side-effect
      // and an optional recipient override. State machine: draft → sent +
      // email; sent → email only (resend, public_token already idempotent
      // from 8.5a); paid/voided → 409. Email I/O runs after the status
      // transition + status audit row but BEFORE the email-sent audit row;
      // mailer failure surfaces as a 502 and the tx still commits the flip
      // (a Resend 5xx must not silently roll back a successful mark-sent
      // and leave the audit trail lying about what happened — the user
      // retries the send from the UI).
      .post(
        '/api/invoices/:id/send',
        requireCapability('sales:write'),
        requireEntitlement(deps, 'documents:write'),
        rateLimit(deps, RATE_LIMITS.email, (c) => c.get('accountId') as string | undefined),
        // validator middleware needed for the same reason PATCH endpoints
        // use it (slice 8.4f): path-param routes type Input as `{ param }`
        // and TS rejects `{ param, json }` from hc<AppType>() without the
        // validator lifting the body into the typed Input. Body is fully
        // optional (no override → defaults to customer.email server-side)
        // so empty `{}` is valid.
        validator('json', (value, c) => {
          const parsed = invoiceSendSchema.safeParse(value ?? {});
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          if (!deps.mailer) return c.json({ error: 'email_not_configured' }, 500);
          // Whether this send will actually reach anyone. In practice deps.mailer
          // is never null — bootstrap always wires the console driver — so the
          // guard above is unreachable on a real deploy and THIS is the question
          // that matters (TMC-212).
          const delivered = mailerDelivers(deps.mailer);

          const { to: toOverrideRaw } = c.req.valid('json');
          const toOverride = toOverrideRaw?.trim() || null;

          const accountId = c.get('accountId');

          // tx1: reads + the first-send transition (status/token/audit), then
          // release the connection before the Resend call below (deferred-tx
          // route, see rls-context). The guard branches build their c.json error
          // here and are returned via the `instanceof Response` check after.
          const prep = await c.var.runInTx(async (tx, audit) => {
            const [current] = await tx
              .select()
              .from(invoices)
              .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
              .limit(1);
            if (!current) return c.json({ error: 'invoice_not_found' }, 404);
            if (current.status === 'paid' || current.status === 'voided') {
              return c.json({ error: 'invalid_transition', from: current.status, to: 'sent' }, 409);
            }

            const [customer] = await tx
              .select({ id: contacts.id, name: contacts.name, email: contacts.email })
              .from(contacts)
              .where(and(eq(contacts.id, current.contactId), eq(contacts.accountId, accountId)))
              .limit(1);
            if (!customer) return c.json({ error: 'contact_not_found' }, 404);

            const to = (toOverride ?? customer.email ?? '').trim();
            if (!to || !EMAIL_RE.test(to)) return c.json({ error: 'invalid_recipient' }, 400);

            const [company] = await tx
              .select({ name: companies.name, replyToEmail: companies.replyToEmail })
              .from(companies)
              .where(and(eq(companies.id, current.companyId), eq(companies.accountId, accountId)))
              .limit(1);

            // First-send transition: draft → sent, stamps sent_at, mints the
            // public token if missing, and posts to the ledger. A resend
            // (already 'sent') leaves all of that untouched.
            //
            // Goes through applyInvoiceTransition rather than its own UPDATE.
            // The inline version that used to live here is why emailing an
            // invoice never reached the books: it predated ledger posting by
            // five days and was never revisited.
            let invoice = current;
            if (current.status === 'draft') {
              const result = await applyInvoiceTransition(tx, audit, {
                accountId,
                id,
                key: 'mark-sent',
                spec: INVOICE_TRANSITIONS['mark-sent'],
              });
              if (!result.ok) {
                if (result.error === 'invoice_not_found') {
                  return c.json({ error: result.error }, 404);
                }
                return c.json({ error: result.error, from: result.from, to: result.to }, 409);
              }
              invoice = result.invoice;
            }

            if (!invoice.publicToken) {
              return c.json({ error: 'invoice_state_invalid' }, 500);
            }

            const companyName = company?.name ?? 'Thalermark';
            const template = await resolveEmailTemplate(
              tx,
              accountId,
              invoice.companyId,
              'invoice',
            );
            return {
              invoice: { ...invoice, publicToken: invoice.publicToken },
              customerName: customer.name,
              companyName,
              replyToEmail: company?.replyToEmail ?? null,
              template,
              to,
              wasDraft: current.status === 'draft',
            };
          });
          // A guard branch returned a built error response — pass it through.
          if (prep instanceof Response) return prep;
          const { invoice, customerName, companyName, replyToEmail, template, to, wasDraft } = prep;

          // Email send — no DB connection held. Shared builder (lib/invoice-
          // email.ts) so this route and the recurring-invoice sweeper emit
          // identical email. NOTE: tx1 already committed the draft → sent
          // transition, so unlike the old single-tx version an email failure now
          // leaves the invoice 'sent' (not rolled back to draft). That's
          // recoverable — a retry is an idempotent resend — and consistent with
          // the mark-sent-without-email ("share a link") path.
          let subject: string;
          try {
            ({ subject } = await sendInvoiceEmail(deps.mailer, to, {
              invoice,
              customerName,
              companyName,
              publicAppUrl: deps.publicAppUrl,
              emailFrom: deps.emailFrom,
              replyToEmail,
              template,
            }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: 'email_failed', detail: message }, 502);
          }

          // tx2: record the delivery (audit + first-send telemetry). Only the
          // first delivery counts — a resend (status was already 'sent') doesn't
          // re-emit, so each invoice yields one invoice_sent tagged with the
          // method that first delivered it (TELEMETRY.md).
          await c.var.runInTx(async (tx, audit) => {
            await audit({
              entityType: 'invoice',
              entityId: id,
              // Recorded on the row as well as shown in the banner (TMC-212).
              // The audit trail is permanent, so a console-mailer install was
              // writing a false "emailed" record that outlived the toast.
              action: 'email-sent',
              after: { to, subject, delivered },
              companyId: invoice.companyId,
            });
            if (wasDraft) {
              await emit(tx, { name: 'invoice_sent', delivery_method: 'email' });
            }
          });

          // `delivered: false` means the invoice IS issued — the status flip and
          // the ledger posting both happened — but nothing reached the customer.
          // The two facts are separate and the UI has to be able to tell them
          // apart, which it could not when the payload only carried `sentTo`.
          return c.json({ ...invoice, sentTo: to, delivered });
        },
      )
      // --- Payments (TMC-187) ------------------------------------------------
      // A receipt against an issued invoice. This is the deposit path: a
      // landscaper takes 50% down, records it here, and the invoice reads
      // half-paid instead of having to be lied about in one direction or the
      // other.
      //
      // mark-paid above is now the special case of this — a payment for the
      // whole outstanding balance — rather than the only way money can arrive.
      // It is left exactly as it was so the quick path and every existing
      // caller are untouched.
      // Unguarded like every other read in this file — the capability model
      // gates writes, and any member who can see an invoice can see what has
      // been paid against it.
      .get('/api/invoices/:id/payments', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [invoice] = await tx
          .select({ id: invoices.id, total: invoices.total, sentAt: invoices.sentAt })
          .from(invoices)
          .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
          .limit(1);
        if (!invoice) return c.json({ error: 'invoice_not_found' }, 404);

        const payments = await tx
          .select()
          .from(invoicePayments)
          .where(and(eq(invoicePayments.accountId, accountId), eq(invoicePayments.invoiceId, id)))
          .orderBy(asc(invoicePayments.receivedOn), asc(invoicePayments.id));

        const paidCents = payments.reduce((sum, p) => sum + toCents(p.amount), 0);
        return c.json({
          payments,
          ...summarizeSettlement({
            totalCents: toCents(invoice.total),
            paidCents,
            issued: invoice.sentAt !== null,
          }),
        });
      })
      .post(
        '/api/invoices/:id/payments',
        requireCapability('sales:write'),
        validator('json', (value, c) => {
          const parsed = invoicePaymentCreateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const data = c.req.valid('json');
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [invoice] = await tx
            .select()
            .from(invoices)
            .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
            .limit(1);
          if (!invoice) return c.json({ error: 'invoice_not_found' }, 404);

          const existingPaymentCount = await paymentCountForInvoice(tx, {
            accountId,
            invoiceId: id,
          });
          const eligible = checkPaymentEligibility({
            status: invoice.status,
            existingPaymentCount,
          });
          if (!eligible.ok) {
            return c.json({ error: eligible.reason, status: invoice.status }, 409);
          }

          // Double-click protection (TMC-218). The button showed no pending
          // state, so a slow request read as a dead click and invited a second
          // one — and two identical receipts is a silent books error: an invoice
          // reporting itself overpaid with the cash on the books twice.
          //
          // THE UNIQUE INDEX IS THE GUARD, NOT A SELECT. A "has this key been
          // used?" read taken before the insert has no lock behind it — two
          // concurrent requests both read nothing and both insert.
          // invoice_payments_idempotency_uq is the only check that holds, and it
          // holds because the second inserter BLOCKS on the first one's
          // uncommitted row and then sees DO NOTHING once that commits. Same
          // shape the Stripe webhook has used since TMC-187.
          //
          // WHY THE CONFLICT TARGET IS SPELLED OUT rather than a bare
          // .onConflictDoNothing(). Bare means "swallow ANY unique violation",
          // which on this table would also swallow a primary-key collision and
          // drop a real payment on the floor. Naming the arbiter means only the
          // key dedupes and everything else still raises. The `where` is not
          // decoration: Postgres refuses to infer a PARTIAL unique index unless
          // the predicate matches the one in migration 0036.
          //
          // NOTHING BELOW THE REPLAY BRANCH RUNS A SECOND TIME. That is the
          // whole point. The damage was never the duplicate row on its own, it
          // was the second ledger posting behind it — deduplicating the row
          // while still calling postInvoicePayment would leave the books MORE
          // wrong than the original bug, because the receipt list would then
          // look correct while AR and Cash quietly disagreed with it.
          const key = data.idempotencyKey;
          const paymentId = uuidv7();
          const values = {
            id: paymentId,
            accountId,
            companyId: invoice.companyId,
            invoiceId: id,
            amount: data.amount,
            receivedOn: data.receivedOn,
            method: data.method,
            reference: data.reference ?? null,
            idempotencyKey: key ?? null,
          };
          const [payment] = key
            ? await tx
                .insert(invoicePayments)
                .values(values)
                .onConflictDoNothing({
                  target: [invoicePayments.accountId, invoicePayments.idempotencyKey],
                  where: sql`${invoicePayments.idempotencyKey} is not null`,
                })
                .returning()
            : await tx.insert(invoicePayments).values(values).returning();

          if (!payment) {
            // An unkeyed insert carries no ON CONFLICT clause, so an empty
            // return there is the invoice vanishing underneath us — the
            // pre-existing meaning of this branch, unchanged.
            if (!key) return c.json({ error: 'invoice_not_found' }, 404);

            const existing = await paymentForIdempotencyKey(tx, {
              accountId,
              idempotencyKey: key,
            });
            if (!existing) return c.json({ error: 'invoice_not_found' }, 404);

            // The index is account-wide, not per invoice, so a client that
            // reuses one key across two invoices lands here. Handing back the
            // OTHER invoice's receipt would tell the caller their payment was
            // recorded when nothing was written — the one outcome worse than an
            // error, because it is an error that looks like success.
            if (existing.invoiceId !== id) {
              return c.json({ error: 'idempotency_key_reused' }, 409);
            }

            // Recomputed read-only. syncInvoiceSettlement returns the same
            // numbers but it WRITES — the header mirror plus a search reindex —
            // and a replay must leave no trace: no row, no posting, no audit
            // event, no telemetry. `invoice` was read at the top of this handler,
            // which is after the original request committed, so it already
            // carries the status that request produced.
            const summary = summarizeSettlement({
              totalCents: toCents(invoice.total),
              paidCents: await paidCentsForInvoice(tx, { accountId, invoiceId: id }),
              issued: invoice.sentAt !== null,
            });
            // 200, not 201. 201 is a claim that THIS request created something,
            // and on a replay nothing was created; repeating it would erase the
            // only signal that a duplicate submission happened. Still 2xx, so
            // every caller's success branch runs unchanged and renders exactly
            // the settled invoice the first attempt would have — which is the
            // contract that makes a retry safe. `replayed` is on both responses
            // so a caller can tell them apart without reading the status line.
            return c.json({ payment: existing, invoice, ...summary, replayed: true }, 200);
          }

          // Posts inside the tenant tx like every other mutation, so the
          // deferred sum-to-zero trigger fires at commit and a rejected posting
          // (closed period, retired company) rolls the row back with it.
          await postInvoicePayment(tx, {
            payment,
            invoice,
            accountId,
            companyId: invoice.companyId,
            postedAt: expenseDateToPostedAt(payment.receivedOn),
            // Reached only for an issued invoice today (the eligibility guard
            // above refuses a draft), so this resolves to the receivable shape.
            // Asked rather than assumed so the two receipt paths stay identical.
            credit: await receiptCreditForInvoice(tx, { accountId, invoice }),
          });

          const synced = await syncInvoiceSettlement(tx, {
            accountId,
            invoiceId: id,
            totalCents: toCents(invoice.total),
            // Never issued → unwinding the last receipt returns it to draft,
            // not to a 'sent' it never reached (TMC-215).
            issued: invoice.sentAt !== null,
          });
          if (!synced) return c.json({ error: 'invoice_not_found' }, 404);

          await c.var.audit({
            entityType: 'invoice',
            entityId: id,
            action: 'payment-recorded',
            before: { status: invoice.status },
            after: {
              status: synced.invoice.status,
              settlement: synced.summary.settlement,
              paymentId,
              amount: payment.amount,
              receivedOn: payment.receivedOn,
              method: payment.method,
            },
            companyId: invoice.companyId,
          });

          if (synced.summary.status === 'paid') {
            await emit(tx, { name: 'invoice_marked_paid' });
          }

          return c.json(
            { payment, invoice: synced.invoice, ...synced.summary, replayed: false },
            201,
          );
        },
      )
      // Removing a receipt is an append-only ledger correction, not a deletion
      // of history: the reversal posts at the date the payment was ORIGINALLY
      // booked, so the period it belonged to nets to zero rather than the cash
      // jumping into the current month. Same discipline as
      // repostInvoicePaymentDate above.
      .delete(
        '/api/invoices/:id/payments/:paymentId',
        requireCapability('sales:write'),
        async (c) => {
          const id = c.req.param('id');
          const paymentId = c.req.param('paymentId');
          if (!UUID_RE.test(id) || !UUID_RE.test(paymentId)) {
            return c.json({ error: 'invalid_id' }, 400);
          }
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [invoice] = await tx
            .select()
            .from(invoices)
            .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
            .limit(1);
          if (!invoice) return c.json({ error: 'invoice_not_found' }, 404);

          const [payment] = await tx
            .select()
            .from(invoicePayments)
            .where(
              and(
                eq(invoicePayments.id, paymentId),
                eq(invoicePayments.accountId, accountId),
                eq(invoicePayments.invoiceId, id),
              ),
            )
            .limit(1);
          if (!payment) return c.json({ error: 'payment_not_found' }, 404);

          await postInvoicePaymentReversal(tx, {
            payment,
            invoice,
            accountId,
            // Must resolve to the SAME shape the original receipt used, or the
            // reversal cancels a different set of accounts than it posted and
            // the invoice's source group stops netting to zero. Safe because the
            // discriminator (sentAt) only ever goes null → set, and a receipt
            // recorded before the invoice was issued is a cash sale forever.
            credit: await receiptCreditForInvoice(tx, { accountId, invoice }),
            companyId: invoice.companyId,
            postedAt: expenseDateToPostedAt(payment.receivedOn),
          });

          await tx
            .delete(invoicePayments)
            .where(
              and(eq(invoicePayments.id, paymentId), eq(invoicePayments.accountId, accountId)),
            );

          const synced = await syncInvoiceSettlement(tx, {
            accountId,
            invoiceId: id,
            totalCents: toCents(invoice.total),
            // Never issued → unwinding the last receipt returns it to draft,
            // not to a 'sent' it never reached (TMC-215).
            issued: invoice.sentAt !== null,
          });
          if (!synced) return c.json({ error: 'invoice_not_found' }, 404);

          await c.var.audit({
            entityType: 'invoice',
            entityId: id,
            action: 'payment-removed',
            before: {
              status: invoice.status,
              paymentId,
              amount: payment.amount,
              receivedOn: payment.receivedOn,
              method: payment.method,
            },
            after: { status: synced.invoice.status, settlement: synced.summary.settlement },
            companyId: invoice.companyId,
          });

          return c.json({ invoice: synced.invoice, ...synced.summary });
        },
      )
  );
}

export type InvoicesAppType = ReturnType<typeof invoicesRoutes>;
