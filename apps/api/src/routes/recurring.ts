import { contacts, invoices, recurringInvoiceLineItems, recurringInvoices } from '@thalermark/db';
import { recurringInvoiceCreateSchema, recurringInvoiceUpdateSchema } from '@thalermark/validation';
import { and, asc, desc, eq, getTableColumns } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import type { AppDeps } from '../app.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import { generateOnce } from '../lib/recurring.js';
import { UUID_RE, companyTimezone, localToday } from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import { requireEntitlement } from '../middleware/entitlement.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// recurring-invoices — recurring schedules: a template + cadence the
// background sweeper clones into real invoices. CRUD + pause/resume/end +
// run-now (generateOnce, which emails the generated invoice). A deps-taking
// sub-app: run-now closes over deps.mailer / deps.emailFrom / deps.publicAppUrl.
// The schedule state machine is transitionRecurringInvoice below. Mounted on
// createApp via .route() so its schema rides on its own RecurringInvoicesAppType
// instead of bloating AppType past the TS7056 ceiling.
// Recurring-invoice schedule state machine. Allowed transitions:
//   active → paused   (pause — manual hold; sweeper skips paused schedules)
//   paused → active   (resume)
//   active → ended    (end — terminal)
//   paused → ended    (end — terminal)
// `ended` is terminal. An end condition (end_date / max_occurrences) reached
// during generation also moves a schedule to `ended` (slice R3), so the same
// status set is written from two places.
type RecurringStatus = 'active' | 'paused' | 'ended';
type RecurringTransitionKey = 'pause' | 'resume' | 'end';
const RECURRING_TRANSITIONS: Record<
  RecurringTransitionKey,
  { from: readonly RecurringStatus[]; to: RecurringStatus }
> = {
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  end: { from: ['active', 'paused'], to: 'ended' },
};

async function transitionRecurringInvoice(
  c: Context<{ Variables: RlsVariables }>,
  id: string,
  key: RecurringTransitionKey,
) {
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
  const spec = RECURRING_TRANSITIONS[key];
  const tx = c.get('tx');
  const accountId = c.get('accountId');

  const [current] = await tx
    .select()
    .from(recurringInvoices)
    .where(and(eq(recurringInvoices.id, id), eq(recurringInvoices.accountId, accountId)))
    .limit(1);
  if (!current) return c.json({ error: 'recurring_invoice_not_found' }, 404);

  if (!(spec.from as readonly string[]).includes(current.status)) {
    return c.json({ error: 'invalid_transition', from: current.status, to: spec.to }, 409);
  }

  const now = new Date();
  const patch: Record<string, unknown> = { status: spec.to, updatedAt: now };
  // On resume, if next_run_date is in the past (the schedule was paused
  // through one or more would-be occurrences), pull it forward to today so the
  // next sweep mints a current-dated invoice rather than a back-dated one.
  // next_run_date is an ISO YYYY-MM-DD string, so a lexicographic compare is a
  // date compare. The sweeper's own catch-up collapse (slice R3) covers
  // server-downtime gaps; this covers the deliberate pause case.
  if (key === 'resume') {
    // Today in the business's zone (TMC-258) — resuming in the evening used to
    // schedule the next run for tomorrow, skipping a day of billing.
    const todayIso = localToday(
      await companyTimezone(tx, { accountId, companyId: current.companyId }),
    );
    if (current.nextRunDate < todayIso) patch.nextRunDate = todayIso;
  }

  const [updated] = await tx
    .update(recurringInvoices)
    .set(patch)
    .where(and(eq(recurringInvoices.id, id), eq(recurringInvoices.accountId, accountId)))
    .returning();
  if (!updated) return c.json({ error: 'recurring_invoice_not_found' }, 404);

  await c.var.audit({
    entityType: 'recurring_invoice',
    entityId: id,
    action: key,
    before: { status: current.status, nextRunDate: current.nextRunDate },
    after: { status: updated.status, nextRunDate: updated.nextRunDate },
    companyId: updated.companyId,
  });

  return c.json(updated);
}

export function recurringInvoicesRoutes(deps: AppDeps) {
  return (
    new Hono<{ Variables: RlsVariables }>()
      // Recurring invoice schedules (slice R2). A schedule is a template +
      // cadence; the background sweeper (slice R3) clones it into a real
      // invoice on each occurrence. CRUD + pause/resume/end here; no
      // generation yet. Mirrors the invoice routes (customer↔company
      // invariant, full-replacement line items, draft-style PATCH) minus the
      // (company_id, number) uniqueness — schedules have no number.
      .post('/api/recurring-invoices', requireCapability('sales:write'), async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = recurringInvoiceCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const { companyId, contactId, lineItems } = parsed.data;
        const d = parsed.data;

        const [customer] = await tx
          .select({ id: contacts.id, companyId: contacts.companyId })
          .from(contacts)
          .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
          .limit(1);
        if (!customer) return c.json({ error: 'contact_not_found' }, 404);
        if (customer.companyId !== companyId) {
          return c.json({ error: 'customer_company_mismatch' }, 400);
        }

        const recurringId = uuidv7();
        // next_run_date seeds from start_date; the sweeper advances it.
        await tx.insert(recurringInvoices).values({
          id: recurringId,
          accountId,
          companyId,
          contactId,
          frequency: d.frequency,
          intervalCount: d.intervalCount,
          startDate: d.startDate,
          nextRunDate: d.startDate,
          endDate: d.endDate ?? null,
          maxOccurrences: d.maxOccurrences ?? null,
          netTermsDays: d.netTermsDays ?? 30,
          currency: d.currency ?? 'USD',
          subtotal: d.subtotal,
          tax: d.tax ?? '0',
          total: d.total,
          notes: d.notes ?? null,
        });
        const lineRows = lineItems.map((li) => ({
          id: uuidv7(),
          accountId,
          recurringInvoiceId: recurringId,
          ...li,
        }));
        await tx.insert(recurringInvoiceLineItems).values(lineRows);

        await c.var.audit({
          entityType: 'recurring_invoice',
          entityId: recurringId,
          action: 'create',
          after: { id: recurringId, ...parsed.data },
          companyId,
        });

        return c.json({ id: recurringId, ...parsed.data }, 201);
      })
      .get('/api/recurring-invoices', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const status = c.req.query('status');
        const limit = parseLimit(c.req.query('limit'));
        if (limit === null) return c.json({ error: 'invalid_limit' }, 400);
        const keys = [
          { col: recurringInvoices.createdAt, revive: (v: unknown) => new Date(v as string) },
          { col: recurringInvoices.id },
        ];
        const keyset = applyCursor(c.req.query('cursor'), keys, 'desc');
        if (keyset === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);
        const conditions = [eq(recurringInvoices.accountId, accountId)];
        if (companyId) conditions.push(eq(recurringInvoices.companyId, companyId));
        if (status) conditions.push(eq(recurringInvoices.status, status));
        if (keyset) conditions.push(keyset);
        // LEFT JOIN the customer name (see /api/invoices for the rationale).
        const rows = await tx
          .select({ ...getTableColumns(recurringInvoices), customerName: contacts.name })
          .from(recurringInvoices)
          .leftJoin(contacts, eq(contacts.id, recurringInvoices.contactId))
          .where(and(...conditions))
          .orderBy(keysetOrderBy(keys, 'desc'))
          .limit(limit + 1);
        const page = slicePage(rows, limit, (r) => [r.createdAt, r.id]);
        return c.json({ recurringInvoices: page.rows, nextCursor: page.nextCursor });
      })
      .get('/api/recurring-invoices/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [schedule] = await tx
          .select()
          .from(recurringInvoices)
          .where(and(eq(recurringInvoices.id, id), eq(recurringInvoices.accountId, accountId)));
        if (!schedule) return c.json({ error: 'recurring_invoice_not_found' }, 404);
        const lines = await tx
          .select()
          .from(recurringInvoiceLineItems)
          .where(
            and(
              eq(recurringInvoiceLineItems.recurringInvoiceId, id),
              eq(recurringInvoiceLineItems.accountId, accountId),
            ),
          )
          .orderBy(asc(recurringInvoiceLineItems.position));
        // Generated invoices carry recurring_invoice_id provenance (slice R1).
        // Return them so the detail page can show the run history without a
        // second round-trip; newest first.
        const generatedInvoices = await tx
          .select({
            id: invoices.id,
            number: invoices.number,
            status: invoices.status,
            issueDate: invoices.issueDate,
            total: invoices.total,
            createdAt: invoices.createdAt,
          })
          .from(invoices)
          .where(and(eq(invoices.recurringInvoiceId, id), eq(invoices.accountId, accountId)))
          .orderBy(desc(invoices.createdAt));
        return c.json({ ...schedule, lineItems: lines, generatedInvoices });
      })
      .patch(
        '/api/recurring-invoices/:id',
        requireCapability('sales:write'),
        validator('json', (value, c) => {
          const parsed = recurringInvoiceUpdateSchema.safeParse(value);
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
          const { contactId, lineItems } = data;
          const d = data;

          const [current] = await tx
            .select()
            .from(recurringInvoices)
            .where(and(eq(recurringInvoices.id, id), eq(recurringInvoices.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'recurring_invoice_not_found' }, 404);

          // Edits are blocked once a schedule is ended (terminal — its run
          // history is fixed). active + paused schedules stay editable so the
          // operator can adjust the template, cadence, or customer.
          if (current.status === 'ended') {
            return c.json({ error: 'not_editable', status: current.status }, 409);
          }

          // contactId is mutable; companyId is fixed (omitted from the update
          // schema), so the customer↔company invariant compares against
          // current.companyId.
          const [customer] = await tx
            .select({ id: contacts.id, companyId: contacts.companyId })
            .from(contacts)
            .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
            .limit(1);
          if (!customer) return c.json({ error: 'contact_not_found' }, 404);
          if (customer.companyId !== current.companyId) {
            return c.json({ error: 'customer_company_mismatch' }, 400);
          }

          const beforeLines = await tx
            .select()
            .from(recurringInvoiceLineItems)
            .where(
              and(
                eq(recurringInvoiceLineItems.recurringInvoiceId, id),
                eq(recurringInvoiceLineItems.accountId, accountId),
              ),
            )
            .orderBy(asc(recurringInvoiceLineItems.position));

          await tx
            .delete(recurringInvoiceLineItems)
            .where(
              and(
                eq(recurringInvoiceLineItems.recurringInvoiceId, id),
                eq(recurringInvoiceLineItems.accountId, accountId),
              ),
            );
          const newLineRows = lineItems.map((li) => ({
            id: uuidv7(),
            accountId,
            recurringInvoiceId: id,
            ...li,
          }));
          await tx.insert(recurringInvoiceLineItems).values(newLineRows);

          // next_run_date and occurrence_count are runtime state owned by the
          // sweeper, not template fields — PATCH leaves them alone EXCEPT
          // before the first generation (occurrence_count === 0), where we
          // keep next_run_date pinned to start_date so editing the start date
          // of a not-yet-run schedule behaves intuitively.
          const nextRunPatch = current.occurrenceCount === 0 ? { nextRunDate: d.startDate } : {};

          const [updated] = await tx
            .update(recurringInvoices)
            .set({
              contactId,
              frequency: d.frequency,
              intervalCount: d.intervalCount,
              startDate: d.startDate,
              endDate: d.endDate ?? null,
              maxOccurrences: d.maxOccurrences ?? null,
              netTermsDays: d.netTermsDays ?? 30,
              currency: d.currency ?? current.currency,
              subtotal: d.subtotal,
              tax: d.tax ?? '0',
              total: d.total,
              notes: d.notes ?? null,
              updatedAt: new Date(),
              ...nextRunPatch,
            })
            .where(and(eq(recurringInvoices.id, id), eq(recurringInvoices.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'recurring_invoice_not_found' }, 404);

          await c.var.audit({
            entityType: 'recurring_invoice',
            entityId: id,
            action: 'update',
            before: { ...current, lineItems: beforeLines },
            after: { ...updated, lineItems: newLineRows },
            companyId: current.companyId,
          });

          return c.json({ ...updated, lineItems: newLineRows });
        },
      )
      .post('/api/recurring-invoices/:id/pause', requireCapability('sales:write'), (c) =>
        transitionRecurringInvoice(c, c.req.param('id'), 'pause'),
      )
      .post('/api/recurring-invoices/:id/resume', requireCapability('sales:write'), (c) =>
        transitionRecurringInvoice(c, c.req.param('id'), 'resume'),
      )
      .post('/api/recurring-invoices/:id/end', requireCapability('sales:write'), (c) =>
        transitionRecurringInvoice(c, c.req.param('id'), 'end'),
      )
      // Generate the next occurrence right now (manual trigger). Same engine
      // the pg-boss sweeper runs, but in the request's tenant tx and attributed
      // to the requesting user rather than the system user. Doubles as the test
      // path (no waiting for cron) and a "send the next one now" UX action.
      // Only an active schedule can run — paused/ended return 409.
      .post(
        '/api/recurring-invoices/:id/run-now',
        requireCapability('sales:write'),
        requireEntitlement(deps, 'documents:write'),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [schedule] = await tx
            .select()
            .from(recurringInvoices)
            .where(and(eq(recurringInvoices.id, id), eq(recurringInvoices.accountId, accountId)))
            .limit(1);
          if (!schedule) return c.json({ error: 'recurring_invoice_not_found' }, 404);
          if (schedule.status !== 'active') {
            return c.json({ error: 'invalid_transition', from: schedule.status, to: 'run' }, 409);
          }
          const result = await generateOnce(tx, {
            schedule,
            audit: c.var.audit,
            mail: {
              mailer: deps.mailer,
              emailFrom: deps.emailFrom,
              publicAppUrl: deps.publicAppUrl,
            },
          });
          return c.json(result, 201);
        },
      )
  );
}

export type RecurringInvoicesAppType = ReturnType<typeof recurringInvoicesRoutes>;
