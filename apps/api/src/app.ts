import { randomBytes } from 'node:crypto';
import {
  type Database,
  SYSTEM_USER_ID,
  accounts,
  auditEvents,
  authUser,
  companies,
  customers,
  estimateLineItems,
  estimates,
  invitations,
  invoiceLineItems,
  invoices,
  memberships,
} from '@thalermark/db';
import {
  customerCreateSchema,
  customerUpdateSchema,
  estimateCreateSchema,
  estimateUpdateSchema,
  invoiceCreateSchema,
  invoiceSendSchema,
  invoiceUpdateSchema,
} from '@thalermark/validation';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import type { ApiAuth } from './lib/auth.js';
import type { Mailer } from './lib/mailer.js';
import { type StripeBundle, decimalDollarsToCents } from './lib/stripe.js';
import { type RlsVariables, rlsContext } from './middleware/rls-context.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Inline HTML escaper for the invoice-send email body. The recipient's mail
// client renders the HTML, and number / customer name / company name are
// all user-supplied free text — a `<script>` in a company name would
// otherwise ride out to every customer.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Smart-detect: increment the trailing integer of the company's most recent
// invoice number while keeping prefix + zero-padding intact. Preserves
// whatever convention the user adopted ("INV-0042" → "INV-0043",
// "2026-007" → "2026-008", "42" → "43"). No prior invoice OR no trailing
// integer → the locked first-invoice default "INV-0001". Single source of
// truth for the suggestion lives here in the API so mobile can hit the same
// endpoint without re-deriving.
const FIRST_INVOICE_DEFAULT = 'INV-0001';
const FIRST_ESTIMATE_DEFAULT = 'EST-0001';
const TRAILING_INT_RE = /^(.*?)(\d+)$/;

function nextNumberWithDefault(latest: string | undefined, defaultValue: string): string {
  if (!latest) return defaultValue;
  const match = TRAILING_INT_RE.exec(latest);
  if (!match) return defaultValue;
  const [, prefix, digits] = match;
  const next = (BigInt(digits ?? '0') + 1n).toString();
  const padded = next.padStart((digits ?? '').length, '0');
  return `${prefix ?? ''}${padded}`;
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
  // mark-sent mints the public-view token if the invoice doesn't have one
  // yet. 32 random bytes hex matches the invitation token pattern (large
  // enough that brute-force enumeration is uneconomical even without rate
  // limiting). Idempotent: a future re-send transition would keep the same
  // token so the shared URL stays stable for the recipient.
  if (key === 'mark-sent' && !current.publicToken) {
    patch.publicToken = randomBytes(32).toString('hex');
  }
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

  return c.json(updated);
}

export function suggestNextInvoiceNumber(latest: string | undefined): string {
  return nextNumberWithDefault(latest, FIRST_INVOICE_DEFAULT);
}

export function suggestNextEstimateNumber(latest: string | undefined): string {
  return nextNumberWithDefault(latest, FIRST_ESTIMATE_DEFAULT);
}

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
  // Email transport for the invoice-send + invitation endpoints. Optional so
  // integration tests that don't exercise either can omit it; routes that
  // need it fail fast with 500 when called without a mailer wired in.
  mailer?: Mailer;
  emailFrom?: string;
  // Stripe SDK bundle (client + publishable key + webhook secret). Null
  // when the operator hasn't configured STRIPE_* env vars — the public-
  // invoice view checks for null and hides the Pay button rather than
  // erroring; the webhook route returns 503 in that state.
  stripe?: StripeBundle | null;
};

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Routes are chained so Hono's type system carries each route's path + handler
// shape through to AppType, which Phase 4's packages/api-contract re-exports
// for hc<AppType>() clients. Breaking the chain (e.g. `app.get(...); app.get(...)`)
// erases that schema back to an empty Hono.
export function createApp(deps: AppDeps) {
  const origins = deps.trustedOrigins ?? [];
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

        if (!deps.mailer) {
          // server.ts always wires a mailer (console driver is the fallback
          // when RESEND_API_KEY is unset), so reaching this branch means the
          // caller built createApp without wiring one — misconfig, fail fast.
          return c.json({ error: 'mailer_not_configured' }, 500);
        }
        try {
          // Email I/O sits outside the tenant tx: the invitation row already
          // committed when this returns, and a mailer 5xx surfaces as 502
          // without rolling back the insert. The token is recoverable from
          // the row if the user retries; the alternative (rollback) silently
          // discards an invitation the caller saw acknowledged.
          await deps.mailer.send({
            to: email,
            subject: 'You have been invited to Thalermark',
            text: `You have been invited to join an account on Thalermark.\n\nAccept the invitation: ${url}\n\nThe link expires in 7 days.\n`,
            html: `<p>You have been invited to join an account on Thalermark.</p><p><a href="${escapeHtml(url)}">Accept invitation</a></p><p>The link expires in 7 days.</p>`,
          });
        } catch {
          return c.json({ error: 'mailer_send_failed' }, 502);
        }

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
      // Estimates — same shape as invoices minus dueDate and minus the pay
      // path. Mirrors invoices.* closely (status state machine, audit rows,
      // customer↔company invariant, (company_id, number) uniqueness pre-
      // check, draft-only PATCH). Public route + email send + accept/decline
      // land in slice 8.7e; convert-to-invoice in 8.7d.
      .post('/api/estimates', async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = estimateCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const { companyId, customerId, lineItems, ...header } = parsed.data;

        const [customer] = await tx
          .select({ id: customers.id, companyId: customers.companyId })
          .from(customers)
          .where(and(eq(customers.id, customerId), eq(customers.accountId, accountId)))
          .limit(1);
        if (!customer) return c.json({ error: 'customer_not_found' }, 404);
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

        const estimateId = uuidv7();
        await tx.insert(estimates).values({
          id: estimateId,
          accountId,
          companyId,
          customerId,
          ...header,
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
          after: { id: estimateId, ...parsed.data },
          companyId,
        });

        return c.json({ id: estimateId, ...parsed.data }, 201);
      })
      .get('/api/estimates', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const status = c.req.query('status');
        const conditions = [eq(estimates.accountId, accountId)];
        if (companyId) conditions.push(eq(estimates.companyId, companyId));
        if (status) conditions.push(eq(estimates.status, status));
        const rows = await tx
          .select()
          .from(estimates)
          .where(and(...conditions))
          .orderBy(asc(estimates.createdAt));
        return c.json({ estimates: rows });
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
          const { customerId, lineItems, ...header } = data;

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
            .select({ id: customers.id, companyId: customers.companyId })
            .from(customers)
            .where(and(eq(customers.id, customerId), eq(customers.accountId, accountId)))
            .limit(1);
          if (!customer) return c.json({ error: 'customer_not_found' }, 404);
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
              customerId,
              number: header.number,
              issueDate: header.issueDate,
              expiresOn: header.expiresOn ?? null,
              currency: header.currency ?? current.currency,
              subtotal: header.subtotal,
              tax: header.tax ?? '0',
              total: header.total,
              notes: header.notes ?? null,
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
      .post('/api/estimates/:id/mark-sent', (c) =>
        transitionEstimate(c, c.req.param('id'), 'mark-sent', ESTIMATE_TRANSITIONS['mark-sent']),
      )
      .post('/api/estimates/:id/mark-accepted', (c) =>
        transitionEstimate(
          c,
          c.req.param('id'),
          'mark-accepted',
          ESTIMATE_TRANSITIONS['mark-accepted'],
        ),
      )
      .post('/api/estimates/:id/mark-declined', (c) =>
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
      .post('/api/estimates/:id/convert', async (c) => {
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

        const invoiceId = uuidv7();
        await tx.insert(invoices).values({
          id: invoiceId,
          accountId,
          companyId: estimate.companyId,
          customerId: estimate.customerId,
          number: invoiceNumber,
          issueDate: todayIso,
          dueDate: dueIso,
          currency: estimate.currency,
          subtotal: estimate.subtotal,
          tax: estimate.tax,
          total: estimate.total,
          notes: estimate.notes,
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
            customerId: estimate.customerId,
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

        return c.json({ id: invoiceId }, 201);
      })
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
            .select({ id: customers.id, name: customers.name, email: customers.email })
            .from(customers)
            .where(and(eq(customers.id, current.customerId), eq(customers.accountId, accountId)))
            .limit(1);
          if (!customer) return c.json({ error: 'customer_not_found' }, 404);

          const to = (toOverride ?? customer.email ?? '').trim();
          if (!to || !EMAIL_RE.test(to)) return c.json({ error: 'invalid_recipient' }, 400);

          const [company] = await tx
            .select({ name: companies.name })
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
          const publicUrl = deps.publicAppUrl
            ? `${deps.publicAppUrl}/i/${invoice.publicToken}`
            : `/i/${invoice.publicToken}`;
          const subject = `Invoice ${invoice.number} from ${companyName}`;
          const greeting = customer.name ? `Hi ${customer.name},` : 'Hi,';
          const text =
            `${greeting}\n\n` +
            `Invoice ${invoice.number} for ${invoice.total} ${invoice.currency} is ready.\n` +
            `Due ${invoice.dueDate}.\n\n` +
            `View it: ${publicUrl}\n\n` +
            `— ${companyName}`;
          // Escape user-controlled fields before embedding in HTML — invoice
          // number, customer name, and company name are all free text and a
          // recipient's email client will render the HTML body.
          const html =
            `<p>${escapeHtml(greeting)}</p>` +
            `<p>Invoice <strong>${escapeHtml(invoice.number)}</strong> for ` +
            `<strong>${escapeHtml(invoice.total)} ${escapeHtml(invoice.currency)}</strong> is ready. ` +
            `Due ${escapeHtml(invoice.dueDate)}.</p>` +
            `<p><a href="${escapeHtml(publicUrl)}">View invoice</a></p>` +
            `<p>— ${escapeHtml(companyName)}</p>`;

          try {
            await deps.mailer.send({ to, subject, html, text });
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

          return c.json({ ...invoice, sentTo: to });
        },
      )
      // Public invoice view — unauthed, gated only by the random token in
      // the URL. rls-context skips this path entirely (no session, no
      // tenant), so the handler reads via bootstrapDb (RLS would hide
      // every row under the missing app.current_account_id setting).
      // The recipient sees what a paper invoice would show: header, line
      // items, customer name, sender company name. Account / company ids
      // and the audit trail stay out of the response.
      .get('/api/public/invoices/:token', async (c) => {
        const token = c.req.param('token');
        const [invoice] = await bootstrapDb
          .select()
          .from(invoices)
          .where(eq(invoices.publicToken, token))
          .limit(1);
        if (!invoice) return c.json({ error: 'invoice_not_found' }, 404);

        const [company] = await bootstrapDb
          .select({ name: companies.name })
          .from(companies)
          .where(eq(companies.id, invoice.companyId))
          .limit(1);
        const [customer] = await bootstrapDb
          .select({ name: customers.name })
          .from(customers)
          .where(eq(customers.id, invoice.customerId))
          .limit(1);
        const lines = await bootstrapDb
          .select({
            id: invoiceLineItems.id,
            position: invoiceLineItems.position,
            description: invoiceLineItems.description,
            quantity: invoiceLineItems.quantity,
            unitPrice: invoiceLineItems.unitPrice,
            amount: invoiceLineItems.amount,
          })
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, invoice.id))
          .orderBy(asc(invoiceLineItems.position));

        return c.json({
          number: invoice.number,
          status: invoice.status,
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
          currency: invoice.currency,
          subtotal: invoice.subtotal,
          tax: invoice.tax,
          total: invoice.total,
          notes: invoice.notes,
          sentAt: invoice.sentAt,
          paidAt: invoice.paidAt,
          companyName: company?.name ?? null,
          customerName: customer?.name ?? null,
          lineItems: lines,
          // Tell the client whether the Pay button is wirable. Avoids a
          // separate config probe; the recipient's page can branch on this
          // alone without inferring from a 503 on the session-mint call.
          payable: deps.stripe != null && invoice.status === 'sent',
        });
      })
      // Stripe Embedded Checkout session mint. Lazy — the public-view page
      // only POSTs here when the recipient clicks Pay, so we don't bill a
      // Stripe API call on every passive page load. Status guard mirrors
      // the public-invoice GET's `payable` flag; the duplicate check is
      // deliberate (the client could be stale or hand-crafted).
      .post('/api/public/invoices/:token/checkout-session', async (c) => {
        if (!deps.stripe) return c.json({ error: 'stripe_not_configured' }, 503);
        if (!deps.publicAppUrl) return c.json({ error: 'public_url_not_configured' }, 503);
        const token = c.req.param('token');
        const [invoice] = await bootstrapDb
          .select()
          .from(invoices)
          .where(eq(invoices.publicToken, token))
          .limit(1);
        if (!invoice) return c.json({ error: 'invoice_not_found' }, 404);
        if (invoice.status !== 'sent') {
          return c.json({ error: 'not_payable', status: invoice.status }, 409);
        }
        const amountCents = decimalDollarsToCents(invoice.total);
        if (amountCents <= 0) return c.json({ error: 'invalid_amount' }, 400);

        const session = await deps.stripe.client.checkout.sessions.create({
          // Stripe 22.x renamed this from the older 'embedded' literal; same
          // flow — mounts Stripe-hosted UI inside our page via stripe.js'
          // initEmbeddedCheckout.
          ui_mode: 'embedded_page',
          mode: 'payment',
          // Stripe navigates the parent window here after success. Includes
          // ?paid=1 so the page can render a "payment received, processing"
          // banner immediately even if the webhook hasn't fired yet.
          return_url: `${deps.publicAppUrl}/i/${invoice.publicToken}?paid=1`,
          line_items: [
            {
              price_data: {
                currency: invoice.currency.toLowerCase(),
                product_data: { name: `Invoice ${invoice.number}` },
                unit_amount: amountCents,
              },
              quantity: 1,
            },
          ],
          // Echoed on the webhook event — primary lookup for the
          // invoice-id → mark-paid transition. Metadata duplicated so a
          // human reading the Stripe dashboard can also resolve the
          // invoice without poking at our DB.
          client_reference_id: invoice.id,
          metadata: { invoiceId: invoice.id, accountId: invoice.accountId },
        });

        return c.json({
          clientSecret: session.client_secret,
          publishableKey: deps.stripe.publishableKey,
        });
      })
      // Stripe webhook. Signature-verified against the raw body — the JSON
      // parse must come from the SDK, not Hono's, so we read text() and
      // hand it straight to constructEventAsync. No tenant context; the
      // signature IS the auth. Acknowledges with 200 for any state that
      // doesn't need action (already-paid, missing invoice, non-completion
      // event) so Stripe stops the retry loop.
      .post('/api/webhooks/stripe', async (c) => {
        if (!deps.stripe) return c.json({ error: 'stripe_not_configured' }, 503);
        const sig = c.req.header('stripe-signature');
        if (!sig) return c.json({ error: 'missing_signature' }, 400);
        const rawBody = await c.req.text();
        let event: import('stripe').Stripe.Event;
        try {
          event = await deps.stripe.client.webhooks.constructEventAsync(
            rawBody,
            sig,
            deps.stripe.webhookSecret,
          );
        } catch {
          return c.json({ error: 'invalid_signature' }, 400);
        }

        if (event.type !== 'checkout.session.completed') {
          return c.json({ received: true });
        }
        const session = event.data.object;
        if (session.payment_status !== 'paid') {
          return c.json({ received: true });
        }
        const invoiceId = session.client_reference_id;
        if (!invoiceId || !UUID_RE.test(invoiceId)) {
          return c.json({ received: true });
        }

        const [current] = await bootstrapDb
          .select()
          .from(invoices)
          .where(eq(invoices.id, invoiceId))
          .limit(1);
        if (!current) return c.json({ received: true });
        // Already-paid is the idempotent case (Stripe re-delivery, double-
        // submit). 200 so Stripe stops retrying; no audit row.
        if (current.status === 'paid') return c.json({ received: true });
        // Other terminal states (voided, draft-without-send) — should not
        // happen because checkout-session mint guards on status=sent, but
        // a future PI created out-of-band could land here. 200 + no-op so
        // the webhook queue drains; the manual reconciliation is on the
        // operator at that point.
        if (current.status !== 'sent') return c.json({ received: true });

        const now = new Date();
        const [updated] = await bootstrapDb
          .update(invoices)
          .set({ status: 'paid', paidAt: now, updatedAt: now })
          .where(eq(invoices.id, invoiceId))
          .returning();
        if (!updated) return c.json({ received: true });

        // Audit row attributed to the synthetic system user (migration
        // 0009 seeded it specifically for this kind of provider callback).
        // bootstrapDb path — RLS would otherwise hide the row from the
        // tenant role on read; the policy on audit_events allows the
        // superuser unconditionally.
        await bootstrapDb.insert(auditEvents).values({
          id: uuidv7(),
          accountId: current.accountId,
          companyId: current.companyId,
          actorUserId: SYSTEM_USER_ID,
          entityType: 'invoice',
          entityId: invoiceId,
          action: 'stripe-paid',
          before: { status: current.status, paidAt: current.paidAt },
          after: { status: updated.status, paidAt: updated.paidAt },
        });

        return c.json({ received: true });
      })
  );
}

export type AppType = ReturnType<typeof createApp>;
