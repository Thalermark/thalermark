import {
  accounts,
  chartOfAccounts,
  companies,
  emailTemplates,
  journalEntries,
  journalLines,
  reconcileChartOfAccounts,
  seedChartOfAccounts,
} from '@thalermark/db';
import { getLogger } from '@thalermark/logger';
import { emit } from '@thalermark/telemetry';
import {
  type CompanyCopyResult,
  EMAIL_TEMPLATE_PLACEHOLDERS,
  EMAIL_TEMPLATE_TYPES,
  centsToMoney,
  companyCopyRequestSchema,
  companyCreateSchema,
  companyUpdateSchema,
  emailTemplateTypeSchema,
  emailTemplateUpdateSchema,
  resolveCopyInclude,
  toCents,
  unknownPlaceholders,
} from '@thalermark/validation';
import { and, asc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import type { AppDeps } from '../app.js';
import {
  CopyTooLargeError,
  copyCompanyReferenceData,
  copyableProfile,
  logoKeyFor,
  targetIsEmpty,
} from '../lib/company-copy.js';
import { buildEmailPreview } from '../lib/email-preview.js';
import { DEFAULT_TEMPLATES } from '../lib/email-templates.js';
import { mailerDelivers } from '../lib/mailer.js';
import { UUID_RE, mimeForKey } from '../lib/route-helpers.js';
import { connectState } from '../lib/stripe-connect.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// companies — the company (workspace settings) domain: the company list +
// create (which seeds the chart of accounts), the profile PATCH, editable
// email templates (get / put / delete-reset / preview), logo upload / serve /
// delete, Stripe Connect onboarding + status, the GL / trial-balance export,
// and the chart-of-accounts read that powers the expense/bill category +
// payment comboboxes. A deps-taking sub-app: the logo routes close over
// deps.storage, the Stripe Connect routes over deps.stripe + deps.publicAppUrl.
// Mounted on createApp via .route() so its schema rides on its own
// CompaniesAppType instead of bloating AppType past TS7056. Route order is
// load-bearing: the literal /api/companies collection is declared before the
// /:id routes so Hono's first-match doesn't capture it as an id.

// Company logo upload (shown on invoices). Smaller cap than a receipt — a logo
// is a small raster — and a raster-only allowlist: SVG is deliberately excluded
// since it can carry script and the logo renders on the public, unauthenticated
// invoice page. Same mime → extension shape as the receipt upload allowlist
// (RECEIPT_MIME_EXT, in the expenses sub-app).
const log = getLogger(['api', 'companies']);

const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Offline-payment columns projected for the company PATCH's audit before/after
// and response. Keeps those call sites in lockstep; accepts any row carrying
// the fields (the full company select or the PATCH's returning()).
function paymentMethodsView(row: {
  paymentCashEnabled: boolean;
  paymentCheckEnabled: boolean;
  paymentCheckPayableTo: string | null;
  paymentCheckAddress: string | null;
  paymentVenmoHandle: string | null;
  paymentZelleContact: string | null;
}) {
  return {
    paymentCashEnabled: row.paymentCashEnabled,
    paymentCheckEnabled: row.paymentCheckEnabled,
    paymentCheckPayableTo: row.paymentCheckPayableTo,
    paymentCheckAddress: row.paymentCheckAddress,
    paymentVenmoHandle: row.paymentVenmoHandle,
    paymentZelleContact: row.paymentZelleContact,
  };
}

export function companiesRoutes(deps: AppDeps) {
  return (
    new Hono<{ Variables: RlsVariables }>()
      .get('/api/companies', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        // Explicit account_id filter on every domain query — defense in depth
        // for the case where the DB role bypasses RLS (the integration tests
        // run as the testcontainer superuser; production currently does too
        // until the api flips to thalermark_app). Belt + braces with the RLS
        // policies.
        const rows = await tx
          .select({
            id: companies.id,
            name: companies.name,
            businessType: companies.businessType,
            accountingMethod: companies.accountingMethod,
            depreciationConvention: companies.depreciationConvention,
            vehicleExpenseMethod: companies.vehicleExpenseMethod,
            timezone: companies.timezone,
            remindersEnabled: companies.remindersEnabled,
            reminderOffsets: companies.reminderOffsets,
            businessAddress: companies.businessAddress,
            businessPhone: companies.businessPhone,
            businessEmail: companies.businessEmail,
            replyToEmail: companies.replyToEmail,
            showAddressOnInvoice: companies.showAddressOnInvoice,
            showPhoneOnInvoice: companies.showPhoneOnInvoice,
            showEmailOnInvoice: companies.showEmailOnInvoice,
            showAddressOnEstimate: companies.showAddressOnEstimate,
            showPhoneOnEstimate: companies.showPhoneOnEstimate,
            showEmailOnEstimate: companies.showEmailOnEstimate,
            paymentCashEnabled: companies.paymentCashEnabled,
            paymentCheckEnabled: companies.paymentCheckEnabled,
            paymentCheckPayableTo: companies.paymentCheckPayableTo,
            paymentCheckAddress: companies.paymentCheckAddress,
            paymentVenmoHandle: companies.paymentVenmoHandle,
            paymentZelleContact: companies.paymentZelleContact,
            retiredAt: companies.retiredAt,
          })
          .from(companies)
          .where(eq(companies.accountId, accountId))
          .orderBy(asc(companies.createdAt));
        // Retired companies are returned, NOT filtered out. Filtering here looks
        // tidier and is a trap: `pickActiveCompany` on both clients falls back to
        // the first company when its stored pick isn't in the list, so hiding a
        // retired-but-active company would silently swap it for a different one —
        // and every report page would then render another company's figures under
        // the name the user still sees. Silent wrong financials are far worse than
        // a retired company appearing in a list. Callers filter on `retiredAt`.
        return c.json({
          companies: rows.map((r) => ({ ...r, retiredAt: r.retiredAt?.toISOString() ?? null })),
        });
      })
      // POST company — add another business to the workspace. The first company
      // is seeded at signup; this is the multi-company create path. Gated by
      // settings:manage (owner + admin) — same reach as editing a company's
      // profile. Name + type are required so the new company never trips the
      // first-run gate; the chart of accounts for that entity type is seeded in
      // the same tx so the ledger can post immediately.
      .post(
        '/api/companies',
        requireCapability('settings:manage'),
        validator('json', (value, c) => {
          const parsed = companyCreateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const { name, businessType } = c.req.valid('json');
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const id = uuidv7();
          const [created] = await tx
            .insert(companies)
            .values({ id, accountId, name, businessType })
            .returning();
          if (!created) return c.json({ error: 'create_failed' }, 500);
          await seedChartOfAccounts(tx, { accountId, companyId: id, businessType });

          await c.var.audit({
            entityType: 'company',
            entityId: id,
            action: 'create',
            after: { name, businessType },
            companyId: id,
          });

          // Telemetry (opt-in; no-op unless the account enabled it). Only the
          // explicit multi-company create counts; the signup-seeded first
          // company predates any opt-in so it never reaches here.
          await emit(tx, { name: 'company_created' });

          // Same projection as GET /api/companies rows, so the web can switch to
          // the new company and slot it into the list without a refetch.
          return c.json(
            {
              id: created.id,
              name: created.name,
              businessType: created.businessType,
              accountingMethod: created.accountingMethod,
              depreciationConvention: created.depreciationConvention,
              vehicleExpenseMethod: created.vehicleExpenseMethod,
              timezone: created.timezone,
              remindersEnabled: created.remindersEnabled,
              reminderOffsets: created.reminderOffsets,
              businessAddress: created.businessAddress,
              businessPhone: created.businessPhone,
              businessEmail: created.businessEmail,
              replyToEmail: created.replyToEmail,
              showAddressOnInvoice: created.showAddressOnInvoice,
              showPhoneOnInvoice: created.showPhoneOnInvoice,
              showEmailOnInvoice: created.showEmailOnInvoice,
              showAddressOnEstimate: created.showAddressOnEstimate,
              showPhoneOnEstimate: created.showPhoneOnEstimate,
              showEmailOnEstimate: created.showEmailOnEstimate,
              ...paymentMethodsView(created),
            },
            201,
          );
        },
      )
      // Copy another company's setup into this one — contacts, price list, tax
      // rates, recurring schedules, email wording, business identity, logo.
      //
      // Reference data only, never history. What a business SELLS and who it
      // sells to survives it becoming a different legal entity; what a
      // particular taxpayer DID belongs to that taxpayer. Copying invoices or
      // expenses across would restate one business's history as another's.
      //
      // The whole thing is one transaction: a failure part way through leaves no
      // half-copied company. The target must be empty of reference data, so
      // there is never a question of which setup a row came from.
      .post('/api/companies/:id/copy-from', requireCapability('settings:manage'), async (c) => {
        const targetCompanyId = c.req.param('id');
        if (!UUID_RE.test(targetCompanyId)) return c.json({ error: 'invalid_id' }, 400);
        const body = await c.req.json().catch(() => null);
        const parsed = companyCopyRequestSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }
        const { sourceCompanyId } = parsed.data;
        const include = resolveCopyInclude(parsed.data.include);
        if (sourceCompanyId === targetCompanyId) {
          return c.json({ error: 'same_company' }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');

        // Both companies must be this account's. RLS pins account_id, so a
        // cross-ACCOUNT copy is impossible by construction; this is what stops a
        // cross-workspace id being smuggled in as the source.
        const found = await tx
          .select()
          .from(companies)
          .where(
            and(
              eq(companies.accountId, accountId),
              inArray(companies.id, [sourceCompanyId, targetCompanyId]),
            ),
          );
        const source = found.find((r) => r.id === sourceCompanyId);
        const target = found.find((r) => r.id === targetCompanyId);
        if (!source || !target) return c.json({ error: 'company_not_found' }, 404);

        const scope = { accountId, sourceCompanyId, targetCompanyId };
        if (!(await targetIsEmpty(tx, scope))) {
          return c.json({ error: 'target_not_empty' }, 409);
        }

        let result: CompanyCopyResult;
        try {
          result = await copyCompanyReferenceData(tx, scope, include);
        } catch (err) {
          if (err instanceof CopyTooLargeError) {
            return c.json({ error: 'too_many_rows', entity: err.entity, count: err.count }, 413);
          }
          throw err;
        }

        if (include.profile) {
          await tx
            .update(companies)
            .set({ ...copyableProfile(source), updatedAt: new Date() })
            .where(and(eq(companies.id, targetCompanyId), eq(companies.accountId, accountId)));
          result.profile = true;
        }

        // The logo is bytes, not a row. Its key embeds the company id, so the
        // string can't be shared — deleting either company's logo would break
        // the other's. Copied LAST and best-effort: storage is the one step that
        // can't participate in the transaction, so a failure here must not roll
        // back an otherwise-good copy. Same ordering discipline as the upload
        // route, where the storage write is the final await.
        if (include.branding && source.logoStorageKey && deps.storage) {
          const destKey = logoKeyFor(accountId, targetCompanyId, source.logoStorageKey);
          try {
            await deps.storage.copyObject(source.logoStorageKey, destKey);
            await tx
              .update(companies)
              .set({ logoStorageKey: destKey, updatedAt: new Date() })
              .where(and(eq(companies.id, targetCompanyId), eq(companies.accountId, accountId)));
            result.logo = true;
          } catch (err) {
            log.error('company copy: logo copy failed for {companyId}: {msg}', {
              companyId: targetCompanyId,
              msg: err instanceof Error ? err.message : String(err),
            });
          }
        }

        await c.var.audit({
          entityType: 'company',
          entityId: targetCompanyId,
          action: 'copy-from',
          after: { sourceCompanyId, ...result },
          companyId: targetCompanyId,
        });

        return c.json(result, 201);
      })
      // Retire / un-retire a company — a business that has stopped trading.
      //
      // NOT a delete: the books stay readable and reportable forever, because a
      // sole proprietor who incorporates still owes a final Schedule C for the
      // stub period. What retirement buys is that the ledger refuses NEW business
      // (lib/company-lock.ts) while still letting the company settle what it was
      // already owed — the customer paying an invoice it had already sent.
      .post('/api/companies/:id/retire', requireCapability('settings:manage'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id, name: companies.name, retiredAt: companies.retiredAt })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);
        if (company.retiredAt) return c.json({ error: 'already_retired' }, 409);

        // A workspace must always have somewhere to work. pickActiveCompany on
        // both clients contracts to return undefined only for an EMPTY list, and
        // every company-scoped screen treats that as "no company in this
        // workspace" — retiring the last one would strand the user in that state
        // with no way back.
        const [other] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(
            and(
              eq(companies.accountId, accountId),
              ne(companies.id, id),
              isNull(companies.retiredAt),
            ),
          )
          .limit(1);
        if (!other) return c.json({ error: 'last_active_company' }, 409);

        const retiredAt = new Date();
        await tx
          .update(companies)
          .set({ retiredAt, updatedAt: retiredAt })
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)));

        await c.var.audit({
          entityType: 'company',
          entityId: id,
          action: 'retire',
          before: { retiredAt: null },
          after: { retiredAt: retiredAt.toISOString() },
          companyId: id,
        });

        return c.json({ id, name: company.name, retiredAt: retiredAt.toISOString() });
      })
      .post('/api/companies/:id/unretire', requireCapability('settings:manage'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id, name: companies.name, retiredAt: companies.retiredAt })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);
        if (!company.retiredAt) return c.json({ error: 'not_retired' }, 409);

        await tx
          .update(companies)
          .set({ retiredAt: null, updatedAt: new Date() })
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)));

        await c.var.audit({
          entityType: 'company',
          entityId: id,
          action: 'unretire',
          before: { retiredAt: company.retiredAt.toISOString() },
          after: { retiredAt: null },
          companyId: id,
        });

        return c.json({ id, name: company.name, retiredAt: null });
      })
      // PATCH company — slice L3. Sparse semantics: only the keys present in
      // the body get written. Used by the post-signup business-type wizard
      // (sends { businessType, name? }) and any future rename surface from
      // settings. validator middleware lifts the json body into the typed
      // Input so hc<AppType>() sees `{ param, json }` on .$patch (same shape
      // as the customer/invoice PATCHes).
      .patch(
        '/api/companies/:id',
        requireCapability('settings:manage'),
        validator('json', (value, c) => {
          const parsed = companyUpdateSchema.safeParse(value);
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
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!before) return c.json({ error: 'company_not_found' }, 404);

          const patch: Record<string, unknown> = { updatedAt: new Date() };
          if (data.name !== undefined) patch.name = data.name;
          if (data.businessType !== undefined) patch.businessType = data.businessType;
          if (data.accountingMethod !== undefined) patch.accountingMethod = data.accountingMethod;
          if (data.depreciationConvention !== undefined)
            patch.depreciationConvention = data.depreciationConvention;
          if (data.vehicleExpenseMethod !== undefined)
            patch.vehicleExpenseMethod = data.vehicleExpenseMethod;
          if (data.timezone !== undefined) patch.timezone = data.timezone;
          // Automated reminders (TMC-189). Both sparse — the switch and the
          // schedule are edited independently, and turning reminders off must
          // not discard the schedule someone tuned.
          if (data.remindersEnabled !== undefined) patch.remindersEnabled = data.remindersEnabled;
          if (data.reminderOffsets !== undefined) patch.reminderOffsets = data.reminderOffsets;
          // Business identity — sparse + '' → null, same as replyToEmail below.
          if (data.businessAddress !== undefined) patch.businessAddress = data.businessAddress;
          if (data.businessPhone !== undefined) patch.businessPhone = data.businessPhone;
          if (data.businessEmail !== undefined) patch.businessEmail = data.businessEmail;
          // Per-field invoice-display defaults — plain booleans, sparse.
          if (data.showAddressOnInvoice !== undefined)
            patch.showAddressOnInvoice = data.showAddressOnInvoice;
          if (data.showPhoneOnInvoice !== undefined)
            patch.showPhoneOnInvoice = data.showPhoneOnInvoice;
          if (data.showEmailOnInvoice !== undefined)
            patch.showEmailOnInvoice = data.showEmailOnInvoice;
          if (data.showAddressOnEstimate !== undefined)
            patch.showAddressOnEstimate = data.showAddressOnEstimate;
          if (data.showPhoneOnEstimate !== undefined)
            patch.showPhoneOnEstimate = data.showPhoneOnEstimate;
          if (data.showEmailOnEstimate !== undefined)
            patch.showEmailOnEstimate = data.showEmailOnEstimate;
          // Validation coerces '' → null, so an explicit clear lands as null here.
          if (data.replyToEmail !== undefined) patch.replyToEmail = data.replyToEmail;
          // Offline payment instructions — same sparse + '' → null semantics.
          if (data.paymentCashEnabled !== undefined)
            patch.paymentCashEnabled = data.paymentCashEnabled;
          if (data.paymentCheckEnabled !== undefined)
            patch.paymentCheckEnabled = data.paymentCheckEnabled;
          if (data.paymentCheckPayableTo !== undefined)
            patch.paymentCheckPayableTo = data.paymentCheckPayableTo;
          if (data.paymentCheckAddress !== undefined)
            patch.paymentCheckAddress = data.paymentCheckAddress;
          if (data.paymentVenmoHandle !== undefined)
            patch.paymentVenmoHandle = data.paymentVenmoHandle;
          if (data.paymentZelleContact !== undefined)
            patch.paymentZelleContact = data.paymentZelleContact;

          const [after] = await tx
            .update(companies)
            .set(patch)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .returning();
          if (!after) return c.json({ error: 'company_not_found' }, 404);

          // Entity type changed — move the chart of accounts onto the return the
          // business now files (TMC-124). Two paths reach here: the welcome
          // wizard answering "what kind of business is this?" for a company whose
          // chart was seeded provisionally at signup (the common case — nothing
          // posted yet, so it converts cleanly), and an established business
          // changing type in settings after incorporating. Money never moves;
          // see reconcileChartOfAccounts for exactly what it will and won't
          // touch. Same tx as the company update, so a failure rolls both back
          // rather than leaving the type and the chart disagreeing.
          const chart =
            data.businessType !== undefined && after.businessType !== before.businessType
              ? await reconcileChartOfAccounts(tx, {
                  accountId,
                  companyId: id,
                  businessType: after.businessType,
                })
              : null;

          // Mirror the workspace (account) name to the business name for solo
          // workspaces. The account was seeded with the person's name at signup;
          // a single-company account IS that one business, so keep its label in
          // sync whenever the business is (re)named — this is what makes the
          // onboarding wizard's business name reach the Workspace switcher.
          // Multi-company accounts are left alone (no single business to mirror).
          if (data.name !== undefined && after.name !== before.name) {
            const [countRow] = await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(companies)
              .where(eq(companies.accountId, accountId));
            if (countRow?.n === 1) {
              await tx
                .update(accounts)
                .set({ name: after.name, updatedAt: new Date() })
                .where(eq(accounts.id, accountId));
            }
          }

          await c.var.audit({
            entityType: 'company',
            entityId: id,
            action: 'update',
            before: {
              name: before.name,
              businessType: before.businessType,
              accountingMethod: before.accountingMethod,
              depreciationConvention: before.depreciationConvention,
              vehicleExpenseMethod: before.vehicleExpenseMethod,
              timezone: before.timezone,
              remindersEnabled: before.remindersEnabled,
              reminderOffsets: before.reminderOffsets,
              businessAddress: before.businessAddress,
              businessPhone: before.businessPhone,
              businessEmail: before.businessEmail,
              replyToEmail: before.replyToEmail,
              showAddressOnInvoice: before.showAddressOnInvoice,
              showPhoneOnInvoice: before.showPhoneOnInvoice,
              showEmailOnInvoice: before.showEmailOnInvoice,
              showAddressOnEstimate: before.showAddressOnEstimate,
              showPhoneOnEstimate: before.showPhoneOnEstimate,
              showEmailOnEstimate: before.showEmailOnEstimate,
              ...paymentMethodsView(before),
            },
            after: {
              name: after.name,
              businessType: after.businessType,
              accountingMethod: after.accountingMethod,
              depreciationConvention: after.depreciationConvention,
              vehicleExpenseMethod: after.vehicleExpenseMethod,
              timezone: after.timezone,
              businessAddress: after.businessAddress,
              businessPhone: after.businessPhone,
              businessEmail: after.businessEmail,
              replyToEmail: after.replyToEmail,
              showAddressOnInvoice: after.showAddressOnInvoice,
              showPhoneOnInvoice: after.showPhoneOnInvoice,
              showEmailOnInvoice: after.showEmailOnInvoice,
              showAddressOnEstimate: after.showAddressOnEstimate,
              showPhoneOnEstimate: after.showPhoneOnEstimate,
              showEmailOnEstimate: after.showEmailOnEstimate,
              ...paymentMethodsView(after),
              // What re-mapping the chart actually did, when the entity type
              // changed. Recorded because it's the one company edit that
              // rewrites other rows — including the accounts it deliberately
              // left alone (keptName) because they already carry history.
              ...(chart ? { chartOfAccounts: chart } : {}),
            },
            companyId: id,
          });

          return c.json({
            id: after.id,
            name: after.name,
            businessType: after.businessType,
            accountingMethod: after.accountingMethod,
            depreciationConvention: after.depreciationConvention,
            vehicleExpenseMethod: after.vehicleExpenseMethod,
            timezone: after.timezone,
            businessAddress: after.businessAddress,
            businessPhone: after.businessPhone,
            businessEmail: after.businessEmail,
            replyToEmail: after.replyToEmail,
            showAddressOnInvoice: after.showAddressOnInvoice,
            showPhoneOnInvoice: after.showPhoneOnInvoice,
            showEmailOnInvoice: after.showEmailOnInvoice,
            showAddressOnEstimate: after.showAddressOnEstimate,
            showPhoneOnEstimate: after.showPhoneOnEstimate,
            showEmailOnEstimate: after.showEmailOnEstimate,
            ...paymentMethodsView(after),
          });
        },
      )
      // ---- Per-company email templates ------------------------------------
      // The customer-facing emails (invoice/estimate/statement) a business can
      // customize. An override row exists only when customized; otherwise the
      // in-code default (DEFAULT_TEMPLATES) is returned + sent. Editable surface
      // is subject + body prose with {{placeholders}}; the HTML chrome stays
      // ours. GET is ungated (a read); writes are settings:manage.
      .get('/api/companies/:id/email-templates', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        const overrides = await tx
          .select({
            type: emailTemplates.type,
            subject: emailTemplates.subject,
            body: emailTemplates.body,
            updatedAt: emailTemplates.updatedAt,
          })
          .from(emailTemplates)
          .where(and(eq(emailTemplates.companyId, id), eq(emailTemplates.accountId, accountId)));
        const byType = new Map(overrides.map((o) => [o.type, o]));

        const templates = EMAIL_TEMPLATE_TYPES.map((type) => {
          const override = byType.get(type);
          const def = DEFAULT_TEMPLATES[type];
          return {
            type,
            subject: override?.subject ?? def.subject,
            body: override?.body ?? def.body,
            isCustomized: Boolean(override),
            updatedAt: override?.updatedAt ?? null,
            placeholders: EMAIL_TEMPLATE_PLACEHOLDERS[type],
            defaultTemplate: def,
          };
        });
        // Whether this deployment can actually deliver any of them. Rides the
        // email payload for the same reason `stripeConfigured` rides the
        // payments-status payload: it is the one screen where the answer
        // changes what the operator should do. Without it, Settings → Email
        // invites someone to fine-tune the wording of messages that are going
        // to stdout (TMC-212).
        return c.json({ templates, emailConfigured: mailerDelivers(deps.mailer) });
      })
      .put(
        '/api/companies/:id/email-templates/:type',
        requireCapability('settings:manage'),
        validator('json', (value, c) => {
          const parsed = emailTemplateUpdateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const typeParsed = emailTemplateTypeSchema.safeParse(c.req.param('type'));
          if (!typeParsed.success) return c.json({ error: 'invalid_type' }, 400);
          const type = typeParsed.data;
          const { subject, body } = c.req.valid('json');

          // Reject any {{token}} not valid for this type so a typo never ships
          // as literal text to a customer (the editor validates the same way).
          const bad = unknownPlaceholders(type, subject, body);
          if (bad.length) return c.json({ error: 'unknown_placeholders', placeholders: bad }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const [before] = await tx
            .select({ subject: emailTemplates.subject, body: emailTemplates.body })
            .from(emailTemplates)
            .where(
              and(
                eq(emailTemplates.companyId, id),
                eq(emailTemplates.accountId, accountId),
                eq(emailTemplates.type, type),
              ),
            )
            .limit(1);

          const now = new Date();
          const [after] = await tx
            .insert(emailTemplates)
            .values({
              id: uuidv7(),
              accountId,
              companyId: id,
              type,
              subject,
              body,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [emailTemplates.companyId, emailTemplates.type],
              set: { subject, body, updatedAt: now },
            })
            .returning({
              subject: emailTemplates.subject,
              body: emailTemplates.body,
              updatedAt: emailTemplates.updatedAt,
            });
          if (!after) return c.json({ error: 'email_template_write_failed' }, 500);

          await c.var.audit({
            entityType: 'email-template',
            entityId: id,
            action: before ? 'update' : 'create',
            before: before ? { type, subject: before.subject, body: before.body } : { type },
            after: { type, subject: after.subject, body: after.body },
            companyId: id,
          });

          return c.json({
            type,
            subject: after.subject,
            body: after.body,
            isCustomized: true,
            updatedAt: after.updatedAt,
            placeholders: EMAIL_TEMPLATE_PLACEHOLDERS[type],
            defaultTemplate: DEFAULT_TEMPLATES[type],
          });
        },
      )
      // Reset to default = drop the override row. Idempotent: resetting an
      // already-default template is a 200 no-op echoing the default back.
      .delete(
        '/api/companies/:id/email-templates/:type',
        requireCapability('settings:manage'),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const typeParsed = emailTemplateTypeSchema.safeParse(c.req.param('type'));
          if (!typeParsed.success) return c.json({ error: 'invalid_type' }, 400);
          const type = typeParsed.data;
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [deleted] = await tx
            .delete(emailTemplates)
            .where(
              and(
                eq(emailTemplates.companyId, id),
                eq(emailTemplates.accountId, accountId),
                eq(emailTemplates.type, type),
              ),
            )
            .returning({ subject: emailTemplates.subject, body: emailTemplates.body });

          if (deleted) {
            await c.var.audit({
              entityType: 'email-template',
              entityId: id,
              action: 'reset',
              before: { type, subject: deleted.subject, body: deleted.body },
              after: { type },
              companyId: id,
            });
          }

          const def = DEFAULT_TEMPLATES[type];
          return c.json({
            type,
            subject: def.subject,
            body: def.body,
            isCustomized: false,
            updatedAt: null,
            placeholders: EMAIL_TEMPLATE_PLACEHOLDERS[type],
            defaultTemplate: def,
          });
        },
      )
      // Render a candidate (unsaved) template against sample data with the real
      // builders, so the editor preview is exactly what a customer receives.
      .post(
        '/api/companies/:id/email-templates/:type/preview',
        requireCapability('settings:manage'),
        validator('json', (value, c) => {
          const parsed = emailTemplateUpdateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const typeParsed = emailTemplateTypeSchema.safeParse(c.req.param('type'));
          if (!typeParsed.success) return c.json({ error: 'invalid_type' }, 400);
          const type = typeParsed.data;
          const { subject, body } = c.req.valid('json');
          const bad = unknownPlaceholders(type, subject, body);
          if (bad.length) return c.json({ error: 'unknown_placeholders', placeholders: bad }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const [company] = await tx
            .select({ name: companies.name })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          return c.json(
            buildEmailPreview(
              type,
              { subject, body },
              company.name ?? 'Your business',
              deps.publicAppUrl,
            ),
          );
        },
      )
      // ---- Company logo (shown on invoices) -------------------------------
      // Same upload/serve/delete shape as the expense receipt: multipart in,
      // a time-limited signed URL out, object write/delete as the LAST await so
      // a storage failure rolls the column change back. Raster-only, ≤2MB.
      .post('/api/companies/:id/logo', requireCapability('settings:manage'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        if (!deps.storage) return c.json({ error: 'storage_not_configured' }, 503);

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [company] = await tx
          .select()
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        const body = await c.req.parseBody();
        const file = body.file;
        if (!(file instanceof File)) return c.json({ error: 'file_required' }, 400);
        const ext = LOGO_MIME_EXT[file.type];
        if (!ext) {
          return c.json(
            { error: 'unsupported_media_type', allowed: Object.keys(LOGO_MIME_EXT) },
            415,
          );
        }
        if (file.size > LOGO_MAX_BYTES) {
          return c.json({ error: 'file_too_large', maxBytes: LOGO_MAX_BYTES }, 413);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());

        // Re-upload overwrites the column with a fresh key; the prior object is
        // left orphaned (rare, harmless — keys are uuidv7 so no collision).
        const key = `accounts/${accountId}/companies/${id}/branding/${uuidv7()}.${ext}`;

        const [updated] = await tx
          .update(companies)
          .set({ logoStorageKey: key, updatedAt: new Date() })
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .returning();
        if (!updated) return c.json({ error: 'company_not_found' }, 404);

        await c.var.audit({
          entityType: 'company',
          entityId: id,
          action: 'logo-upload',
          before: { logoStorageKey: company.logoStorageKey },
          after: { logoStorageKey: key },
          companyId: id,
        });

        await deps.storage.putObject({ key, body: bytes, contentType: file.type });

        return c.json({ id, logoStorageKey: key }, 201);
      })
      // 1-hour signed download URL for the authed settings preview. For s3 it's
      // a presigned object-store URL; for local-FS a relative /api/files/<token>.
      .get('/api/companies/:id/logo', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        if (!deps.storage) return c.json({ error: 'storage_not_configured' }, 503);

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [company] = await tx
          .select({ logoStorageKey: companies.logoStorageKey })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);
        if (!company.logoStorageKey) return c.json({ error: 'no_logo' }, 404);

        const url = await deps.storage.getSignedDownloadUrl(company.logoStorageKey, {
          expiresInSeconds: 3600,
        });
        return c.json({ url, contentType: mimeForKey(company.logoStorageKey) });
      })
      // Remove the logo: null the column + audit, then drop the object as the
      // LAST await so a storage failure rolls the nulling back. Idempotent.
      .delete('/api/companies/:id/logo', requireCapability('settings:manage'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        if (!deps.storage) return c.json({ error: 'storage_not_configured' }, 503);

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [company] = await tx
          .select({ logoStorageKey: companies.logoStorageKey })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);
        if (!company.logoStorageKey) return c.json({ ok: true });

        const key = company.logoStorageKey;
        await tx
          .update(companies)
          .set({ logoStorageKey: null, updatedAt: new Date() })
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)));

        await c.var.audit({
          entityType: 'company',
          entityId: id,
          action: 'logo-remove',
          before: { logoStorageKey: key },
          after: { logoStorageKey: null },
          companyId: id,
        });

        await deps.storage.deleteObject(key);
        return c.json({ ok: true });
      })
      // Stripe Connect onboarding — kicks off (or refreshes) the Stripe-hosted
      // onboarding flow for SaaS multi-tenant payment routing. Lazily creates
      // an Express connected account on first call, stamps its id on the
      // company, and mints an Account Link the client redirects to. Idempotent
      // — subsequent calls reuse the stored acct_xxx and just mint a fresh
      // link (the previous one will have expired or been consumed). The
      // payment-intent minter at /api/public/invoices/:token/payment-intent
      // routes the charge to this connected account via the stripeAccount
      // request option (direct charge).
      .post(
        '/api/companies/:id/stripe-connect/onboard',
        requireCapability('settings:manage'),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          if (!deps.stripe) return c.json({ error: 'stripe_not_configured' }, 503);
          if (!deps.publicAppUrl) return c.json({ error: 'public_url_not_configured' }, 503);

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select()
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          let connectAccountId = company.stripeConnectAccountId;
          if (!connectAccountId) {
            // Idempotency key on the Stripe call guards against double-click
            // racing two concurrent POSTs through both branches before either
            // UPDATE wins. Stripe returns the same account id on retry rather
            // than creating a second one.
            const created = await deps.stripe.client.accounts.create(
              {
                type: 'express',
                country: 'US',
                capabilities: {
                  card_payments: { requested: true },
                  transfers: { requested: true },
                },
                business_profile: { name: company.name },
                // Stamp the tenant identity onto the Stripe-side account so an
                // orphaned acct_xxx (e.g. its company row was deleted) can be
                // reconciled back via accounts.list metadata. The mapping
                // normally lives only in companies.stripeConnectAccountId; this
                // is the recovery handle the SaaS layer keys re-linking off.
                metadata: { company_id: id, account_id: accountId },
              },
              { idempotencyKey: `company-${id}-create-account` },
            );
            connectAccountId = created.id;
            const now = new Date();
            await tx
              .update(companies)
              .set({ stripeConnectAccountId: connectAccountId, updatedAt: now })
              .where(and(eq(companies.id, id), eq(companies.accountId, accountId)));
            await c.var.audit({
              entityType: 'company',
              entityId: id,
              action: 'stripe-connect-create',
              before: { stripeConnectAccountId: null },
              after: { stripeConnectAccountId: connectAccountId },
              companyId: id,
            });
          }

          const link = await deps.stripe.client.accountLinks.create({
            account: connectAccountId,
            refresh_url: `${deps.publicAppUrl}/settings/payments?stripe=refresh`,
            return_url: `${deps.publicAppUrl}/settings/payments?stripe=return`,
            type: 'account_onboarding',
          });

          return c.json({ url: link.url, accountId: connectAccountId });
        },
      )
      // Current state of the Connect onboarding for this company. The web
      // /settings/payments page polls this on the ?stripe=return landing so
      // it can resolve "submitted, waiting on Stripe verification" vs
      // "charges enabled" without forcing another round-trip to Stripe.
      // The flags are kept fresh by the account.updated webhook branch.
      .get('/api/companies/:id/stripe-connect/status', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({
            stripeConnectAccountId: companies.stripeConnectAccountId,
            stripeConnectChargesEnabled: companies.stripeConnectChargesEnabled,
            stripeConnectDetailsSubmitted: companies.stripeConnectDetailsSubmitted,
          })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        // Same helper the public invoice page routes on, so what the owner is
        // told and what their customer can actually do cannot drift.
        const { connectPending } = connectState({
          requireConnectedAccount: deps.requireConnectedAccount === true,
          stripeConfigured: deps.stripe != null,
          connectAccountId: company.stripeConnectAccountId,
          chargesEnabled: company.stripeConnectChargesEnabled,
        });

        return c.json({
          stripeConfigured: deps.stripe != null,
          stripeConnectAccountId: company.stripeConnectAccountId,
          stripeConnectChargesEnabled: company.stripeConnectChargesEnabled,
          stripeConnectDetailsSubmitted: company.stripeConnectDetailsSubmitted,
          // Onboarding started-but-unfinished, or required-and-absent: this
          // company's invoices cannot be paid by card. The owner sees this;
          // the recipient never does.
          connectPending,
        });
      })
      // Slice L4 — GL / trial-balance export. Tenant-scoped read of every
      // journal entry for a company, joined with its COA so the export
      // carries account code + name. Optional from/to date filter (inclusive
      // calendar days; to+1 day on the upper bound). format=json (default)
      // or csv. No pagination in MVP — exports are bulk reads.
      //
      // Single join query (entries × lines × COA) groups in app code so the
      // typed shape on the wire matches what an accountant expects: each
      // entry with its lines nested. Trial balance is computed alongside in
      // a single pass to keep the contract one round-trip.
      .get('/api/companies/:id/ledger/export', requireCapability('reports:export'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        const fromRaw = c.req.query('from');
        const toRaw = c.req.query('to');
        const format = c.req.query('format') ?? 'json';
        if (format !== 'json' && format !== 'csv') {
          return c.json({ error: 'invalid_format' }, 400);
        }

        // Date parse: ISO yyyy-mm-dd. Reject non-parseable + flipped ranges
        // (from > to) so the caller catches an off-by-one rather than seeing
        // an empty file and assuming "no activity".
        let fromDate: Date | null = null;
        let toDate: Date | null = null;
        if (fromRaw !== undefined) {
          const d = new Date(`${fromRaw}T00:00:00Z`);
          if (Number.isNaN(d.getTime())) return c.json({ error: 'invalid_from' }, 400);
          fromDate = d;
        }
        if (toRaw !== undefined) {
          const d = new Date(`${toRaw}T00:00:00Z`);
          if (Number.isNaN(d.getTime())) return c.json({ error: 'invalid_to' }, 400);
          // Upper bound is exclusive on (to + 1 day) so to=YYYY-MM-DD pulls in
          // entries posted any time on that day.
          d.setUTCDate(d.getUTCDate() + 1);
          toDate = d;
        }
        if (fromDate && toDate && fromDate >= toDate) {
          return c.json({ error: 'invalid_range' }, 400);
        }

        const whereClauses = [
          eq(journalEntries.companyId, id),
          eq(journalEntries.accountId, accountId),
        ];
        if (fromDate) whereClauses.push(gte(journalEntries.postedAt, fromDate));
        if (toDate) whereClauses.push(lt(journalEntries.postedAt, toDate));

        const rows = await tx
          .select({
            entryId: journalEntries.id,
            postedAt: journalEntries.postedAt,
            sourceEntityType: journalEntries.sourceEntityType,
            sourceEntityId: journalEntries.sourceEntityId,
            memo: journalEntries.memo,
            lineId: journalLines.id,
            side: journalLines.side,
            amount: journalLines.amount,
            code: chartOfAccounts.code,
            accountName: chartOfAccounts.name,
            accountType: chartOfAccounts.accountType,
          })
          .from(journalEntries)
          .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
          .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
          .where(and(...whereClauses))
          .orderBy(asc(journalEntries.postedAt), asc(journalEntries.id), asc(journalLines.id));

        type Line = {
          code: string;
          accountName: string;
          accountType: string;
          side: 'debit' | 'credit';
          amount: string;
        };
        type Entry = {
          id: string;
          postedAt: string;
          sourceEntityType: string;
          sourceEntityId: string;
          memo: string | null;
          lines: Line[];
        };

        const entries: Entry[] = [];
        const byEntry = new Map<string, Entry>();
        const tbByCode = new Map<
          string,
          {
            code: string;
            accountName: string;
            accountType: string;
            debitCents: number;
            creditCents: number;
          }
        >();

        for (const r of rows) {
          let e = byEntry.get(r.entryId);
          if (!e) {
            e = {
              id: r.entryId,
              postedAt: r.postedAt.toISOString(),
              sourceEntityType: r.sourceEntityType,
              sourceEntityId: r.sourceEntityId,
              memo: r.memo,
              lines: [],
            };
            byEntry.set(r.entryId, e);
            entries.push(e);
          }
          e.lines.push({
            code: r.code,
            accountName: r.accountName,
            accountType: r.accountType,
            side: r.side as 'debit' | 'credit',
            amount: r.amount,
          });
          let tb = tbByCode.get(r.code);
          if (!tb) {
            tb = {
              code: r.code,
              accountName: r.accountName,
              accountType: r.accountType,
              debitCents: 0,
              creditCents: 0,
            };
            tbByCode.set(r.code, tb);
          }
          // Accumulate in integer cents so a big trial balance can't drift a cent.
          if (r.side === 'debit') tb.debitCents += toCents(r.amount);
          else tb.creditCents += toCents(r.amount);
        }

        const trialBalance = Array.from(tbByCode.values())
          .map((t) => ({
            code: t.code,
            accountName: t.accountName,
            accountType: t.accountType,
            debit: centsToMoney(t.debitCents),
            credit: centsToMoney(t.creditCents),
            net: centsToMoney(t.debitCents - t.creditCents),
          }))
          .sort((a, b) => (a.code < b.code ? -1 : 1));

        if (format === 'csv') {
          const csvCell = (v: string | null) => {
            const s = v ?? '';
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          };
          const header =
            'posted_at,entry_id,code,account_name,side,amount,source_type,source_id,memo';
          const lines = [header];
          for (const e of entries) {
            for (const l of e.lines) {
              lines.push(
                [
                  e.postedAt,
                  e.id,
                  l.code,
                  csvCell(l.accountName),
                  l.side,
                  l.amount,
                  e.sourceEntityType,
                  e.sourceEntityId,
                  csvCell(e.memo),
                ].join(','),
              );
            }
          }
          return c.body(`${lines.join('\n')}\n`, 200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="ledger-${company.name.replace(
              /[^a-z0-9-]/gi,
              '_',
            )}.csv"`,
          });
        }

        return c.json({
          companyId: company.id,
          companyName: company.name,
          from: fromRaw ?? null,
          to: toRaw ?? null,
          entries,
          trialBalance,
        });
      })
      // Read the company's chart of accounts. Powers the expense form's
      // category (type=expense) + payment (type=asset) comboboxes (slice
      // 8.9e) and the expense list's category filter (8.9d). Active rows
      // only, ordered by code so the UI renders them in the standard COA
      // sequence (assets → … → expenses, Schedule C order within 6000–7950).
      // Optional ?type= narrows to one account_type; unknown values just
      // return an empty set.
      .get(
        '/api/companies/:id/accounts',
        // Query validator so the typed hc<AppType>() client can pass
        // `{ query: { type } }` — a path-param route types its Input as
        // `{ param }` and rejects an untyped query without this (same reason
        // the PATCH endpoints carry a json validator).
        validator('query', (v) => ({
          type: typeof v.type === 'string' ? v.type : undefined,
        })),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, id), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          const { type } = c.req.valid('query');
          const conditions = [
            eq(chartOfAccounts.accountId, accountId),
            eq(chartOfAccounts.companyId, id),
            eq(chartOfAccounts.isActive, true),
          ];
          if (type) conditions.push(eq(chartOfAccounts.accountType, type));

          const accounts = await tx
            .select({
              id: chartOfAccounts.id,
              code: chartOfAccounts.code,
              name: chartOfAccounts.name,
              accountType: chartOfAccounts.accountType,
              normalBalance: chartOfAccounts.normalBalance,
            })
            .from(chartOfAccounts)
            .where(and(...conditions))
            .orderBy(asc(chartOfAccounts.code));

          return c.json({ accounts });
        },
      )
  );
}

export type CompaniesAppType = ReturnType<typeof companiesRoutes>;
