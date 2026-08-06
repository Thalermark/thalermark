import { companies, contacts, invoices, jobs, timeEntries } from '@thalermark/db';
import {
  centsToMoney,
  jobCreateSchema,
  jobUpdateSchema,
  timeEntryCreateSchema,
  timeEntryUpdateSchema,
} from '@thalermark/validation';
import { and, asc, desc, eq, getTableColumns, ilike, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import {
  displayHours,
  effectiveHourly,
  jobBilledCents,
  jobCostCents,
  jobMinutes,
} from '../lib/job-costing.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import { UUID_RE, escapeLike } from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// Jobs and time entries (TMC-181, TMC-180) — a self-contained per-domain
// sub-app, same shape as the others (see app.ts for the modular-sub-apps
// rationale).
//
// A job is the unit of work the user names, and it exists from the moment work
// starts rather than from the moment an invoice does. That ordering is the whole
// reason the entity exists: tracked time has nowhere to attach otherwise,
// because the invoice is the OUTPUT of the hours.
//
// Nothing here posts to the ledger. Both tables are a tag layer over invoices
// and expenses; drop them and the books, taxes and invoices are untouched.
//
// Gated on sales:write throughout, matching invoices and the items catalog: this
// is billing-side work. That gives `member` access (they bill) and withholds it
// from `accountant`, who reconciles books rather than logging shop hours.
export function jobsRoutes() {
  return (
    new Hono<{ Variables: RlsVariables }>()
      .post('/api/jobs', requireCapability('sales:write'), async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = jobCreateSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const { companyId, contactId, ...rest } = parsed.data;

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        // RLS pins the account, never the company, so a contact from a sibling
        // company in the same account would otherwise attach cleanly here.
        if (contactId) {
          const [contact] = await tx
            .select({ id: contacts.id, companyId: contacts.companyId })
            .from(contacts)
            .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
            .limit(1);
          if (!contact) return c.json({ error: 'contact_not_found' }, 404);
          if (contact.companyId !== companyId) {
            return c.json({ error: 'contact_company_mismatch' }, 400);
          }
        }

        const id = uuidv7();
        const row = { id, accountId, companyId, contactId: contactId ?? null, ...rest };
        await tx.insert(jobs).values(row);
        await c.var.audit({
          entityType: 'job',
          entityId: id,
          action: 'create',
          after: row,
          companyId,
        });

        return c.json(row, 201);
      })
      // Open jobs first, then alphabetical — the picker wants live work at the
      // top and the list page reads the same way. `q` backs the type-ahead.
      .get('/api/jobs', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const status = c.req.query('status');
        const q = c.req.query('q');

        if (status !== undefined && status !== 'open' && status !== 'closed') {
          return c.json({ error: 'invalid_status' }, 400);
        }

        const conditions = [eq(jobs.accountId, accountId)];
        if (companyId) conditions.push(eq(jobs.companyId, companyId));
        if (status) conditions.push(eq(jobs.status, status));
        if (q) conditions.push(ilike(jobs.name, `%${escapeLike(q)}%`));

        // contactName rides along on every job read. The customer is asked for at
        // create, so not showing it back is a small betrayal — and the invoice
        // form needs it to prefill the picker when billing a job.
        const withContact = { ...getTableColumns(jobs), contactName: contacts.name };

        if (q) {
          const rows = await tx
            .select(withContact)
            .from(jobs)
            .leftJoin(contacts, eq(contacts.id, jobs.contactId))
            .where(and(...conditions))
            .orderBy(asc(jobs.name))
            .limit(20);
          return c.json({ jobs: rows, nextCursor: null });
        }

        const limit = parseLimit(c.req.query('limit'));
        if (limit === null) return c.json({ error: 'invalid_limit' }, 400);
        const keys = [{ col: jobs.name }, { col: jobs.id }];
        const keyset = applyCursor(c.req.query('cursor'), keys, 'asc');
        if (keyset === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);
        if (keyset) conditions.push(keyset);
        const rows = await tx
          .select(withContact)
          .from(jobs)
          .leftJoin(contacts, eq(contacts.id, jobs.contactId))
          .where(and(...conditions))
          .orderBy(keysetOrderBy(keys, 'asc'))
          .limit(limit + 1);
        const page = slicePage(rows, limit, (r) => [r.name, r.id]);
        return c.json({ jobs: page.rows, nextCursor: page.nextCursor });
      })
      // Job detail: the job, the invoices it emitted, and the margin block.
      //
      // INTERNAL ONLY. Cost, margin and hours must never reach the customer —
      // the public view builds its own payload field by field in routes/public.ts
      // and there is a test asserting nothing here leaks into it.
      .get('/api/jobs/:id', async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [job] = await tx
          .select({ ...getTableColumns(jobs), contactName: contacts.name })
          .from(jobs)
          .leftJoin(contacts, eq(contacts.id, jobs.contactId))
          .where(and(eq(jobs.id, id), eq(jobs.accountId, accountId)))
          .limit(1);
        if (!job) return c.json({ error: 'job_not_found' }, 404);

        const memberInvoices = await tx
          .select({
            id: invoices.id,
            number: invoices.number,
            issueDate: invoices.issueDate,
            status: invoices.status,
            subtotal: invoices.subtotal,
            total: invoices.total,
          })
          .from(invoices)
          .where(and(eq(invoices.jobId, id), eq(invoices.accountId, accountId)))
          .orderBy(asc(invoices.issueDate), asc(invoices.number));

        const [billed, costs, minutes] = await Promise.all([
          jobBilledCents(tx, accountId, job.companyId, [id]),
          jobCostCents(tx, accountId, job.companyId, [id]),
          jobMinutes(tx, accountId, job.companyId, [id]),
        ]);
        const billedCents = billed.get(id) ?? 0;
        const costCents = costs.get(id) ?? 0;
        const trackedMinutes = minutes.get(id) ?? 0;
        const madeCents = billedCents - costCents;

        return c.json({
          ...job,
          invoices: memberInvoices,
          margin: {
            billed: centsToMoney(billedCents),
            costs: centsToMoney(costCents),
            made: centsToMoney(madeCents),
            minutes: trackedMinutes,
            hours: displayHours(trackedMinutes),
            // The number the whole feature exists to produce. Null with no hours
            // tracked — 0 would read as "this job paid nothing an hour".
            effectiveHourly: effectiveHourly(madeCents, trackedMinutes),
          },
        });
      })
      .patch(
        '/api/jobs/:id',
        requireCapability('sales:write'),
        validator('json', (value, c) => {
          const parsed = jobUpdateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const patch = c.req.valid('json');
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [current] = await tx
            .select()
            .from(jobs)
            .where(and(eq(jobs.id, id), eq(jobs.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'job_not_found' }, 404);

          if (patch.contactId) {
            const [contact] = await tx
              .select({ id: contacts.id, companyId: contacts.companyId })
              .from(contacts)
              .where(and(eq(contacts.id, patch.contactId), eq(contacts.accountId, accountId)))
              .limit(1);
            if (!contact) return c.json({ error: 'contact_not_found' }, 404);
            if (contact.companyId !== current.companyId) {
              return c.json({ error: 'contact_company_mismatch' }, 400);
            }
          }

          // The date-order refine can only see the fields in the patch, so a
          // one-sided edit has to be checked against the row it lands on.
          const startedOn = patch.startedOn === undefined ? current.startedOn : patch.startedOn;
          const endedOn = patch.endedOn === undefined ? current.endedOn : patch.endedOn;
          if (startedOn && endedOn && startedOn > endedOn) {
            return c.json({ error: 'ended_before_started' }, 400);
          }

          const [updated] = await tx
            .update(jobs)
            .set({ ...patch, updatedAt: new Date() })
            .where(and(eq(jobs.id, id), eq(jobs.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'job_not_found' }, 404);

          await c.var.audit({
            entityType: 'job',
            entityId: id,
            action: 'update',
            before: current,
            after: updated,
            companyId: current.companyId,
          });

          return c.json(updated);
        },
      )
      // Delete is for a mistyped job that never got used. A job with invoices or
      // tracked time is CLOSED, not deleted: time_entries cascade off job_id, so
      // deleting a used job would destroy the record that the work happened —
      // the same loss the billed_invoice_id SET NULL exists to prevent.
      .delete('/api/jobs/:id', requireCapability('sales:write'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [current] = await tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.id, id), eq(jobs.accountId, accountId)))
          .limit(1);
        if (!current) return c.json({ error: 'job_not_found' }, 404);

        const [entry] = await tx
          .select({ id: timeEntries.id })
          .from(timeEntries)
          .where(and(eq(timeEntries.jobId, id), eq(timeEntries.accountId, accountId)))
          .limit(1);
        if (entry) return c.json({ error: 'job_has_time_entries' }, 409);

        const [invoice] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(and(eq(invoices.jobId, id), eq(invoices.accountId, accountId)))
          .limit(1);
        if (invoice) return c.json({ error: 'job_has_invoices' }, 409);

        await tx.delete(jobs).where(and(eq(jobs.id, id), eq(jobs.accountId, accountId)));
        await c.var.audit({
          entityType: 'job',
          entityId: id,
          action: 'delete',
          before: current,
          companyId: current.companyId,
        });

        return c.body(null, 204);
      })
      // The validator middleware is required so hc<JobsAppType>() sees `json` on
      // the typed Input — the path-param POST-with-body footgun. jobId comes
      // from the path, so it is omitted from the body schema rather than being
      // sent twice and having to agree with itself.
      .post(
        '/api/jobs/:id/time',
        requireCapability('sales:write'),
        validator('json', (value, c) => {
          const parsed = timeEntryCreateSchema.omit({ jobId: true }).safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const jobId = c.req.param('id');
          if (!UUID_RE.test(jobId)) return c.json({ error: 'invalid_id' }, 400);
          const body = c.req.valid('json');

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [job] = await tx
            .select({ id: jobs.id, companyId: jobs.companyId })
            .from(jobs)
            .where(and(eq(jobs.id, jobId), eq(jobs.accountId, accountId)))
            .limit(1);
          if (!job) return c.json({ error: 'job_not_found' }, 404);

          const id = uuidv7();
          const row = {
            id,
            accountId,
            companyId: job.companyId,
            jobId,
            entryDate: body.entryDate,
            minutes: body.minutes,
            note: body.note ?? null,
            rate: body.rate ?? null,
            sourceItemId: body.sourceItemId ?? null,
            membershipId: body.membershipId ?? null,
          };
          await tx.insert(timeEntries).values(row);
          await c.var.audit({
            entityType: 'time_entry',
            entityId: id,
            action: 'create',
            after: row,
            companyId: job.companyId,
          });

          return c.json(row, 201);
        },
      )
      // Entries for a job, newest first. ?unbilled=true is what the invoice form
      // reads to offer "add unbilled time".
      // A query validator, not a bare c.req.query(), so hc<JobsAppType>() types
      // ?unbilled — the invoice form reads this route through the typed client.
      .get(
        '/api/jobs/:id/time',
        validator('query', (v) => ({
          unbilled: v.unbilled === 'true' ? 'true' : undefined,
        })),
        async (c) => {
          const jobId = c.req.param('id');
          if (!UUID_RE.test(jobId)) return c.json({ error: 'invalid_id' }, 400);
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [job] = await tx
            .select({ id: jobs.id })
            .from(jobs)
            .where(and(eq(jobs.id, jobId), eq(jobs.accountId, accountId)))
            .limit(1);
          if (!job) return c.json({ error: 'job_not_found' }, 404);

          const conditions = [eq(timeEntries.jobId, jobId), eq(timeEntries.accountId, accountId)];
          if (c.req.valid('query').unbilled === 'true') {
            conditions.push(isNull(timeEntries.billedInvoiceId));
          }

          const rows = await tx
            .select()
            .from(timeEntries)
            .where(and(...conditions))
            .orderBy(desc(timeEntries.entryDate), desc(timeEntries.id));

          const totalMinutes = rows.reduce((sum, r) => sum + r.minutes, 0);
          return c.json({
            timeEntries: rows,
            totalMinutes,
            totalHours: displayHours(totalMinutes),
          });
        },
      )
      .patch(
        '/api/time-entries/:id',
        requireCapability('sales:write'),
        validator('json', (value, c) => {
          const parsed = timeEntryUpdateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const patch = c.req.valid('json');
          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [current] = await tx
            .select()
            .from(timeEntries)
            .where(and(eq(timeEntries.id, id), eq(timeEntries.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'time_entry_not_found' }, 404);

          // Editing hours already on a sent invoice would silently disagree with
          // the line the customer was billed for. Change the invoice instead.
          if (current.billedInvoiceId) return c.json({ error: 'time_entry_billed' }, 409);

          const [updated] = await tx
            .update(timeEntries)
            .set({ ...patch, updatedAt: new Date() })
            .where(and(eq(timeEntries.id, id), eq(timeEntries.accountId, accountId)))
            .returning();
          if (!updated) return c.json({ error: 'time_entry_not_found' }, 404);

          await c.var.audit({
            entityType: 'time_entry',
            entityId: id,
            action: 'update',
            before: current,
            after: updated,
            companyId: current.companyId,
          });

          return c.json(updated);
        },
      )
      .delete('/api/time-entries/:id', requireCapability('sales:write'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [current] = await tx
          .select()
          .from(timeEntries)
          .where(and(eq(timeEntries.id, id), eq(timeEntries.accountId, accountId)))
          .limit(1);
        if (!current) return c.json({ error: 'time_entry_not_found' }, 404);
        if (current.billedInvoiceId) return c.json({ error: 'time_entry_billed' }, 409);

        await tx
          .delete(timeEntries)
          .where(and(eq(timeEntries.id, id), eq(timeEntries.accountId, accountId)));
        await c.var.audit({
          entityType: 'time_entry',
          entityId: id,
          action: 'delete',
          before: current,
          companyId: current.companyId,
        });

        return c.body(null, 204);
      })
  );
}
