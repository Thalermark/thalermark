import { randomBytes } from 'node:crypto';
import {
  type Database,
  accounts,
  authUser,
  companies,
  customers,
  invitations,
  invoiceLineItems,
  invoices,
  memberships,
} from '@thalermark/db';
import {
  customerCreateSchema,
  customerUpdateSchema,
  invoiceCreateSchema,
  invoiceUpdateSchema,
} from '@thalermark/validation';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import type { ApiAuth } from './lib/auth.js';
import { type RlsVariables, rlsContext } from './middleware/rls-context.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Smart-detect: increment the trailing integer of the company's most recent
// invoice number while keeping prefix + zero-padding intact. Preserves
// whatever convention the user adopted ("INV-0042" → "INV-0043",
// "2026-007" → "2026-008", "42" → "43"). No prior invoice OR no trailing
// integer → the locked first-invoice default "INV-0001". Single source of
// truth for the suggestion lives here in the API so mobile can hit the same
// endpoint without re-deriving.
const FIRST_INVOICE_DEFAULT = 'INV-0001';
const TRAILING_INT_RE = /^(.*?)(\d+)$/;
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
  const patch: Record<string, unknown> = {
    status: spec.to,
    updatedAt: now,
    [spec.stamp]: now,
  };
  const [updated] = await tx
    .update(invoices)
    .set(patch)
    .where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))
    .returning();
  if (!updated) return c.json({ error: 'invoice_not_found' }, 404);

  await c.var.audit({
    entityType: 'invoice',
    entityId: id,
    action: key,
    before: {
      status: current.status,
      sentAt: current.sentAt,
      paidAt: current.paidAt,
      voidedAt: current.voidedAt,
    },
    after: {
      status: updated.status,
      sentAt: updated.sentAt,
      paidAt: updated.paidAt,
      voidedAt: updated.voidedAt,
    },
    companyId: updated.companyId,
  });

  return c.json(updated);
}

export function suggestNextInvoiceNumber(latest: string | undefined): string {
  if (!latest) return FIRST_INVOICE_DEFAULT;
  const match = TRAILING_INT_RE.exec(latest);
  if (!match) return FIRST_INVOICE_DEFAULT;
  const [, prefix, digits] = match;
  const next = (BigInt(digits ?? '0') + 1n).toString();
  const padded = next.padStart((digits ?? '').length, '0');
  return `${prefix ?? ''}${padded}`;
}

export type AppDeps = {
  auth: ApiAuth;
  db: Database;
  // Superuser/BYPASSRLS handle for the narrow bootstrap surface that runs
  // before a tenant context exists: /api/me's "what accounts do I belong to"
  // and rls-context's membership probe. The RLS policies on accounts and
  // memberships gate visibility on `app.current_account_id`, which isn't set
  // on these requests, so under the tenant role they'd return zero rows.
  // Optional because integration tests run as the testcontainer superuser
  // and have nothing to distinguish; production server.ts passes both.
  bootstrapDb?: Database;
  scheduleFlush?: (db: Database, accountId: string) => void;
  trustedOrigins?: string[];
  publicAppUrl?: string;
  // Test seam: swap the invite-link logger. Defaults to console.log so dev
  // operators can grab the token from API stdout without an email transport.
  logInviteUrl?: (msg: string) => void;
};

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Routes are chained so Hono's type system carries each route's path + handler
// shape through to AppType, which Phase 4's packages/api-contract re-exports
// for hc<AppType>() clients. Breaking the chain (e.g. `app.get(...); app.get(...)`)
// erases that schema back to an empty Hono.
export function createApp(deps: AppDeps) {
  const origins = deps.trustedOrigins ?? [];
  const logInviteUrl = deps.logInviteUrl ?? ((msg: string) => console.log(msg));
  const bootstrapDb = deps.bootstrapDb ?? deps.db;
  return (
    new Hono<{ Variables: RlsVariables }>()
      .get('/health', (c) => c.json({ status: 'ok' }))
      .use(
        '/api/*',
        cors({
          origin: (incoming) => (origins.includes(incoming) ? incoming : null),
          credentials: true,
          allowHeaders: ['Content-Type', 'x-account-id', 'Authorization'],
          allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
          // set-auth-token is the bearer plugin's session-token echo. Browsers
          // hide non-CORS-safelisted response headers from JS unless exposed
          // here, so the mobile (and Expo Web) client can read + persist it.
          exposeHeaders: ['set-auth-token'],
        }),
      )
      .on(['GET', 'POST'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw))
      .use(
        '/api/*',
        rlsContext({
          auth: deps.auth,
          db: deps.db,
          bootstrapDb,
          scheduleFlush: deps.scheduleFlush,
        }),
      )
      .get('/api/me', async (c) => {
        const userId = c.get('userId');
        const [user] = await bootstrapDb
          .select({
            id: authUser.id,
            email: authUser.email,
            name: authUser.name,
            lastAccountId: authUser.lastAccountId,
          })
          .from(authUser)
          .where(eq(authUser.id, userId));
        if (!user) return c.json({ error: 'unauthorized' }, 401);
        const rows = await bootstrapDb
          .select({ accountId: memberships.accountId, name: accounts.name })
          .from(memberships)
          .innerJoin(accounts, eq(memberships.accountId, accounts.id))
          .where(eq(memberships.userId, userId));
        return c.json({ user, memberships: rows });
      })
      .post('/api/invitations', async (c) => {
        const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
        const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!EMAIL_RE.test(email)) return c.json({ error: 'invalid_email' }, 400);

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const inviterId = c.get('userId');
        const id = uuidv7();
        const token = randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

        await tx.insert(invitations).values({
          id,
          accountId,
          email,
          token,
          invitedByUserId: inviterId,
          expiresAt,
        });

        const path = `/accept-invite?token=${token}`;
        const url = deps.publicAppUrl ? `${deps.publicAppUrl}${path}` : path;
        logInviteUrl(`[invite] account=${accountId} email=${email} url=${url}`);

        return c.json({ id, email, token, expiresAt: expiresAt.toISOString() }, 201);
      })
      .post('/api/invitations/:token/accept', async (c) => {
        // Bootstrap path: rls-context set userId from the session but did not
        // open a tenant tx (the accepting user is not yet a member). Use the
        // raw db; uniqueness on token + the freshness checks below are enough.
        const userId = c.get('userId');
        const [user] = await deps.db
          .select({ id: authUser.id, email: authUser.email })
          .from(authUser)
          .where(eq(authUser.id, userId));
        if (!user) return c.json({ error: 'unauthorized' }, 401);

        const token = c.req.param('token');
        const [invite] = await deps.db
          .select()
          .from(invitations)
          .where(and(eq(invitations.token, token), isNull(invitations.acceptedAt)));
        if (!invite) return c.json({ error: 'invite_not_found' }, 404);
        if (invite.expiresAt.getTime() < Date.now())
          return c.json({ error: 'invite_expired' }, 410);
        if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
          return c.json({ error: 'invite_email_mismatch' }, 403);
        }

        const acceptedAt = new Date();
        await deps.db.transaction(async (tx) => {
          await tx
            .insert(memberships)
            .values({ id: uuidv7(), userId: user.id, accountId: invite.accountId })
            .onConflictDoNothing({ target: [memberships.userId, memberships.accountId] });
          await tx
            .update(invitations)
            .set({ acceptedAt, acceptedByUserId: user.id, updatedAt: acceptedAt })
            .where(eq(invitations.id, invite.id));
        });

        return c.json({ accountId: invite.accountId });
      })
      .get('/api/companies', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        // Explicit account_id filter on every domain query — defense in depth
        // for the case where the DB role bypasses RLS (the integration tests
        // run as the testcontainer superuser; production currently does too
        // until the api flips to thalermark_app). Belt + braces with the RLS
        // policies.
        const rows = await tx
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(eq(companies.accountId, accountId))
          .orderBy(asc(companies.createdAt));
        return c.json({ companies: rows });
      })
      .post('/api/customers', async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = customerCreateSchema.safeParse(body);
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

        const id = uuidv7();
        const row = { id, accountId, ...parsed.data };
        await tx.insert(customers).values(row);
        await c.var.audit({
          entityType: 'customer',
          entityId: id,
          action: 'create',
          after: row,
          companyId: parsed.data.companyId,
        });

        return c.json(row, 201);
      })
      .get('/api/customers', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const conditions = [eq(customers.accountId, accountId)];
        if (companyId) conditions.push(eq(customers.companyId, companyId));
        const rows = await tx
          .select()
          .from(customers)
          .where(and(...conditions));
        return c.json({ customers: rows });
      })
      .get('/api/customers/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [row] = await tx
          .select()
          .from(customers)
          .where(and(eq(customers.id, id), eq(customers.accountId, accountId)));
        if (!row) return c.json({ error: 'customer_not_found' }, 404);
        return c.json(row);
      })
      // hono/validator middleware: lifts the json body into the typed Input
      // so hc<AppType>() infers `{ param, json }` on .$patch. Without it the
      // client would only see `{ param }` (path-param-only) and reject the
      // body argument at compile time. Also lets the handler drop the
      // duplicated safeParse — c.req.valid('json') hands back the parsed
      // shape, and the validator returns the 400 itself.
      .patch(
        '/api/customers/:id',
        validator('json', (value, c) => {
          const parsed = customerUpdateSchema.safeParse(value);
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
            .from(customers)
            .where(and(eq(customers.id, id), eq(customers.accountId, accountId)))
            .limit(1);
          if (!before) return c.json({ error: 'customer_not_found' }, 404);

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
            .update(customers)
            .set(patch)
            .where(and(eq(customers.id, id), eq(customers.accountId, accountId)))
            .returning();
          if (!after) return c.json({ error: 'customer_not_found' }, 404);

          await c.var.audit({
            entityType: 'customer',
            entityId: id,
            action: 'update',
            before,
            after,
            companyId: before.companyId,
          });

          return c.json(after);
        },
      )
      .post('/api/invoices', async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = invoiceCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const { companyId, customerId, lineItems, ...header } = parsed.data;

        // Customer must belong to this account AND match the requested companyId.
        // The schema does not enforce the customer↔company link at the DB level
        // (customers carry companyId; invoices independently set companyId), so
        // we check it here to avoid an invoice that disagrees with its customer.
        const [customer] = await tx
          .select({ id: customers.id, companyId: customers.companyId })
          .from(customers)
          .where(and(eq(customers.id, customerId), eq(customers.accountId, accountId)))
          .limit(1);
        if (!customer) return c.json({ error: 'customer_not_found' }, 404);
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

        const invoiceId = uuidv7();
        await tx.insert(invoices).values({
          id: invoiceId,
          accountId,
          companyId,
          customerId,
          ...header,
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
          after: { id: invoiceId, ...parsed.data },
          companyId,
        });

        return c.json({ id: invoiceId, ...parsed.data }, 201);
      })
      .get('/api/invoices', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const status = c.req.query('status');
        const conditions = [eq(invoices.accountId, accountId)];
        if (companyId) conditions.push(eq(invoices.companyId, companyId));
        if (status) conditions.push(eq(invoices.status, status));
        const rows = await tx
          .select()
          .from(invoices)
          .where(and(...conditions))
          .orderBy(asc(invoices.createdAt));
        return c.json({ invoices: rows });
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
          const { customerId, lineItems, ...header } = data;

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

          // customerId is mutable on edit, so the customer↔company invariant
          // needs the same check the create endpoint does. companyId is fixed
          // (omitted from the update schema) — the invoice cannot move
          // between companies — so we compare against current.companyId.
          const [customer] = await tx
            .select({ id: customers.id, companyId: customers.companyId })
            .from(customers)
            .where(and(eq(customers.id, customerId), eq(customers.accountId, accountId)))
            .limit(1);
          if (!customer) return c.json({ error: 'customer_not_found' }, 404);
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
              customerId,
              number: header.number,
              issueDate: header.issueDate,
              dueDate: header.dueDate,
              currency: header.currency ?? current.currency,
              subtotal: header.subtotal,
              tax: header.tax ?? '0',
              total: header.total,
              notes: header.notes ?? null,
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
      .post('/api/invoices/:id/mark-sent', (c) =>
        transitionInvoice(c, c.req.param('id'), 'mark-sent', INVOICE_TRANSITIONS['mark-sent']),
      )
      .post('/api/invoices/:id/mark-paid', (c) =>
        transitionInvoice(c, c.req.param('id'), 'mark-paid', INVOICE_TRANSITIONS['mark-paid']),
      )
      .post('/api/invoices/:id/void', (c) =>
        transitionInvoice(c, c.req.param('id'), 'void', INVOICE_TRANSITIONS.void),
      )
  );
}

export type AppType = ReturnType<typeof createApp>;
