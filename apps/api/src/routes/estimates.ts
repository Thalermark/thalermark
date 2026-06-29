import { randomBytes } from 'node:crypto';
import {
  companies,
  contacts,
  estimateLineItems,
  estimates,
  invoiceLineItems,
  invoices,
} from '@thalermark/db';
import { emit } from '@thalermark/telemetry';
import {
  estimateCreateSchema,
  estimateSendSchema,
  estimateUpdateSchema,
} from '@thalermark/validation';
import { and, asc, desc, eq, getTableColumns, gte, ilike, lte, or } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import type { AppDeps } from '../app.js';
import { resolveEmailTemplate } from '../lib/email-templates.js';
import { sendEstimateEmail } from '../lib/estimate-email.js';
import { suggestNextEstimateNumber, suggestNextInvoiceNumber } from '../lib/invoice-number.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import { EMAIL_RE, UUID_RE, escapeLike, isValidDateParam } from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// estimates — quotes: CRUD + duplicate, next-number, draft-only PATCH, the
// status transitions (mark-sent / accepted / declined), convert-to-invoice,
// and the email send. A deps-taking sub-app (the /send route closes over
// deps.mailer / deps.emailFrom). The estimate status state machine is
// transitionEstimate below; the public accept/decline handler stays in
// app.ts (it's used by the public routes). Mounted on createApp via
// .route() so its schema rides on its own EstimatesAppType instead of
// bloating AppType past the TS7056 ceiling.
// Estimate status state machine. Allowed transitions:
//   draft → sent      (mark-sent — mints public_token, same pattern as invoice)
//   draft → accepted  (mark-accepted — operator captured a verbal close)
//   sent  → accepted  (mark-accepted — customer agreed; public-page route in 8.7e)
//   draft → declined  (mark-declined — operator captured a verbal decline)
//   sent  → declined  (mark-declined — customer said no; public-page in 8.7e)
// `accepted` and `declined` are operationally terminal in MVP (convert-to-
// invoice is a separate link action, not a status change). `expired` flips
// advisory-at-read off expires_on; no transition endpoint until pg-boss
// lands a background sweep.
type EstimateStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';
type EstimateTransitionKey = 'mark-sent' | 'mark-accepted' | 'mark-declined';
type EstimateTransitionSpec = {
  from: readonly EstimateStatus[];
  to: EstimateStatus;
  stamp: 'sentAt' | 'acceptedAt' | 'declinedAt';
};
const ESTIMATE_TRANSITIONS: Record<EstimateTransitionKey, EstimateTransitionSpec> = {
  'mark-sent': { from: ['draft'], to: 'sent', stamp: 'sentAt' },
  'mark-accepted': { from: ['draft', 'sent'], to: 'accepted', stamp: 'acceptedAt' },
  'mark-declined': { from: ['draft', 'sent'], to: 'declined', stamp: 'declinedAt' },
};

async function transitionEstimate(
  c: Context<{ Variables: RlsVariables }>,
  id: string,
  key: EstimateTransitionKey,
  spec: EstimateTransitionSpec,
) {
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
  const tx = c.get('tx');
  const accountId = c.get('accountId');

  const [current] = await tx
    .select()
    .from(estimates)
    .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
    .limit(1);
  if (!current) return c.json({ error: 'estimate_not_found' }, 404);

  if (!(spec.from as readonly string[]).includes(current.status)) {
    return c.json({ error: 'invalid_transition', from: current.status, to: spec.to }, 409);
  }

  const now = new Date();
  const patch: Record<string, unknown> = {
    status: spec.to,
    updatedAt: now,
    [spec.stamp]: now,
  };
  // mark-sent mints the public-view token (same 32-byte pattern as the
  // invoice public token); idempotent for a future resend.
  if (key === 'mark-sent' && !current.publicToken) {
    patch.publicToken = randomBytes(32).toString('hex');
  }
  const [updated] = await tx
    .update(estimates)
    .set(patch)
    .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
    .returning();
  if (!updated) return c.json({ error: 'estimate_not_found' }, 404);

  await c.var.audit({
    entityType: 'estimate',
    entityId: id,
    action: key,
    before: {
      status: current.status,
      sentAt: current.sentAt,
      acceptedAt: current.acceptedAt,
      declinedAt: current.declinedAt,
      publicToken: current.publicToken,
    },
    after: {
      status: updated.status,
      sentAt: updated.sentAt,
      acceptedAt: updated.acceptedAt,
      declinedAt: updated.declinedAt,
      publicToken: updated.publicToken,
    },
    companyId: updated.companyId,
  });

  return c.json(updated);
}

export function estimatesRoutes(deps: AppDeps) {
  return (
    new Hono<{ Variables: RlsVariables }>()
      // Estimates — same shape as invoices minus dueDate and minus the pay
      // path. Mirrors invoices.* closely (status state machine, audit rows,
      // customer↔company invariant, (company_id, number) uniqueness pre-
      // check, draft-only PATCH). Public route + email send + accept/decline
      // land in slice 8.7e; convert-to-invoice in 8.7d.
      .post('/api/estimates', requireCapability('sales:write'), async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = estimateCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const { companyId, contactId, lineItems, ...header } = parsed.data;

        const [customer] = await tx
          .select({ id: contacts.id, companyId: contacts.companyId })
          .from(contacts)
          .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
          .limit(1);
        if (!customer) return c.json({ error: 'contact_not_found' }, 404);
        if (customer.companyId !== companyId) {
          return c.json({ error: 'customer_company_mismatch' }, 400);
        }

        // (company_id, number) pre-check — same reasoning as invoice POST: a
        // constraint throw would poison the tenant tx and roll back the
        // audit row alongside the business write.
        const [taken] = await tx
          .select({ id: estimates.id })
          .from(estimates)
          .where(
            and(
              eq(estimates.accountId, accountId),
              eq(estimates.companyId, companyId),
              eq(estimates.number, header.number),
            ),
          )
          .limit(1);
        if (taken) return c.json({ error: 'estimate_number_taken' }, 409);

        // Seed the per-estimate from-block "show" flags from the company's
        // estimate-side defaults when the client didn't send them. The form
        // sends explicit values, which win via the ?? below.
        const [companyDefaults] = await tx
          .select({
            showAddressOnEstimate: companies.showAddressOnEstimate,
            showPhoneOnEstimate: companies.showPhoneOnEstimate,
            showEmailOnEstimate: companies.showEmailOnEstimate,
          })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!companyDefaults) return c.json({ error: 'company_not_found' }, 404);
        const showFlags = {
          showAddress: header.showAddress ?? companyDefaults.showAddressOnEstimate,
          showPhone: header.showPhone ?? companyDefaults.showPhoneOnEstimate,
          showEmail: header.showEmail ?? companyDefaults.showEmailOnEstimate,
        };

        const estimateId = uuidv7();
        await tx.insert(estimates).values({
          id: estimateId,
          accountId,
          companyId,
          contactId,
          ...header,
          ...showFlags,
        });
        const lineRows = lineItems.map((li) => ({
          id: uuidv7(),
          accountId,
          estimateId,
          ...li,
        }));
        await tx.insert(estimateLineItems).values(lineRows);

        await c.var.audit({
          entityType: 'estimate',
          entityId: estimateId,
          action: 'create',
          after: { id: estimateId, ...parsed.data, ...showFlags },
          companyId,
        });

        // Telemetry (opt-in; no-op unless the account enabled it).
        await emit(tx, { name: 'estimate_created' });

        return c.json({ id: estimateId, ...parsed.data, ...showFlags }, 201);
      })
      // Duplicate-as-template (mirrors the invoice route): clone any estimate
      // into a fresh draft. Copies customer + line items + amounts/notes; new
      // number, today issue date + Net-30 expiry; status, send/accept/decline
      // stamps, public token, and the converted-invoice link are all reset
      // (clean draft). Repeatable — no idempotency link.
      .post('/api/estimates/:id/duplicate', requireCapability('sales:write'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [source] = await tx
          .select()
          .from(estimates)
          .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
          .limit(1);
        if (!source) return c.json({ error: 'estimate_not_found' }, 404);

        const sourceLines = await tx
          .select()
          .from(estimateLineItems)
          .where(
            and(eq(estimateLineItems.estimateId, id), eq(estimateLineItems.accountId, accountId)),
          )
          .orderBy(asc(estimateLineItems.position));

        const today = new Date();
        const todayIso = today.toISOString().slice(0, 10);
        const expiresIso = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);

        const [latest] = await tx
          .select({ number: estimates.number })
          .from(estimates)
          .where(and(eq(estimates.accountId, accountId), eq(estimates.companyId, source.companyId)))
          .orderBy(desc(estimates.createdAt))
          .limit(1);
        const number = suggestNextEstimateNumber(latest?.number);

        const [taken] = await tx
          .select({ id: estimates.id })
          .from(estimates)
          .where(
            and(
              eq(estimates.accountId, accountId),
              eq(estimates.companyId, source.companyId),
              eq(estimates.number, number),
            ),
          )
          .limit(1);
        if (taken) return c.json({ error: 'estimate_number_collision', number }, 409);

        const estimateId = uuidv7();
        await tx.insert(estimates).values({
          id: estimateId,
          accountId,
          companyId: source.companyId,
          contactId: source.contactId,
          number,
          issueDate: todayIso,
          expiresOn: expiresIso,
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
          await tx.insert(estimateLineItems).values(
            sourceLines.map((li) => ({
              id: uuidv7(),
              accountId,
              estimateId,
              position: li.position,
              description: li.description,
              quantity: li.quantity,
              unitPrice: li.unitPrice,
              amount: li.amount,
              // Carry the product/service type forward (duplicate = same terms).
              type: li.type,
              // Carry the line's tax snapshot forward (duplicate = same terms).
              taxable: li.taxable,
              taxRatePct: li.taxRatePct,
              taxAmount: li.taxAmount,
              taxPolicyId: li.taxPolicyId,
              // Carry the catalog breadcrumb forward (duplicated line = same
              // product) so the top-products report still counts it.
              sourceItemId: li.sourceItemId,
            })),
          );
        }

        await c.var.audit({
          entityType: 'estimate',
          entityId: estimateId,
          action: 'create',
          after: {
            id: estimateId,
            companyId: source.companyId,
            contactId: source.contactId,
            number,
            issueDate: todayIso,
            expiresOn: expiresIso,
            currency: source.currency,
            subtotal: source.subtotal,
            tax: source.tax,
            total: source.total,
            notes: source.notes,
            duplicatedFromEstimateId: id,
          },
          companyId: source.companyId,
        });

        return c.json({ id: estimateId }, 201);
      })
      .get('/api/estimates', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const status = c.req.query('status');
        // Filters mirror the invoice list: q (number OR customer name),
        // from/to (issueDate, inclusive), contactId.
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
          { col: estimates.createdAt, revive: (v: unknown) => new Date(v as string) },
          { col: estimates.id },
        ];
        const keyset = applyCursor(c.req.query('cursor'), keys, 'desc');
        if (keyset === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);
        const conditions = [eq(estimates.accountId, accountId)];
        if (companyId) conditions.push(eq(estimates.companyId, companyId));
        if (status) conditions.push(eq(estimates.status, status));
        if (contactId) conditions.push(eq(estimates.contactId, contactId));
        if (from) conditions.push(gte(estimates.issueDate, from));
        if (to) conditions.push(lte(estimates.issueDate, to));
        if (q) {
          const term = `%${escapeLike(q)}%`;
          // biome-ignore lint/style/noNonNullAssertion: or() with >=1 arg is non-null
          conditions.push(or(ilike(estimates.number, term), ilike(contacts.name, term))!);
        }
        if (keyset) conditions.push(keyset);
        // LEFT JOIN the customer name (see /api/invoices for the rationale).
        const rows = await tx
          .select({ ...getTableColumns(estimates), customerName: contacts.name })
          .from(estimates)
          .leftJoin(contacts, eq(contacts.id, estimates.contactId))
          .where(and(...conditions))
          .orderBy(keysetOrderBy(keys, 'desc'))
          .limit(limit + 1);
        const page = slicePage(rows, limit, (r) => [r.createdAt, r.id]);
        return c.json({ estimates: page.rows, nextCursor: page.nextCursor });
      })
      .get('/api/estimates/next-number', async (c) => {
        // Declared before /api/estimates/:id — Hono is first-match, same as
        // the invoice next-number route. Without this ordering 'next-number'
        // would land in the :id handler and 400 on the UUID regex.
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
          .select({ number: estimates.number })
          .from(estimates)
          .where(and(eq(estimates.accountId, accountId), eq(estimates.companyId, companyId)))
          .orderBy(desc(estimates.createdAt))
          .limit(1);

        return c.json({ suggestion: suggestNextEstimateNumber(latest?.number) });
      })
      .get('/api/estimates/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [estimate] = await tx
          .select()
          .from(estimates)
          .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)));
        if (!estimate) return c.json({ error: 'estimate_not_found' }, 404);
        const lines = await tx
          .select()
          .from(estimateLineItems)
          .where(
            and(eq(estimateLineItems.estimateId, id), eq(estimateLineItems.accountId, accountId)),
          )
          .orderBy(asc(estimateLineItems.position));
        return c.json({ ...estimate, lineItems: lines });
      })
      .patch(
        '/api/estimates/:id',
        requireCapability('sales:write'),
        validator('json', (value, c) => {
          const parsed = estimateUpdateSchema.safeParse(value);
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
            .from(estimates)
            .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'estimate_not_found' }, 404);

          // Draft-only edits, mirroring invoices. Once an estimate has been
          // sent the recipient has a copy; mutating silently is a footgun
          // (and an audit-trail misdirection). Accepted / declined are
          // terminal records; expired is advisory.
          if (current.status !== 'draft') {
            return c.json({ error: 'not_editable', status: current.status }, 409);
          }

          const [customer] = await tx
            .select({ id: contacts.id, companyId: contacts.companyId })
            .from(contacts)
            .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
            .limit(1);
          if (!customer) return c.json({ error: 'contact_not_found' }, 404);
          if (customer.companyId !== current.companyId) {
            return c.json({ error: 'customer_company_mismatch' }, 400);
          }

          if (header.number !== current.number) {
            const [taken] = await tx
              .select({ id: estimates.id })
              .from(estimates)
              .where(
                and(
                  eq(estimates.accountId, accountId),
                  eq(estimates.companyId, current.companyId),
                  eq(estimates.number, header.number),
                ),
              )
              .limit(1);
            if (taken) return c.json({ error: 'estimate_number_taken' }, 409);
          }

          const beforeLines = await tx
            .select()
            .from(estimateLineItems)
            .where(
              and(eq(estimateLineItems.estimateId, id), eq(estimateLineItems.accountId, accountId)),
            )
            .orderBy(asc(estimateLineItems.position));

          await tx
            .delete(estimateLineItems)
            .where(
              and(eq(estimateLineItems.estimateId, id), eq(estimateLineItems.accountId, accountId)),
            );
          const newLineRows = lineItems.map((li) => ({
            id: uuidv7(),
            accountId,
            estimateId: id,
            ...li,
          }));
          await tx.insert(estimateLineItems).values(newLineRows);

          const [updated] = await tx
            .update(estimates)
            .set({
              contactId,
              number: header.number,
              issueDate: header.issueDate,
              expiresOn: header.expiresOn ?? null,
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
            .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'estimate_not_found' }, 404);

          await c.var.audit({
            entityType: 'estimate',
            entityId: id,
            action: 'update',
            before: { ...current, lineItems: beforeLines },
            after: { ...updated, lineItems: newLineRows },
            companyId: current.companyId,
          });

          return c.json({ ...updated, lineItems: newLineRows });
        },
      )
      .post('/api/estimates/:id/mark-sent', requireCapability('sales:write'), (c) =>
        transitionEstimate(c, c.req.param('id'), 'mark-sent', ESTIMATE_TRANSITIONS['mark-sent']),
      )
      .post('/api/estimates/:id/mark-accepted', requireCapability('sales:write'), (c) =>
        transitionEstimate(
          c,
          c.req.param('id'),
          'mark-accepted',
          ESTIMATE_TRANSITIONS['mark-accepted'],
        ),
      )
      .post('/api/estimates/:id/mark-declined', requireCapability('sales:write'), (c) =>
        transitionEstimate(
          c,
          c.req.param('id'),
          'mark-declined',
          ESTIMATE_TRANSITIONS['mark-declined'],
        ),
      )
      // Convert an accepted estimate into a draft invoice. Gated to status
      // 'accepted' — the "estimate → agreement → invoice" flow. Idempotent:
      // a second call (or a re-load that fires the action twice) returns the
      // existing invoice id instead of creating a duplicate. The estimate's
      // status does not change here; convert is a link action, not a status
      // transition (the comment on ESTIMATE_TRANSITIONS up top calls this
      // out). Invoice number is auto-generated server-side via the same
      // suggestNextInvoiceNumber pipeline the /next-number endpoint uses;
      // (companyId, number) is pre-checked inside the tx for the same
      // reason the invoice POST pre-checks — a constraint throw would
      // poison the tenant tx and roll back the audit rows.
      .post('/api/estimates/:id/convert', requireCapability('sales:write'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [estimate] = await tx
          .select()
          .from(estimates)
          .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
          .limit(1);
        if (!estimate) return c.json({ error: 'estimate_not_found' }, 404);

        // Idempotent re-call: if the link is already set, return that
        // invoice id without writing anything. Keeps double-submits + the
        // browser back/forward pattern from minting a second invoice.
        if (estimate.convertedInvoiceId) {
          return c.json({ id: estimate.convertedInvoiceId });
        }

        if (estimate.status !== 'accepted') {
          return c.json(
            { error: 'invalid_transition', from: estimate.status, to: 'converted' },
            409,
          );
        }

        const estimateLines = await tx
          .select()
          .from(estimateLineItems)
          .where(
            and(eq(estimateLineItems.estimateId, id), eq(estimateLineItems.accountId, accountId)),
          )
          .orderBy(asc(estimateLineItems.position));

        // Server-side defaults for the new invoice. Issue date is today,
        // due date is today + 30d (Net 30). Operator can edit either via
        // the draft invoice's PATCH path before sending.
        const today = new Date();
        const todayIso = today.toISOString().slice(0, 10);
        const dueIso = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);

        const [latest] = await tx
          .select({ number: invoices.number })
          .from(invoices)
          .where(and(eq(invoices.accountId, accountId), eq(invoices.companyId, estimate.companyId)))
          .orderBy(desc(invoices.createdAt))
          .limit(1);
        const invoiceNumber = suggestNextInvoiceNumber(latest?.number);

        const [taken] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.accountId, accountId),
              eq(invoices.companyId, estimate.companyId),
              eq(invoices.number, invoiceNumber),
            ),
          )
          .limit(1);
        if (taken) return c.json({ error: 'invoice_number_collision', number: invoiceNumber }, 409);

        // Estimates have no from-block flags of their own, so the converted
        // invoice inherits the company's display defaults.
        const [convertCompany] = await tx
          .select({
            showAddress: companies.showAddressOnInvoice,
            showPhone: companies.showPhoneOnInvoice,
            showEmail: companies.showEmailOnInvoice,
          })
          .from(companies)
          .where(and(eq(companies.id, estimate.companyId), eq(companies.accountId, accountId)))
          .limit(1);

        const invoiceId = uuidv7();
        await tx.insert(invoices).values({
          id: invoiceId,
          accountId,
          companyId: estimate.companyId,
          contactId: estimate.contactId,
          number: invoiceNumber,
          issueDate: todayIso,
          dueDate: dueIso,
          currency: estimate.currency,
          subtotal: estimate.subtotal,
          tax: estimate.tax,
          total: estimate.total,
          notes: estimate.notes,
          showAddress: convertCompany?.showAddress ?? true,
          showPhone: convertCompany?.showPhone ?? true,
          showEmail: convertCompany?.showEmail ?? true,
        });
        if (estimateLines.length > 0) {
          await tx.insert(invoiceLineItems).values(
            estimateLines.map((li) => ({
              id: uuidv7(),
              accountId,
              invoiceId,
              position: li.position,
              description: li.description,
              quantity: li.quantity,
              unitPrice: li.unitPrice,
              amount: li.amount,
              // Carry the product/service type onto the converted invoice line
              // so it posts to the same revenue accounts the estimate implied.
              type: li.type,
              // Carry the estimate line's tax snapshot onto the converted
              // invoice line so the invoice is taxed exactly as quoted.
              taxable: li.taxable,
              taxRatePct: li.taxRatePct,
              taxAmount: li.taxAmount,
              taxPolicyId: li.taxPolicyId,
              // Carry the catalog breadcrumb from the estimate line onto the
              // converted invoice line so the report sees the same product.
              sourceItemId: li.sourceItemId,
            })),
          );
        }

        await tx
          .update(estimates)
          .set({ convertedInvoiceId: invoiceId, updatedAt: today })
          .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)));

        await c.var.audit({
          entityType: 'estimate',
          entityId: id,
          action: 'convert',
          before: { convertedInvoiceId: null },
          after: { convertedInvoiceId: invoiceId },
          companyId: estimate.companyId,
        });
        await c.var.audit({
          entityType: 'invoice',
          entityId: invoiceId,
          action: 'create',
          after: {
            id: invoiceId,
            companyId: estimate.companyId,
            contactId: estimate.contactId,
            number: invoiceNumber,
            issueDate: todayIso,
            dueDate: dueIso,
            currency: estimate.currency,
            subtotal: estimate.subtotal,
            tax: estimate.tax,
            total: estimate.total,
            notes: estimate.notes,
            convertedFromEstimateId: id,
          },
          companyId: estimate.companyId,
        });

        // Telemetry (opt-in; no-op unless the account enabled it). Reached only
        // on the real conversion — the idempotent re-call returns early above.
        await emit(tx, { name: 'estimate_converted' });

        return c.json({ id: invoiceId }, 201);
      })
      // Send the estimate via email. Mirrors invoice /send: draft → sent
      // first call (stamps sent_at, mints public_token), resend on sent
      // emails only without mutating state. Accepted / declined / expired
      // are terminal for the send action — 409. The estimate body links to
      // the unauthed /e/<token> page that accept/decline POST against.
      .post(
        '/api/estimates/:id/send',
        requireCapability('sales:write'),
        validator('json', (value, c) => {
          const parsed = estimateSendSchema.safeParse(value ?? {});
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

          const accountId = c.get('accountId');

          // tx1: reads + the first-send transition (status/token/audit), then
          // release the connection before the Resend call below (deferred-tx
          // route, see rls-context). Guard branches build their c.json error
          // here and are returned via the `instanceof Response` check after.
          const prep = await c.var.runInTx(async (tx, audit) => {
            const [current] = await tx
              .select()
              .from(estimates)
              .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
              .limit(1);
            if (!current) return c.json({ error: 'estimate_not_found' }, 404);
            // Accepted / declined / expired are operationally closed — sending
            // again would muddle the audit trail. Operator who wants a fresh
            // round of correspondence should duplicate the estimate.
            if (
              current.status === 'accepted' ||
              current.status === 'declined' ||
              current.status === 'expired'
            ) {
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

            let estimate = current;
            if (current.status === 'draft') {
              const now = new Date();
              const [updated] = await tx
                .update(estimates)
                .set({
                  status: 'sent',
                  sentAt: now,
                  updatedAt: now,
                  publicToken: current.publicToken ?? randomBytes(32).toString('hex'),
                })
                .where(and(eq(estimates.id, id), eq(estimates.accountId, accountId)))
                .returning();
              if (!updated) return c.json({ error: 'estimate_not_found' }, 404);
              estimate = updated;

              await audit({
                entityType: 'estimate',
                entityId: id,
                action: 'mark-sent',
                before: {
                  status: current.status,
                  sentAt: current.sentAt,
                  acceptedAt: current.acceptedAt,
                  declinedAt: current.declinedAt,
                  publicToken: current.publicToken,
                },
                after: {
                  status: updated.status,
                  sentAt: updated.sentAt,
                  acceptedAt: updated.acceptedAt,
                  declinedAt: updated.declinedAt,
                  publicToken: updated.publicToken,
                },
                companyId: updated.companyId,
              });
            }

            if (!estimate.publicToken) {
              return c.json({ error: 'estimate_state_invalid' }, 500);
            }

            const companyName = company?.name ?? 'Thalermark';
            const template = await resolveEmailTemplate(
              tx,
              accountId,
              estimate.companyId,
              'estimate',
            );
            return {
              estimate: { ...estimate, publicToken: estimate.publicToken },
              customerName: customer.name,
              companyName,
              replyToEmail: company?.replyToEmail ?? null,
              template,
              to,
            };
          });
          // A guard branch returned a built error response — pass it through.
          if (prep instanceof Response) return prep;
          const { estimate, customerName, companyName, replyToEmail, template, to } = prep;

          // Email send — no DB connection held. Shared builder (lib/estimate-
          // email.ts) so this route and the template-preview endpoint emit
          // identical email. NOTE: tx1 already committed the draft → sent
          // transition, so an email failure now leaves the estimate 'sent' (not
          // rolled back to draft) — recoverable via an idempotent resend, and
          // consistent with the mark-sent path.
          let subject: string;
          try {
            ({ subject } = await sendEstimateEmail(deps.mailer, to, {
              estimate,
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

          // tx2: record the delivery.
          await c.var.runInTx(async (_tx, audit) => {
            await audit({
              entityType: 'estimate',
              entityId: id,
              action: 'email-sent',
              after: { to, subject },
              companyId: estimate.companyId,
            });
          });

          return c.json({ ...estimate, sentTo: to });
        },
      )
    // Public invoice view — unauthed, gated only by the random token in
    // the URL. rls-context skips this path entirely (no session, no
    // tenant), so the handler reads via bootstrapDb (RLS would hide
    // every row under the missing app.current_account_id setting).
    // The recipient sees what a paper invoice would show: header, line
    // items, customer name, sender company name. Account / company ids
    // and the audit trail stay out of the response.
  );
}

export type EstimatesAppType = ReturnType<typeof estimatesRoutes>;
