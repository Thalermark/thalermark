import { companies, taxPolicies } from '@thalermark/db';
import { taxPolicyCreateSchema, taxPolicyUpdateSchema } from '@thalermark/validation';
import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import { UUID_RE } from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// Tax-policy archive/restore — same idempotent, audit-on-change transition as
// items (policies archive rather than hard-delete so the tax_policy_id
// breadcrumbs on historical lines never dangle). Archiving the company's
// default policy also clears its is_default flag so the picker doesn't keep
// offering a hidden default.
async function setTaxPolicyArchived(
  c: Context<{ Variables: RlsVariables }>,
  id: string,
  archived: boolean,
) {
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
  const tx = c.get('tx');
  const accountId = c.get('accountId');

  const [current] = await tx
    .select()
    .from(taxPolicies)
    .where(and(eq(taxPolicies.id, id), eq(taxPolicies.accountId, accountId)))
    .limit(1);
  if (!current) return c.json({ error: 'tax_policy_not_found' }, 404);

  const isArchived = current.archivedAt !== null;
  if (isArchived === archived) return c.json(current);

  const now = new Date();
  const [updated] = await tx
    .update(taxPolicies)
    .set({
      archivedAt: archived ? now : null,
      // An archived policy can't remain the default.
      isDefault: archived ? false : current.isDefault,
      updatedAt: now,
    })
    .where(and(eq(taxPolicies.id, id), eq(taxPolicies.accountId, accountId)))
    .returning();
  if (!updated) return c.json({ error: 'tax_policy_not_found' }, 404);

  await c.var.audit({
    entityType: 'tax_policy',
    entityId: id,
    action: archived ? 'archive' : 'restore',
    before: { archivedAt: current.archivedAt, isDefault: current.isDefault },
    after: { archivedAt: updated.archivedAt, isDefault: updated.isDefault },
    companyId: updated.companyId,
  });

  return c.json(updated);
}

// Tax policies — per-company named sales-tax rates that items + invoice lines
// reference. A self-contained per-domain sub-app (see app.ts for the
// modular-sub-apps rationale + the TS7056 ceiling it dodges); the inferred type
// threads through TaxPoliciesAppType for hc<TaxPoliciesAppType>() clients. The
// parent cors + rlsContext middleware runs for these paths (mounted after them
// in createApp), so c.get('tx') / c.get('accountId') / c.var.audit are populated.
export function taxPoliciesRoutes() {
  return (
    new Hono<{ Variables: RlsVariables }>()
      // A settings-management surface (not sales:write) since it's company
      // configuration, not day-to-day selling. Archive rather than hard-delete
      // so the tax_policy_id breadcrumbs on historical lines survive.
      .post('/api/tax-policies', requireCapability('settings:manage'), async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = taxPolicyCreateSchema.safeParse(body);
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

        // Single default per company: marking this one default clears the flag
        // on every other policy in the company first.
        if (parsed.data.isDefault) {
          await tx
            .update(taxPolicies)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(
              and(
                eq(taxPolicies.accountId, accountId),
                eq(taxPolicies.companyId, parsed.data.companyId),
              ),
            );
        }

        const id = uuidv7();
        const row = { id, accountId, ...parsed.data };
        await tx.insert(taxPolicies).values(row);
        await c.var.audit({
          entityType: 'tax_policy',
          entityId: id,
          action: 'create',
          after: row,
          companyId: parsed.data.companyId,
        });

        return c.json(row, 201);
      })
      // List for the settings surface and the item / line tax-policy pickers.
      // Archived policies are hidden by default (the picker must never offer
      // them); the management page passes includeArchived=true. Alphabetical
      // keyset pagination by name, matching items.
      .get('/api/tax-policies', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const includeArchived = c.req.query('includeArchived') === 'true';

        const conditions = [eq(taxPolicies.accountId, accountId)];
        if (companyId) conditions.push(eq(taxPolicies.companyId, companyId));
        if (!includeArchived) conditions.push(isNull(taxPolicies.archivedAt));

        const limit = parseLimit(c.req.query('limit'));
        if (limit === null) return c.json({ error: 'invalid_limit' }, 400);
        const keys = [{ col: taxPolicies.name }, { col: taxPolicies.id }];
        const keyset = applyCursor(c.req.query('cursor'), keys, 'asc');
        if (keyset === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);
        if (keyset) conditions.push(keyset);
        const rows = await tx
          .select()
          .from(taxPolicies)
          .where(and(...conditions))
          .orderBy(keysetOrderBy(keys, 'asc'))
          .limit(limit + 1);
        const page = slicePage(rows, limit, (r) => [r.name, r.id]);
        return c.json({ taxPolicies: page.rows, nextCursor: page.nextCursor });
      })
      .get('/api/tax-policies/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [row] = await tx
          .select()
          .from(taxPolicies)
          .where(and(eq(taxPolicies.id, id), eq(taxPolicies.accountId, accountId)));
        if (!row) return c.json({ error: 'tax_policy_not_found' }, 404);
        return c.json(row);
      })
      .patch(
        '/api/tax-policies/:id',
        requireCapability('settings:manage'),
        validator('json', (value, c) => {
          const parsed = taxPolicyUpdateSchema.safeParse(value);
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
            .from(taxPolicies)
            .where(and(eq(taxPolicies.id, id), eq(taxPolicies.accountId, accountId)))
            .limit(1);
          if (!before) return c.json({ error: 'tax_policy_not_found' }, 404);

          const now = new Date();
          // Single default per company — clear the others first (this row
          // included), then the patch below sets this one back to default.
          if (data.isDefault) {
            await tx
              .update(taxPolicies)
              .set({ isDefault: false, updatedAt: now })
              .where(
                and(
                  eq(taxPolicies.accountId, accountId),
                  eq(taxPolicies.companyId, before.companyId),
                ),
              );
          }

          // Full-replacement like items — omitted optionals collapse to their
          // column default. archived_at is owned by archive/restore.
          const patch = {
            name: data.name,
            ratePct: data.ratePct ?? '0',
            isDefault: data.isDefault ?? false,
            updatedAt: now,
          };
          const [after] = await tx
            .update(taxPolicies)
            .set(patch)
            .where(and(eq(taxPolicies.id, id), eq(taxPolicies.accountId, accountId)))
            .returning();
          if (!after) return c.json({ error: 'tax_policy_not_found' }, 404);

          await c.var.audit({
            entityType: 'tax_policy',
            entityId: id,
            action: 'update',
            before,
            after,
            companyId: before.companyId,
          });

          return c.json(after);
        },
      )
      .post('/api/tax-policies/:id/archive', requireCapability('settings:manage'), (c) =>
        setTaxPolicyArchived(c, c.req.param('id'), true),
      )
      .post('/api/tax-policies/:id/restore', requireCapability('settings:manage'), (c) =>
        setTaxPolicyArchived(c, c.req.param('id'), false),
      )
  );
}

export type TaxPoliciesAppType = ReturnType<typeof taxPoliciesRoutes>;
