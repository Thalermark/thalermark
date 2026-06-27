import { randomBytes } from 'node:crypto';
import { companies, contacts, invoiceLineItems, invoices } from '@thalermark/db';
import { emit } from '@thalermark/telemetry';
import {
  invoiceCreateSchema,
  invoiceMarkPaidSchema,
  invoiceSendSchema,
  invoiceUpdateSchema,
} from '@thalermark/validation';
import { and, asc, desc, eq, getTableColumns, gte, ilike, lte, or } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import type { AppDeps } from '../app.js';
import { resolveEmailTemplate } from '../lib/email-templates.js';
import { sendInvoiceEmail } from '../lib/invoice-email.js';
import { suggestNextInvoiceNumber } from '../lib/invoice-number.js';
import { postInvoiceTransition, repostInvoicePaymentDate } from '../lib/ledger.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import { EMAIL_RE, UUID_RE, escapeLike, isValidDateParam } from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
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

async function transitionInvoice(
  c: Context<{ Variables: RlsVariables }>,
  id: string,
  key: TransitionKey,
  spec: TransitionSpec,
  // Per-transition extras (mark-paid only, today): `patch` adds columns merged
  // after the base patch (payment method/reference); `effectiveAt` overrides the
  // economic date used for BOTH the status stamp (e.g. paidAt) and the ledger
  // posting date, so a backdated payment lands in the right reporting period.
  // Defaults to now when omitted.
  opts?: { patch?: Record<string, unknown>; effectiveAt?: Date },
) {
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
  const tx = c.get('tx');
  const accountId = c.get('accountId');

  const [current] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
    .limit(1);
  if (!current) return c.json({ error: 'invoice_not_found' }, 404);

  if (!(spec.from as readonly string[]).includes(current.status)) {
    return c.json({ error: 'invalid_transition', from: current.status, to: spec.to }, 409);
  }

  const now = new Date();
  // updatedAt is always record-time; the stamp (paidAt/sentAt/voidedAt) uses the
  // economic date, which a caller can backdate via opts.effectiveAt.
  const effectiveAt = opts?.effectiveAt ?? now;
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
  if (opts?.patch) Object.assign(patch, opts.patch);
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
    return c.json({ error: 'invalid_transition', from: current.status, to: spec.to }, 409);
  }

  await c.var.audit({
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
  await postInvoiceTransition(tx, {
    invoice: updated,
    prevStatus: current.status as InvoiceStatus,
    nextStatus: updated.status as InvoiceStatus,
    accountId,
    companyId: updated.companyId,
    postedAt: effectiveAt,
  });

  // Telemetry (opt-in; no-op unless the account enabled it). mark-sent here is
  // the "share a link" delivery; the /send route emits invoice_sent{email}
  // separately for the email path. void emits nothing (TELEMETRY.md).
  if (key === 'mark-sent') {
    await emit(tx, { name: 'invoice_sent', delivery_method: 'link' });
  } else if (key === 'mark-paid') {
    await emit(tx, { name: 'invoice_marked_paid' });
  }

  return c.json(updated);
}

export function invoicesRoutes(deps: AppDeps) {
  return (
    new Hono<{ Variables: RlsVariables }>()
      .post('/api/invoices', requireCapability('sales:write'), async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = invoiceCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const { companyId, contactId, lineItems, ...header } = parsed.data;

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

        return c.json({ id: invoiceId, ...parsed.data, ...showFlags }, 201);
      })
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
        return c.json({ ...invoice, lineItems: lines });
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
              updatedAt: new Date(),
            })
            .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'invoice_not_found' }, 404);

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
        (c) => {
          const data = c.req.valid('json');
          return transitionInvoice(
            c,
            c.req.param('id'),
            'mark-paid',
            INVOICE_TRANSITIONS['mark-paid'],
            {
              patch: { paymentMethod: data.method, paymentReference: data.reference ?? null },
              // Backdated payment date drives paidAt + the ledger posting date;
              // omitted → now (the quick caret-menu path).
              effectiveAt: data.paidOn ? new Date(data.paidOn) : undefined,
            },
          );
        },
      )
      .post('/api/invoices/:id/void', requireCapability('sales:write'), (c) =>
        transitionInvoice(c, c.req.param('id'), 'void', INVOICE_TRANSITIONS.void),
      )
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

          const { to: toOverrideRaw } = c.req.valid('json');
          const toOverride = toOverrideRaw?.trim() || null;

          const tx = c.get('tx');
          const accountId = c.get('accountId');

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
          // public token if missing (same idempotent pattern as mark-sent).
          // Resend leaves status / sent_at / public_token untouched.
          let invoice = current;
          if (current.status === 'draft') {
            const now = new Date();
            const [updated] = await tx
              .update(invoices)
              .set({
                status: 'sent',
                sentAt: now,
                updatedAt: now,
                publicToken: current.publicToken ?? randomBytes(32).toString('hex'),
              })
              .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
              .returning();
            if (!updated) return c.json({ error: 'invoice_not_found' }, 404);
            invoice = updated;

            await c.var.audit({
              entityType: 'invoice',
              entityId: id,
              action: 'mark-sent',
              before: {
                status: current.status,
                sentAt: current.sentAt,
                paidAt: current.paidAt,
                voidedAt: current.voidedAt,
                publicToken: current.publicToken,
              },
              after: {
                status: updated.status,
                sentAt: updated.sentAt,
                paidAt: updated.paidAt,
                voidedAt: updated.voidedAt,
                publicToken: updated.publicToken,
              },
              companyId: updated.companyId,
            });
          }

          if (!invoice.publicToken) {
            return c.json({ error: 'invoice_state_invalid' }, 500);
          }

          const companyName = company?.name ?? 'Thalermark';
          const template = await resolveEmailTemplate(
            c.get('tx'),
            c.get('accountId'),
            invoice.companyId,
            'invoice',
          );
          // Shared builder (lib/invoice-email.ts) so this route and the
          // recurring-invoice sweeper emit identical email. publicToken is
          // guaranteed set by the guard above.
          let subject: string;
          try {
            ({ subject } = await sendInvoiceEmail(deps.mailer, to, {
              invoice: { ...invoice, publicToken: invoice.publicToken },
              customerName: customer.name,
              companyName,
              publicAppUrl: deps.publicAppUrl,
              emailFrom: deps.emailFrom,
              replyToEmail: company?.replyToEmail ?? null,
              template,
            }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: 'email_failed', detail: message }, 502);
          }

          await c.var.audit({
            entityType: 'invoice',
            entityId: id,
            action: 'email-sent',
            after: { to, subject },
            companyId: invoice.companyId,
          });

          // Telemetry (opt-in; no-op unless the account enabled it). Only the
          // first delivery counts — a resend (status was already 'sent') doesn't
          // re-emit, so each invoice yields one invoice_sent tagged with the
          // method that first delivered it (TELEMETRY.md).
          if (current.status === 'draft') {
            await emit(tx, { name: 'invoice_sent', delivery_method: 'email' });
          }

          return c.json({ ...invoice, sentTo: to });
        },
      )
  );
}

export type InvoicesAppType = ReturnType<typeof invoicesRoutes>;
