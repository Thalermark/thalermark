import { companies, items } from '@thalermark/db';
import { itemCreateSchema, itemImportSchema, itemUpdateSchema } from '@thalermark/validation';
import { and, asc, eq, ilike, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import { UUID_RE, escapeLike } from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// Items catalog archive/restore — an idempotent, audit-on-change transition.
// Items archive rather than hard-delete so the top-products report (which joins
// invoice_line_items.source_item_id back to items) never loses history.
async function setItemArchived(
  c: Context<{ Variables: RlsVariables }>,
  id: string,
  archived: boolean,
) {
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
  const tx = c.get('tx');
  const accountId = c.get('accountId');

  const [current] = await tx
    .select()
    .from(items)
    .where(and(eq(items.id, id), eq(items.accountId, accountId)))
    .limit(1);
  if (!current) return c.json({ error: 'item_not_found' }, 404);

  const isArchived = current.archivedAt !== null;
  if (isArchived === archived) return c.json(current);

  const now = new Date();
  const [updated] = await tx
    .update(items)
    .set({ archivedAt: archived ? now : null, updatedAt: now })
    .where(and(eq(items.id, id), eq(items.accountId, accountId)))
    .returning();
  if (!updated) return c.json({ error: 'item_not_found' }, 404);

  await c.var.audit({
    entityType: 'item',
    entityId: id,
    action: archived ? 'archive' : 'restore',
    before: { archivedAt: current.archivedAt },
    after: { archivedAt: updated.archivedAt },
    companyId: updated.companyId,
  });

  return c.json(updated);
}

// Items catalog (products & services) — a self-contained per-domain sub-app
// (see app.ts for the modular-sub-apps rationale + the TS7056 ceiling it
// dodges). Routes are chained so the inferred type threads through ItemsAppType
// for hc<ItemsAppType>() clients. The parent cors + rlsContext middleware runs
// for these paths (this sub-app is mounted after them in createApp), so
// c.get('tx') / c.get('accountId') / c.var.audit are populated.
export function itemsRoutes() {
  return (
    new Hono<{ Variables: RlsVariables }>()
      // Items catalog (products & services) — per-company reusable line items.
      // Mirrors contacts: full CRUD within the tenant, but items archive
      // rather than hard-delete (archive/restore transitions below) so the
      // top-products report never loses history.
      .post('/api/items', requireCapability('sales:write'), async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = itemCreateSchema.safeParse(body);
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
        await tx.insert(items).values(row);
        await c.var.audit({
          entityType: 'item',
          entityId: id,
          action: 'create',
          after: row,
          companyId: parsed.data.companyId,
        });

        return c.json(row, 201);
      })
      // Bulk CSV import (web) — mirrors /api/contacts/import. Registered before
      // /api/items/:id so first-match doesn't capture "import" as an :id. Atomic:
      // the whole batch validates (itemImportSchema) before any row inserts.
      .post('/api/items/import', requireCapability('sales:write'), async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = itemImportSchema.safeParse(body);
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

        // `archived` is an import-only boolean (the catalog round-trips its
        // archived state); translate it to the archived_at timestamp the table
        // actually stores. Omitted/false → null (active).
        const rows = parsed.data.rows.map(({ archived, ...r }) => ({
          id: uuidv7(),
          accountId,
          companyId,
          ...r,
          archivedAt: archived ? new Date() : null,
        }));
        await tx.insert(items).values(rows);
        for (const row of rows) {
          await c.var.audit({
            entityType: 'item',
            entityId: row.id,
            action: 'create',
            after: row,
            companyId,
          });
        }

        return c.json({ created: rows.length }, 201);
      })
      // List for both the management surface and the line-item autocomplete.
      // Archived items are hidden by default (the picker must never offer them);
      // the management page passes includeArchived=true for its show-archived
      // toggle. `q` is a contains-search on name backing the type-ahead — capped
      // so the autocomplete stays cheap; escapeLike neutralises %/_ wildcards.
      .get('/api/items', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const q = c.req.query('q');
        const includeArchived = c.req.query('includeArchived') === 'true';

        const conditions = [eq(items.accountId, accountId)];
        if (companyId) conditions.push(eq(items.companyId, companyId));
        if (!includeArchived) conditions.push(isNull(items.archivedAt));
        if (q) conditions.push(ilike(items.name, `%${escapeLike(q)}%`));

        // Typeahead (?q=) keeps its capped, unpaginated behavior. List mode
        // paginates the catalog alphabetically (name + id tiebreak, asc).
        if (q) {
          const rows = await tx
            .select()
            .from(items)
            .where(and(...conditions))
            .orderBy(asc(items.name))
            .limit(20);
          return c.json({ items: rows, nextCursor: null });
        }
        const limit = parseLimit(c.req.query('limit'));
        if (limit === null) return c.json({ error: 'invalid_limit' }, 400);
        const keys = [{ col: items.name }, { col: items.id }];
        const keyset = applyCursor(c.req.query('cursor'), keys, 'asc');
        if (keyset === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);
        if (keyset) conditions.push(keyset);
        const rows = await tx
          .select()
          .from(items)
          .where(and(...conditions))
          .orderBy(keysetOrderBy(keys, 'asc'))
          .limit(limit + 1);
        const page = slicePage(rows, limit, (r) => [r.name, r.id]);
        return c.json({ items: page.rows, nextCursor: page.nextCursor });
      })
      .get('/api/items/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const [row] = await tx
          .select()
          .from(items)
          .where(and(eq(items.id, id), eq(items.accountId, accountId)));
        if (!row) return c.json({ error: 'item_not_found' }, 404);
        return c.json(row);
      })
      .patch(
        '/api/items/:id',
        requireCapability('sales:write'),
        validator('json', (value, c) => {
          const parsed = itemUpdateSchema.safeParse(value);
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
            .from(items)
            .where(and(eq(items.id, id), eq(items.accountId, accountId)))
            .limit(1);
          if (!before) return c.json({ error: 'item_not_found' }, 404);

          // Full-replacement semantics like contacts — omitted optionals
          // collapse to their column default (null, or '0' / '1' for the money
          // / quantity columns). archived_at is owned by archive/restore, not
          // touched here, so editing an archived item keeps it archived.
          const patch = {
            name: data.name,
            description: data.description ?? null,
            type: data.type ?? 'service',
            unitPrice: data.unitPrice ?? '0',
            unitLabel: data.unitLabel ?? null,
            defaultQuantity: data.defaultQuantity ?? '1',
            taxable: data.taxable ?? false,
            taxPolicyId: data.taxPolicyId ?? null,
            updatedAt: new Date(),
          };
          const [after] = await tx
            .update(items)
            .set(patch)
            .where(and(eq(items.id, id), eq(items.accountId, accountId)))
            .returning();
          if (!after) return c.json({ error: 'item_not_found' }, 404);

          await c.var.audit({
            entityType: 'item',
            entityId: id,
            action: 'update',
            before,
            after,
            companyId: before.companyId,
          });

          return c.json(after);
        },
      )
      .post('/api/items/:id/archive', requireCapability('sales:write'), (c) =>
        setItemArchived(c, c.req.param('id'), true),
      )
      .post('/api/items/:id/restore', requireCapability('sales:write'), (c) =>
        setItemArchived(c, c.req.param('id'), false),
      )
  );
}

export type ItemsAppType = ReturnType<typeof itemsRoutes>;
