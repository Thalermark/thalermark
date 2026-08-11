import { companies, contacts, invoices } from '@thalermark/db';
import { emit } from '@thalermark/telemetry';
import {
  contactCreateSchema,
  contactImportSchema,
  contactUpdateSchema,
} from '@thalermark/validation';
import { and, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import type { AppDeps } from '../app.js';
import { buildCustomerStatement } from '../lib/customer-statement.js';
import { resolveEmailTemplate } from '../lib/email-templates.js';
import { mailerDelivers } from '../lib/mailer.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import { EMAIL_RE, UUID_RE, escapeLike } from '../lib/route-helpers.js';
import { sendStatementEmail } from '../lib/statement-email.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// Contact archive/restore — an idempotent, audit-on-change transition, the same
// shape as the items catalog (see setItemArchived in routes/items.ts).
//
// Archive rather than delete, and there is deliberately no DELETE endpoint to
// go with it: invoices.contact_id is RESTRICT, so a contact with any history
// physically cannot be removed, and one without history is not worth a second
// destructive path that behaves differently depending on what the row happens
// to be attached to. Archiving is the one answer for both (TMC-232).
//
// No guard on archiving a contact with open invoices. Archiving is filing, not
// deleting: the invoice keeps its reference, still appears in A/R, and still
// chases for payment. Refusing here would leave someone unable to tidy a picker
// until every last invoice settled, which is the clutter this exists to fix.
async function setContactArchived(
  c: Context<{ Variables: RlsVariables }>,
  id: string,
  archived: boolean,
) {
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
  const tx = c.get('tx');
  const accountId = c.get('accountId');

  const [current] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.accountId, accountId)))
    .limit(1);
  if (!current) return c.json({ error: 'contact_not_found' }, 404);

  // Idempotent: archiving an archived contact is a no-op that writes no audit
  // event, so a double-tap doesn't litter the history tab.
  const isArchived = current.archivedAt !== null;
  if (isArchived === archived) return c.json(current);

  const now = new Date();
  const [updated] = await tx
    .update(contacts)
    .set({ archivedAt: archived ? now : null, updatedAt: now })
    .where(and(eq(contacts.id, id), eq(contacts.accountId, accountId)))
    .returning();
  if (!updated) return c.json({ error: 'contact_not_found' }, 404);

  // The audit write is also the search-reprojection signal (TMC-198), so this
  // is what re-marks the indexed document archived / active.
  await c.var.audit({
    entityType: 'contact',
    entityId: id,
    action: archived ? 'archive' : 'restore',
    before: { archivedAt: current.archivedAt },
    after: { archivedAt: updated.archivedAt },
    companyId: updated.companyId,
  });

  return c.json(updated);
}

// contacts — customers + vendors (one unified table; role flags is_customer /
// is_vendor). Full CRUD within the tenant plus reads layered on top: the GET
// list with q/role/openInvoices filters, late-payer payment-reliability, and the
// send-to-customer statement (view + email). A deps-taking sub-app: the
// statement/send route closes over `deps.mailer` / `deps.emailFrom` (cf. the
// deps-free items/tax-policies sub-apps). Mounted on createApp via .route() so
// its schema rides on its own ContactsAppType instead of bloating AppType past
// the TS7056 ceiling. Route order is load-bearing: /api/contacts/import is
// declared before /api/contacts/:id so Hono's first-match doesn't capture
// "import" as an :id.
export function contactsRoutes(deps: AppDeps) {
  return (
    new Hono<{ Variables: RlsVariables }>()
      .post('/api/contacts', requireCapability('contacts:write'), async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = contactCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, parsed.data.companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        // First-client onboarding milestone (server-authoritative — see the
        // ONBOARDING_STEPS note in @thalermark/validation). Checked BEFORE the
        // insert so "the account's first contact" is honest; emitted after.
        const [priorContact] = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(eq(contacts.accountId, accountId))
          .limit(1);

        const id = uuidv7();
        const row = { id, accountId, ...parsed.data };
        await tx.insert(contacts).values(row);
        await c.var.audit({
          entityType: 'contact',
          entityId: id,
          action: 'create',
          after: row,
          companyId: parsed.data.companyId,
        });

        // Telemetry (opt-in; no-op unless the account enabled it). "Client" is
        // the TELEMETRY.md term for what the app calls a customer.
        await emit(tx, { name: 'client_created' });
        if (!priorContact) {
          await emit(tx, { name: 'onboarding_step_completed', step: 'first_client' });
        }

        return c.json(row, 201);
      })
      // Bulk CSV import (web). The importer parses + maps + previews client-side,
      // then posts the mapped rows as JSON. Registered before /api/contacts/:id
      // so Hono's first-match doesn't capture "import" as an :id. companyId is
      // supplied once and merged onto every row; the whole batch validated up
      // front (contactImportSchema), so this is atomic — every row lands or none.
      .post('/api/contacts/import', requireCapability('contacts:write'), async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = contactImportSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const { companyId } = parsed.data;

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        // One INSERT for the batch; per-row audit so each customer's history tab
        // shows its creation (action 'create', identical to the single path).
        const rows = parsed.data.rows.map((r) => ({ id: uuidv7(), accountId, companyId, ...r }));
        await tx.insert(contacts).values(rows);
        for (const row of rows) {
          await c.var.audit({
            entityType: 'contact',
            entityId: row.id,
            action: 'create',
            after: row,
            companyId,
          });
          await emit(tx, { name: 'client_created' });
        }

        return c.json({ created: rows.length }, 201);
      })
      .get('/api/contacts', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        // Filters: q searches name OR email; openInvoices narrows to contacts
        // who have at least one issued-but-unpaid invoice (status 'sent').
        const q = c.req.query('q');
        const openInvoices = c.req.query('openInvoices') === 'true';
        // role narrows to one side of the relationship: 'customer' (is_customer)
        // or 'vendor' (is_vendor). Omitted = all contacts.
        const role = c.req.query('role');
        // Archived contacts are excluded by DEFAULT, which is the whole point:
        // every picker in the product reads this endpoint, and none of them
        // passes the flag, so archiving takes effect everywhere without a
        // single caller changing. Only the contacts management page opts in,
        // for its show-archived toggle. Same contract as items.
        const includeArchived = c.req.query('includeArchived') === 'true';
        const limit = parseLimit(c.req.query('limit'));
        if (limit === null) return c.json({ error: 'invalid_limit' }, 400);
        const keys = [
          { col: contacts.createdAt, revive: (v: unknown) => new Date(v as string) },
          { col: contacts.id },
        ];
        const keyset = applyCursor(c.req.query('cursor'), keys, 'desc');
        if (keyset === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);
        const conditions = [eq(contacts.accountId, accountId)];
        if (companyId) conditions.push(eq(contacts.companyId, companyId));
        if (!includeArchived) conditions.push(isNull(contacts.archivedAt));
        if (role === 'customer') conditions.push(eq(contacts.isCustomer, true));
        else if (role === 'vendor') conditions.push(eq(contacts.isVendor, true));
        if (q) {
          const term = `%${escapeLike(q)}%`;
          // biome-ignore lint/style/noNonNullAssertion: or() with >=1 arg is non-null
          conditions.push(or(ilike(contacts.name, term), ilike(contacts.email, term))!);
        }
        if (openInvoices) {
          // drafts aren't owed yet; paid/voided are closed — 'sent' is the
          // "owes you money" set. Subquery keeps the keyset scan on contacts.
          const owing = tx
            .select({ id: invoices.contactId })
            .from(invoices)
            .where(and(eq(invoices.accountId, accountId), eq(invoices.status, 'sent')));
          conditions.push(inArray(contacts.id, owing));
        }
        if (keyset) conditions.push(keyset);
        const rows = await tx
          .select()
          .from(contacts)
          .where(and(...conditions))
          .orderBy(keysetOrderBy(keys, 'desc'))
          .limit(limit + 1);
        const page = slicePage(rows, limit, (r) => [r.createdAt, r.id]);
        return c.json({ contacts: page.rows, nextCursor: page.nextCursor });
      })
      // Roster summary powering the contacts-page metric strip. Point-in-time
      // counts: total, the customer / vendor slices (a contact can be both, so
      // these overlap by design and don't sum to total), and how many currently
      // have an issued-but-unpaid ('sent') invoice — the same set the
      // openInvoices filter narrows to. Declared before /:id (Hono first-match).
      .get('/api/contacts/summary', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        // Archived contacts are out of every count, including withOpenInvoices.
        // The strip sits above a list that hides them by default, and a total
        // that disagrees with the rows underneath it reads as a bug — the tile
        // doubles as that list's filter (see the entity-metrics work).
        const conditions = [eq(contacts.accountId, accountId), isNull(contacts.archivedAt)];
        if (companyId) conditions.push(eq(contacts.companyId, companyId));
        const [row] = await tx
          .select({
            total: sql<number>`(count(*))::int`,
            customers: sql<number>`(count(*) filter (where ${contacts.isCustomer}))::int`,
            vendors: sql<number>`(count(*) filter (where ${contacts.isVendor}))::int`,
          })
          .from(contacts)
          .where(and(...conditions));
        // Contacts with an open (issued, unpaid) invoice — mirrors the list's
        // openInvoices subquery (account-scoped, status 'sent').
        const owing = tx
          .select({ id: invoices.contactId })
          .from(invoices)
          .where(and(eq(invoices.accountId, accountId), eq(invoices.status, 'sent')));
        const [openRow] = await tx
          .select({ n: sql<number>`(count(*))::int` })
          .from(contacts)
          .where(and(...conditions, inArray(contacts.id, owing)));
        return c.json({
          total: row?.total ?? 0,
          customers: row?.customers ?? 0,
          vendors: row?.vendors ?? 0,
          withOpenInvoices: openRow?.n ?? 0,
        });
      })
      .get('/api/contacts/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [row] = await tx
          .select()
          .from(contacts)
          .where(and(eq(contacts.id, id), eq(contacts.accountId, accountId)));
        if (!row) return c.json({ error: 'contact_not_found' }, 404);
        return c.json(row);
      })
      // Late-payer detection (AI-layer "invoice intelligence", deterministic):
      // payment reliability computed from this customer's invoice history. "Late"
      // = paid after the due date; avgDaysLate is signed (negative = typically
      // early). overdue* count invoices still unpaid past due. One aggregate
      // pass; no LLM — the numbers are the insight. The customer page renders a
      // plain-English line from these and decides the "enough history" floor.
      .get('/api/contacts/:id/payment-reliability', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [customer] = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.id, id), eq(contacts.accountId, accountId)))
          .limit(1);
        if (!customer) return c.json({ error: 'contact_not_found' }, 404);

        const todayYmd = new Date().toISOString().slice(0, 10);
        const [stats] = await tx
          .select({
            paidCount: sql<number>`count(*) filter (where ${invoices.paidAt} is not null)::int`,
            lateCount: sql<number>`count(*) filter (where ${invoices.paidAt} is not null and (${invoices.paidAt} at time zone 'UTC')::date > ${invoices.dueDate})::int`,
            // Average days past due over the LATE invoices only ("when late,
            // about N days late"). Averaging over all paid invoices would let a
            // far-out due date swing it wildly; this stays the intuitive figure
            // and is always >= 1. Null when nothing was paid late.
            avgDaysLate: sql<
              number | null
            >`round(avg((${invoices.paidAt} at time zone 'UTC')::date - ${invoices.dueDate}) filter (where ${invoices.paidAt} is not null and (${invoices.paidAt} at time zone 'UTC')::date > ${invoices.dueDate}))::int`,
            overdueCount: sql<number>`count(*) filter (where ${invoices.status} = 'sent' and ${invoices.dueDate} < ${todayYmd})::int`,
            overdueTotal: sql<string>`coalesce(sum(${invoices.total}) filter (where ${invoices.status} = 'sent' and ${invoices.dueDate} < ${todayYmd}), 0)::numeric(15,2)`,
          })
          .from(invoices)
          .where(and(eq(invoices.accountId, accountId), eq(invoices.contactId, id)));

        const paidCount = stats?.paidCount ?? 0;
        const lateCount = stats?.lateCount ?? 0;
        return c.json({
          paidCount,
          lateCount,
          onTimeCount: paidCount - lateCount,
          latePct: paidCount > 0 ? Math.round((lateCount / paidCount) * 100) : null,
          avgDaysLate: stats?.avgDaysLate ?? null,
          overdueCount: stats?.overdueCount ?? 0,
          overdueTotal: stats?.overdueTotal ?? '0.00',
        });
      })
      // Customer statement — a send-to-customer account document (not a /reports
      // analytics page): the customer's issued invoices as a chronological
      // charge/payment ledger with a running balance, ending in the balance due.
      // Each issued invoice (status sent or paid; drafts unbilled, voided
      // excluded) is a charge on its issue date; a paid one adds a payment on
      // its paid date. The closing balance equals the customer's outstanding AR.
      .get('/api/contacts/:id/statement', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const statement = await buildCustomerStatement(c.get('tx'), c.get('accountId'), id);
        if (!statement) return c.json({ error: 'contact_not_found' }, 404);
        return c.json(statement);
      })
      // Email the statement to the customer (or a `to` override). Reuses the
      // invoice-send contract: mailer-not-configured => 500, bad recipient =>
      // 400, mailer throw => 502. Best-effort audit on success. The statement
      // has no public link, so the email carries the ledger itself.
      .post(
        '/api/contacts/:id/statement/send',
        requireCapability('contacts:write'),
        validator('json', (value, c) => {
          const v = (value ?? {}) as { to?: unknown };
          if (v.to !== undefined && typeof v.to !== 'string') {
            return c.json({ error: 'invalid_body' }, 400);
          }
          return { to: typeof v.to === 'string' ? v.to : undefined };
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          if (!deps.mailer) return c.json({ error: 'email_not_configured' }, 500);

          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const statement = await buildCustomerStatement(tx, accountId, id);
          if (!statement) return c.json({ error: 'contact_not_found' }, 404);

          const toOverride = c.req.valid('json').to?.trim() || null;
          const to = (toOverride ?? statement.customer.email ?? '').trim();
          if (!to || !EMAIL_RE.test(to)) return c.json({ error: 'invalid_recipient' }, 400);

          // companyId (for the audit) + replyToEmail in one join through the
          // customer (the statement object intentionally doesn't expose them).
          const [meta] = await tx
            .select({ companyId: contacts.companyId, replyToEmail: companies.replyToEmail })
            .from(contacts)
            .innerJoin(companies, eq(companies.id, contacts.companyId))
            .where(and(eq(contacts.id, id), eq(contacts.accountId, accountId)))
            .limit(1);

          const template = meta?.companyId
            ? await resolveEmailTemplate(tx, accountId, meta.companyId, 'statement')
            : undefined;

          let subject: string;
          try {
            ({ subject } = await sendStatementEmail(deps.mailer, to, {
              statement,
              emailFrom: deps.emailFrom,
              replyToEmail: meta?.replyToEmail ?? null,
              template,
            }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: 'email_failed', detail: message }, 502);
          }

          await c.var.audit({
            entityType: 'contact',
            entityId: id,
            action: 'statement-emailed',
            after: {
              to,
              subject,
              balanceDue: statement.balanceDue,
              delivered: mailerDelivers(deps.mailer),
            },
            companyId: meta?.companyId ?? statement.customer.id,
          });

          // See the invoice send (TMC-212).
          return c.json({ sentTo: to, delivered: mailerDelivers(deps.mailer) });
        },
      )
      // hono/validator middleware: lifts the json body into the typed Input
      // so hc<AppType>() infers `{ param, json }` on .$patch. Without it the
      // client would only see `{ param }` (path-param-only) and reject the
      // body argument at compile time. Also lets the handler drop the
      // duplicated safeParse — c.req.valid('json') hands back the parsed
      // shape, and the validator returns the 400 itself.
      .patch(
        '/api/contacts/:id',
        requireCapability('contacts:write'),
        validator('json', (value, c) => {
          const parsed = contactUpdateSchema.safeParse(value);
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

          const [before] = await tx
            .select()
            .from(contacts)
            .where(and(eq(contacts.id, id), eq(contacts.accountId, accountId)))
            .limit(1);
          if (!before) return c.json({ error: 'contact_not_found' }, 404);

          // Full-replacement semantics — undefined optionals clear the column.
          // The DB columns for optional fields are nullable, so collapsing
          // undefined → null keeps the DB state symmetric with what the form
          // submitted rather than leaving stale values around.
          const patch = {
            name: data.name,
            email: data.email ?? null,
            phone: data.phone ?? null,
            addressLine1: data.addressLine1 ?? null,
            addressLine2: data.addressLine2 ?? null,
            city: data.city ?? null,
            region: data.region ?? null,
            postalCode: data.postalCode ?? null,
            country: data.country ?? null,
            notes: data.notes ?? null,
            updatedAt: new Date(),
          };
          const [after] = await tx
            .update(contacts)
            .set(patch)
            .where(and(eq(contacts.id, id), eq(contacts.accountId, accountId)))
            .returning();
          if (!after) return c.json({ error: 'contact_not_found' }, 404);

          await c.var.audit({
            entityType: 'contact',
            entityId: id,
            action: 'update',
            before,
            after,
            companyId: before.companyId,
          });

          return c.json(after);
        },
      )
      // Archive / restore. Two routes rather than a PATCH field so the audit
      // trail records the transition by name, and so archiving can never be a
      // side effect of an ordinary edit — PATCH deliberately doesn't touch
      // archived_at, meaning editing an archived contact keeps it archived.
      .post('/api/contacts/:id/archive', requireCapability('contacts:write'), (c) =>
        setContactArchived(c, c.req.param('id'), true),
      )
      .post('/api/contacts/:id/restore', requireCapability('contacts:write'), (c) =>
        setContactArchived(c, c.req.param('id'), false),
      )
  );
}

export type ContactsAppType = ReturnType<typeof contactsRoutes>;
