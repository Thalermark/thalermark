import {
  type Transaction,
  companies,
  contacts,
  invoices,
  jobs,
  timeEntries,
  timeTimers,
} from '@thalermark/db';
import {
  billingUnitLabel,
  centsToMoney,
  isBillingUnit,
  jobCreateSchema,
  jobUpdateSchema,
  timeEntryCreateOnJobSchema,
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
  jobDraftedCents,
  jobMade,
  jobMinutes,
  jobUnbilled,
} from '../lib/job-costing.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import { UUID_RE, escapeLike } from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// Which of minutes / quantity a job's billing unit actually requires (TMC-264).
//
// The body schema cannot answer this: the job is a foreign key, so the unit is
// only known after the row is read. The schema catches the case that is wrong
// under EVERY unit (recording neither); this catches the unit-specific half.
//
// Returns a Zod-shaped issue rather than a bare code, so the caller hands it
// back inside the same { error: 'invalid_body', issues } envelope a schema
// failure produces and both clients' existing field-error rendering covers it.
function missingForUnit(
  resolvedUnit: string,
  body: { minutes?: number | null; quantity?: string | null },
): { path: string[]; message: string } | null {
  // The unit is already RESOLVED by the caller through entryUnit(): this line's
  // own override if it set one, otherwise the job's default. Unknown values
  // resolve to hours there, matching the column default.
  if (!isBillingUnit(resolvedUnit) || resolvedUnit === 'hour') {
    return body.minutes == null ? { path: ['minutes'], message: 'Enter how long it took.' } : null;
  }
  if (body.quantity != null) return null;
  // '2' forces the plural: "Enter how many visits you did." Passing the real
  // quantity would be circular, since its absence is the error.
  return {
    path: ['quantity'],
    message: `Enter how many ${billingUnitLabel(resolvedUnit, '2')} you did.`,
  };
}

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
// Attach "what could this job invoice right now" to a page of job rows.
//
// One grouped query for the whole page rather than per row. Rows can span
// companies in a multi-company workspace, so it groups by company — jobUnbilled
// is company-scoped because time entries are.
//
// unratedMinutes rides along because a list has no room to explain itself: a job
// with a day of unpriced work would otherwise show $0.00 and read as "nothing to
// bill" when there is plenty, just nothing priced.
async function withUnbilled<T extends { id: string; companyId: string }>(
  tx: Transaction,
  accountId: string,
  rows: T[],
): Promise<(T & { readyToBill: string; unratedMinutes: number })[]> {
  const byCompany = new Map<string, string[]>();
  for (const row of rows) {
    byCompany.set(row.companyId, [...(byCompany.get(row.companyId) ?? []), row.id]);
  }
  const unbilled = new Map<string, { cents: number; unratedMinutes: number }>();
  for (const [companyId, ids] of byCompany) {
    for (const [jobId, v] of await jobUnbilled(tx, accountId, companyId, ids)) {
      unbilled.set(jobId, v);
    }
  }
  return rows.map((row) => {
    const v = unbilled.get(row.id);
    return {
      ...row,
      readyToBill: centsToMoney(v?.cents ?? 0),
      unratedMinutes: v?.unratedMinutes ?? 0,
    };
  });
}

export function jobsRoutes() {
  return (
    new Hono<{ Variables: RlsVariables }>()
      .post(
        '/api/jobs',
        requireCapability('sales:write'),
        validator('json', (value, c) => {
          const parsed = jobCreateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const { companyId, contactId, ...rest } = c.req.valid('json');

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
        },
      )
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
          return c.json({ jobs: await withUnbilled(tx, accountId, rows), nextCursor: null });
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
        return c.json({
          jobs: await withUnbilled(tx, accountId, page.rows),
          nextCursor: page.nextCursor,
        });
      })
      // Declared BEFORE /api/jobs/:id — Hono is first-match, so the literal
      // would otherwise be captured as an id. Same rule as /api/items/import.
      .get('/api/jobs/summary', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');

        const scope = [eq(jobs.accountId, accountId)];
        if (companyId) scope.push(eq(jobs.companyId, companyId));

        const rows = await tx
          .select({ id: jobs.id, companyId: jobs.companyId, status: jobs.status })
          .from(jobs)
          .where(and(...scope));

        const open = rows.filter((r) => r.status === 'open').length;

        // Money on unsent invoices (TMC-202). Same reason it exists on the
        // detail route: without it this money is in no tile at all, and the
        // headline reads $0.00 waiting while a drafted invoice sits unsent.
        let draftedCents = 0;

        // Money waiting across every job, and the hours that CANNOT be billed
        // until someone prices them. The second is the actionable half: a job
        // full of unrated work looks identical to a job with nothing to bill.
        let readyCents = 0;
        let readyOnClosedCents = 0;
        let unratedMinutes = 0;
        let jobsWithMoneyWaiting = 0;
        const statusOf = new Map(rows.map((r) => [r.id, r.status]));
        const byCompany = new Map<string, string[]>();
        for (const r of rows) {
          byCompany.set(r.companyId, [...(byCompany.get(r.companyId) ?? []), r.id]);
        }
        for (const [cid, ids] of byCompany) {
          for (const [jobId, v] of await jobUnbilled(tx, accountId, cid, ids)) {
            readyCents += v.cents;
            unratedMinutes += v.unratedMinutes;
            if (v.cents > 0) jobsWithMoneyWaiting += 1;
            // Broken out because the default list shows OPEN jobs: without this
            // the headline can read $191 while the visible list adds to $60, and
            // the missing money is invisible rather than merely elsewhere.
            if (statusOf.get(jobId) === 'closed') readyOnClosedCents += v.cents;
          }
          for (const [, cents] of await jobDraftedCents(tx, accountId, cid, ids)) {
            draftedCents += cents;
          }
        }

        return c.json({
          total: rows.length,
          open,
          closed: rows.length - open,
          readyToBill: centsToMoney(readyCents),
          readyToBillOnClosed: centsToMoney(readyOnClosedCents),
          drafted: centsToMoney(draftedCents),
          jobsWithMoneyWaiting,
          unratedMinutes,
          unratedHours: displayHours(unratedMinutes),
        });
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

        const [billed, drafted, costs, minutes, unbilled] = await Promise.all([
          jobBilledCents(tx, accountId, job.companyId, [id]),
          jobDraftedCents(tx, accountId, job.companyId, [id]),
          jobCostCents(tx, accountId, job.companyId, [id]),
          jobMinutes(tx, accountId, job.companyId, [id]),
          jobUnbilled(tx, accountId, job.companyId, [id]),
        ]);
        const billedCents = billed.get(id) ?? 0;
        const draftedCents = drafted.get(id) ?? 0;
        const costCents = costs.get(id) ?? 0;
        const trackedMinutes = minutes.get(id) ?? 0;
        const madeCents = billedCents - costCents;
        // Is more revenue coming? An unsent invoice or unbilled priced hours
        // both say yes. Without this the margin cannot tell "not billed yet"
        // from "voided, never will be" — see jobMade (TMC-204).
        const revenueStillExpected = draftedCents > 0 || (unbilled.get(id)?.cents ?? 0) > 0;

        return c.json({
          ...job,
          invoices: memberInvoices,
          margin: {
            billed: centsToMoney(billedCents),
            // Written but not sent (TMC-202). Deliberately NOT added into
            // billed/made — it is reported beside them so the money is visible
            // without claiming it was ever asked for. Hours on a draft are
            // stamped, so they have already left readyToBill; without this they
            // are counted nowhere and the job reports zero while holding an
            // invoice.
            drafted: centsToMoney(draftedCents),
            costs: centsToMoney(costCents),
            // Null while revenue is still expected, a real figure otherwise —
            // see jobMade. A drafted job states no margin; a VOIDED one states
            // its loss, because that money is genuinely gone (TMC-204).
            made: jobMade(billedCents, costCents, revenueStillExpected),
            minutes: trackedMinutes,
            hours: displayHours(trackedMinutes),
            // The number the whole feature exists to produce. Null with no hours
            // tracked — 0 would read as "this job paid nothing an hour".
            effectiveHourly: effectiveHourly(madeCents, trackedMinutes, billedCents),
          },
        });
      })
      .patch(
        '/api/jobs/:id',
        requireCapability('sales:write'),
        // confirm rides as a query param so hc types it; the guard below reads
        // it to let a deliberate close through.
        validator('query', (v) => ({ confirm: v.confirm === 'true' ? 'true' : undefined })),
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

          // Closing a job with billable hours on it is how money goes missing:
          // the job drops out of the default list and its unbilled work goes
          // with it. Refused unless the caller says so explicitly — the amount
          // comes back so the client can name it rather than nag vaguely.
          if (patch.status === 'closed' && current.status !== 'closed') {
            const waiting = (await jobUnbilled(tx, accountId, current.companyId, [id])).get(id);
            if (waiting && waiting.cents > 0 && c.req.valid('query').confirm !== 'true') {
              return c.json(
                { error: 'job_has_unbilled_time', readyToBill: centsToMoney(waiting.cents) },
                409,
              );
            }
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
          const parsed = timeEntryCreateOnJobSchema.safeParse(value);
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
            .select({ id: jobs.id, companyId: jobs.companyId, billingUnit: jobs.billingUnit })
            .from(jobs)
            .where(and(eq(jobs.id, jobId), eq(jobs.accountId, accountId)))
            .limit(1);
          if (!job) return c.json({ error: 'job_not_found' }, 404);

          // WHICH FIELD IS REQUIRED DEPENDS ON THE JOB (TMC-264), which the body
          // schema cannot see — the job is a foreign key resolved right here. The
          // schema already rejected an entry recording NEITHER; this is the
          // unit-specific half.
          //
          // Returned in the same { error, issues } shape a schema failure uses,
          // so both clients' existing field-error handling covers it and no raw
          // code reaches a user (TMC-219 / TMC-220).
          // WHAT THE CALLER IS TRYING TO LOG — deliberately NOT entryUnit().
          //
          // The two questions look identical and are not:
          //
          //   READING an existing row asks "what can this data express?", and
          //   must never reinterpret an hours entry into a unit it has no count
          //   for. entryUnit() answers that, and it is why switching a job to
          //   nights no longer makes its logged hours unbillable.
          //
          //   CREATING a row asks "what did they mean?", and there is no
          //   existing data to protect. An omitted unit means the job's default,
          //   so a per-visit job still demands a count instead of quietly
          //   accepting a bare duration as hours.
          //
          // Collapsing the two made this route accept a countless entry on a
          // per-visit job, which is the exact validation the unit exists for.
          const lineUnit = body.unit && isBillingUnit(body.unit) ? body.unit : job.billingUnit;
          const missing = missingForUnit(lineUnit, body);
          if (missing) return c.json({ error: 'invalid_body', issues: [missing] }, 400);

          const id = uuidv7();
          const row = {
            id,
            accountId,
            companyId: job.companyId,
            jobId,
            entryDate: body.entryDate,
            minutes: body.minutes ?? null,
            // Stored on every entry regardless of unit. An hourly job ignores it
            // at billing time and a per-visit job ignores minutes, but changing
            // the job's unit later must not need the work re-entered.
            quantity: body.quantity ?? null,
            // Stored ONLY when it differs from the job's default, so a job whose
            // entries really are all one unit keeps null throughout and follows
            // the job if that default is later changed.
            unit: lineUnit === job.billingUnit ? null : lineUnit,
            startTime: body.startTime ?? null,
            endTime: body.endTime ?? null,
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

          // The name rides along because all four invoice forms that seed rows
          // from these entries need it for the line label, and they all already
          // make this call. Threading it separately would be four more fetches
          // for a string this query is already holding.
          const [job] = await tx
            .select({ id: jobs.id, name: jobs.name, billingUnit: jobs.billingUnit })
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

          // Null minutes contribute nothing rather than poisoning the sum
          // (TMC-264): on a non-hourly job the duration is optional.
          const totalMinutes = rows.reduce((sum, r) => sum + (r.minutes ?? 0), 0);
          return c.json({
            timeEntries: rows,
            jobName: job.name,
            // The unit rides along for the same reason jobName does: all four
            // invoice forms seed rows from this call and need it to compute the
            // line quantity and label, and they all already make this request.
            billingUnit: job.billingUnit,
            totalMinutes,
            totalHours: displayHours(totalMinutes),
          });
        },
      )
      // --- The running stopwatch (TMC-180) -------------------------------
      //
      // Start refuses if the caller already has one running, naming the job it
      // is on. Auto-stopping instead would silently log the previous job with
      // whatever happened in between — the drive to this one — inside it.
      .post('/api/jobs/:id/timer', requireCapability('sales:write'), async (c) => {
        const jobId = c.req.param('id');
        if (!UUID_RE.test(jobId)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const userId = c.get('userId');

        const [job] = await tx
          .select({ id: jobs.id, companyId: jobs.companyId })
          .from(jobs)
          .where(and(eq(jobs.id, jobId), eq(jobs.accountId, accountId)))
          .limit(1);
        if (!job) return c.json({ error: 'job_not_found' }, 404);

        // Checked before insert so the caller gets the running job's NAME rather
        // than a unique-violation 500 — the message is the whole point of
        // refusing. (The unique index is still the thing that makes it true.)
        const [running] = await tx
          .select({ jobId: timeTimers.jobId, startedAt: timeTimers.startedAt, name: jobs.name })
          .from(timeTimers)
          .innerJoin(jobs, eq(jobs.id, timeTimers.jobId))
          .where(and(eq(timeTimers.accountId, accountId), eq(timeTimers.userId, userId)))
          .limit(1);
        if (running) {
          return c.json(
            {
              error: 'timer_already_running',
              jobId: running.jobId,
              jobName: running.name,
              startedAt: running.startedAt,
            },
            409,
          );
        }

        // contract-check-exempt: this body is genuinely optional. Starting a
        // timer without a note is the common case, and clients send that as a
        // POST carrying a JSON content-type and no body at all — which Hono's
        // validator('json') calls malformed and 400s. Moving this route onto
        // the validator broke exactly that, in two tests. The cost of staying
        // is that `note` is absent from the typed contract (TMC-292).
        const note = (await c.req.json().catch(() => null))?.note;
        const row = {
          id: uuidv7(),
          accountId,
          companyId: job.companyId,
          jobId,
          userId,
          note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 1000) : null,
        };
        await tx.insert(timeTimers).values(row);
        // No audit row: starting a stopwatch records no work and changes no
        // money. The audit trail gets the time entry, if one is ever logged.
        const [created] = await tx
          .select()
          .from(timeTimers)
          .where(eq(timeTimers.id, row.id))
          .limit(1);
        return c.json(created, 201);
      })
      // Stop returns the elapsed minutes and DELETES the timer. It deliberately
      // does not log: the user still owes a note and a rate, and a stopwatch
      // that silently became a billable entry would be the easiest way to
      // invoice someone for a drive home.
      .delete('/api/jobs/:id/timer', requireCapability('sales:write'), async (c) => {
        const jobId = c.req.param('id');
        if (!UUID_RE.test(jobId)) return c.json({ error: 'invalid_id' }, 400);
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const userId = c.get('userId');

        const [running] = await tx
          .select()
          .from(timeTimers)
          .where(
            and(
              eq(timeTimers.accountId, accountId),
              eq(timeTimers.userId, userId),
              eq(timeTimers.jobId, jobId),
            ),
          )
          .limit(1);
        if (!running) return c.json({ error: 'timer_not_running' }, 404);

        await tx.delete(timeTimers).where(eq(timeTimers.id, running.id));

        // Elapsed is computed from started_at, never accumulated, so a shut
        // laptop cannot drift it. Rounded UP to the minute: a 30-second visit is
        // a minute of work, and rounding it to zero loses the entry entirely.
        const minutes = Math.max(1, Math.ceil((Date.now() - running.startedAt.getTime()) / 60_000));
        return c.json({ minutes, note: running.note, startedAt: running.startedAt });
      })
      // The caller's running timer, if any. One request answers "is anything
      // running, and where" for every screen that needs to know.
      .get('/api/timer', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const userId = c.get('userId');
        const [running] = await tx
          .select({
            jobId: timeTimers.jobId,
            jobName: jobs.name,
            startedAt: timeTimers.startedAt,
            note: timeTimers.note,
          })
          .from(timeTimers)
          .innerJoin(jobs, eq(jobs.id, timeTimers.jobId))
          .where(and(eq(timeTimers.accountId, accountId), eq(timeTimers.userId, userId)))
          .limit(1);
        return c.json({ timer: running ?? null });
      })
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

          // The unit rule (TMC-264) re-checked against the MERGED row, not the
          // patch. The update schema only judges fields the caller actually
          // sent — it has to, or a one-field rename would be rejected for
          // omitting a duration it never intended to touch — so clearing
          // `minutes` on an hourly job is only visible once the patch is laid
          // over the stored row.
          const [ownerJob] = await tx
            .select({ billingUnit: jobs.billingUnit })
            .from(jobs)
            .where(and(eq(jobs.id, current.jobId), eq(jobs.accountId, accountId)))
            .limit(1);
          const merged = {
            minutes: 'minutes' in patch ? (patch.minutes ?? null) : current.minutes,
            quantity: 'quantity' in patch ? (patch.quantity ?? null) : current.quantity,
            unit: 'unit' in patch ? (patch.unit ?? null) : current.unit,
          };
          // Same split as create: what the caller MEANS, not what the stored
          // data can express.
          const mergedUnit =
            merged.unit && isBillingUnit(merged.unit)
              ? merged.unit
              : (ownerJob?.billingUnit ?? 'hour');
          const missing = missingForUnit(mergedUnit, merged);
          if (missing) return c.json({ error: 'invalid_body', issues: [missing] }, 400);

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
