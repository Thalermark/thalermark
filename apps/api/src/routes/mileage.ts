import {
  type Transaction,
  companies,
  jobs,
  mileageTrips,
  vehicleYears,
  vehicles,
} from '@thalermark/db';
import {
  mileageTripCreateSchema,
  mileageTripUpdateSchema,
  summariseMileage,
  vehicleCreateSchema,
  vehicleUpdateSchema,
  vehicleYearSchema,
} from '@thalermark/validation';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import { assertCompanyActive } from '../lib/company-lock.js';
import { applyCursor, keysetOrderBy, parseLimit, slicePage } from '../lib/pagination.js';
import { assertPeriodOpen } from '../lib/period-lock.js';
import { UUID_RE, expenseDateToPostedAt } from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// Mileage trips (TMC-179) — a self-contained per-domain sub-app, same shape as
// the others (see app.ts for the modular-sub-apps rationale).
//
// NOTHING HERE POSTS TO THE LEDGER, for any entity type. See the header on
// packages/db/src/schema/mileage_trips.ts for why, and the integration test that
// holds it: logging trips leaves the balance sheet, the P&L and job margin
// byte-identical.
//
// Gated on expenses:write, DELIBERATELY NOT sales:write like jobs. Mileage is
// deduction-side, not billing-side, so it belongs with expenses — which also
// gives `accountant` access. An accountant who cannot fix a mistyped trip cannot
// do the job we hand them the books for.
//
// The period lock DOES apply here, which is the one place this diverges from
// jobs and time entries. Those tag invoices and change no year's numbers, so
// they are unguarded. A mileage trip is an input to a tax return: adding one to
// a closed year silently restates a deduction already handed to a preparer. Same
// reasoning as an expense, so the same guard — and the same 409 through app.ts's
// onError, so the user gets one consistent "that year is closed" message.
// Query shape for the year summary. A validator rather than bare c.req.query()
// so the year is typed on the RPC surface — the clients pass it, and an untyped
// param means the typed client refuses the call.
function mileageYearQuery(v: Record<string, string | string[] | undefined>) {
  const yearRaw = v.year;
  if (typeof yearRaw !== 'string') return { year: undefined };
  const year = Number(yearRaw);
  // Same bound as the tax worksheet: a year outside this is a typo, not a
  // filing, and it keeps the date-window strings sane.
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    return { error: 'invalid_year' as const };
  }
  return { year };
}

// Confirm a named vehicle belongs to this company before a trip attaches to it.
//
// RLS pins the account, never the company, so a vehicle from a sibling company
// in the same account would otherwise attach cleanly — and Part IV would then
// disclose one company's truck on another company's return.
async function assertVehicleOwned(
  tx: Transaction,
  args: { accountId: string; companyId: string; vehicleId: string },
): Promise<null | { error: 'vehicle_not_found' | 'vehicle_company_mismatch' }> {
  const [vehicle] = await tx
    .select({ id: vehicles.id, companyId: vehicles.companyId })
    .from(vehicles)
    .where(and(eq(vehicles.id, args.vehicleId), eq(vehicles.accountId, args.accountId)))
    .limit(1);
  if (!vehicle) return { error: 'vehicle_not_found' };
  if (vehicle.companyId !== args.companyId) return { error: 'vehicle_company_mismatch' };
  return null;
}

export function mileageRoutes() {
  return (
    new Hono<{ Variables: RlsVariables }>()
      .post(
        '/api/mileage-trips',
        requireCapability('expenses:write'),
        validator('json', (value, c) => {
          const parsed = mileageTripCreateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const { companyId, jobId, ...rest } = c.req.valid('json');

          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          // RLS pins the account, never the company, so a job from a sibling
          // company in the same account would otherwise attach cleanly here.
          if (jobId) {
            const [job] = await tx
              .select({ id: jobs.id, companyId: jobs.companyId })
              .from(jobs)
              .where(and(eq(jobs.id, jobId), eq(jobs.accountId, accountId)))
              .limit(1);
            if (!job) return c.json({ error: 'job_not_found' }, 404);
            if (job.companyId !== companyId) {
              return c.json({ error: 'job_company_mismatch' }, 400);
            }
          }

          if (rest.vehicleId) {
            const bad = await assertVehicleOwned(tx, {
              accountId,
              companyId,
              vehicleId: rest.vehicleId,
            });
            if (bad)
              return c.json({ error: bad.error }, bad.error === 'vehicle_not_found' ? 404 : 400);
          }

          await assertCompanyActive(tx, { accountId, companyId });
          await assertPeriodOpen(tx, {
            accountId,
            companyId,
            postedAt: expenseDateToPostedAt(rest.tripDate),
          });

          const id = uuidv7();
          const row = {
            id,
            accountId,
            companyId,
            jobId: jobId ?? null,
            tripDate: rest.tripDate,
            miles: rest.miles,
            purpose: rest.purpose,
            vehicleId: rest.vehicleId ?? null,
          };
          await tx.insert(mileageTrips).values(row);
          // Read back rather than echoing what was sent. numeric(15,4) canonicalises
          // "24.5" to "24.5000", and a create response that disagreed with the list
          // response would make a client re-render change the number on screen.
          const [created] = await tx
            .select()
            .from(mileageTrips)
            .where(eq(mileageTrips.id, id))
            .limit(1);
          // Audited, unlike expense_allocations, which is a bare tag. This
          // substantiates a tax deduction — if it is ever challenged, "who entered
          // this and when" is the entire point of having a record at all.
          await c.var.audit({
            entityType: 'mileage_trip',
            entityId: id,
            action: 'create',
            after: created,
            companyId,
          });

          return c.json(created, 201);
        },
      )
      // Newest first — a trip log is read as "what have I driven lately", and
      // the entry form prefills from the top row.
      .get('/api/mileage-trips', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const jobId = c.req.query('jobId');
        const from = c.req.query('from');
        const to = c.req.query('to');

        const conditions = [eq(mileageTrips.accountId, accountId)];
        if (companyId) conditions.push(eq(mileageTrips.companyId, companyId));
        if (jobId) conditions.push(eq(mileageTrips.jobId, jobId));
        // Bare-date comparison against a date column — no instant conversion.
        // A trip date is a calendar date the driver asserts, not a moment.
        if (from) conditions.push(gte(mileageTrips.tripDate, from));
        if (to) conditions.push(lte(mileageTrips.tripDate, to));

        const limit = parseLimit(c.req.query('limit'));
        if (limit === null) return c.json({ error: 'invalid_limit' }, 400);
        const keys = [{ col: mileageTrips.tripDate }, { col: mileageTrips.id }];
        const keyset = applyCursor(c.req.query('cursor'), keys, 'desc');
        if (keyset === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);
        if (keyset) conditions.push(keyset);

        const rows = await tx
          .select()
          .from(mileageTrips)
          .where(and(...conditions))
          .orderBy(keysetOrderBy(keys, 'desc'))
          .limit(limit + 1);
        const page = slicePage(rows, limit, (r) => [r.tripDate, r.id]);
        return c.json({ trips: page.rows, nextCursor: page.nextCursor });
      })
      .patch(
        '/api/mileage-trips/:id',
        requireCapability('expenses:write'),
        validator('json', (value, c) => {
          const parsed = mileageTripUpdateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [current] = await tx
            .select()
            .from(mileageTrips)
            .where(and(eq(mileageTrips.id, id), eq(mileageTrips.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'mileage_trip_not_found' }, 404);

          const data = c.req.valid('json');
          if (data.jobId) {
            const [job] = await tx
              .select({ id: jobs.id, companyId: jobs.companyId })
              .from(jobs)
              .where(and(eq(jobs.id, data.jobId), eq(jobs.accountId, accountId)))
              .limit(1);
            if (!job) return c.json({ error: 'job_not_found' }, 404);
            if (job.companyId !== current.companyId) {
              return c.json({ error: 'job_company_mismatch' }, 400);
            }
          }

          if (data.vehicleId) {
            const bad = await assertVehicleOwned(tx, {
              accountId,
              companyId: current.companyId,
              vehicleId: data.vehicleId,
            });
            if (bad)
              return c.json({ error: bad.error }, bad.error === 'vehicle_not_found' ? 404 : 400);
          }

          await assertCompanyActive(tx, { accountId, companyId: current.companyId });
          // BOTH dates, when the trip is being moved. Dragging a trip out of a
          // closed year is as much a restatement as dropping one into it.
          await assertPeriodOpen(tx, {
            accountId,
            companyId: current.companyId,
            postedAt: expenseDateToPostedAt(current.tripDate),
          });
          if (data.tripDate && data.tripDate !== current.tripDate) {
            await assertPeriodOpen(tx, {
              accountId,
              companyId: current.companyId,
              postedAt: expenseDateToPostedAt(data.tripDate),
            });
          }

          const patch: Record<string, unknown> = { updatedAt: new Date() };
          if (data.tripDate !== undefined) patch.tripDate = data.tripDate;
          if (data.miles !== undefined) patch.miles = data.miles;
          if (data.purpose !== undefined) patch.purpose = data.purpose;
          if (data.vehicleId !== undefined) patch.vehicleId = data.vehicleId;
          if (data.jobId !== undefined) patch.jobId = data.jobId;

          await tx
            .update(mileageTrips)
            .set(patch)
            .where(and(eq(mileageTrips.id, id), eq(mileageTrips.accountId, accountId)));
          const [updated] = await tx
            .select()
            .from(mileageTrips)
            .where(eq(mileageTrips.id, id))
            .limit(1);

          await c.var.audit({
            entityType: 'mileage_trip',
            entityId: id,
            action: 'update',
            before: current,
            after: updated,
            companyId: current.companyId,
          });

          return c.json(updated);
        },
      )
      .delete('/api/mileage-trips/:id', requireCapability('expenses:write'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [current] = await tx
          .select()
          .from(mileageTrips)
          .where(and(eq(mileageTrips.id, id), eq(mileageTrips.accountId, accountId)))
          .limit(1);
        if (!current) return c.json({ error: 'mileage_trip_not_found' }, 404);

        await assertCompanyActive(tx, { accountId, companyId: current.companyId });
        await assertPeriodOpen(tx, {
          accountId,
          companyId: current.companyId,
          postedAt: expenseDateToPostedAt(current.tripDate),
        });

        await tx
          .delete(mileageTrips)
          .where(and(eq(mileageTrips.id, id), eq(mileageTrips.accountId, accountId)));
        await c.var.audit({
          entityType: 'mileage_trip',
          entityId: id,
          action: 'delete',
          before: current,
          companyId: current.companyId,
        });

        return c.json({ ok: true });
      })
      // The year rollup: miles, what they are worth, and what could not be
      // priced. Its own endpoint because the list is keyset-paginated — a client
      // holding one page cannot add up the year, and a running total that only
      // covers the visible rows is worse than none.
      //
      // Declared here rather than in companies.ts for the same reason the tax
      // worksheet is in reports.ts: the route lives with its domain, and Hono
      // resolves it fine because no sibling claims this path.
      .get('/api/companies/:id/mileage', validator('query', mileageYearQuery), async (c) => {
        const companyId = c.req.param('id');
        if (!UUID_RE.test(companyId)) return c.json({ error: 'invalid_id' }, 400);
        const q = c.req.valid('query');
        if ('error' in q) return c.json({ error: q.error }, 400);

        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
          .limit(1);
        if (!company) return c.json({ error: 'company_not_found' }, 404);

        const year = q.year ?? new Date().getUTCFullYear();

        const rows = await tx
          .select({ miles: mileageTrips.miles, tripDate: mileageTrips.tripDate })
          .from(mileageTrips)
          .where(
            and(
              eq(mileageTrips.accountId, accountId),
              eq(mileageTrips.companyId, companyId),
              gte(mileageTrips.tripDate, `${year}-01-01`),
              lte(mileageTrips.tripDate, `${year}-12-31`),
            ),
          )
          .orderBy(desc(mileageTrips.tripDate));

        return c.json({ year, ...summariseMileage(rows) });
      })
      // ── Vehicles (Schedule C Part IV) ──────────────────────────────────
      //
      // Gated on expenses:write like the trips, DELIBERATELY NOT settings:manage
      // even though this is configuration-shaped. The person who has to finish
      // Part IV at tax time is often the accountant, and `accountant` does not
      // hold settings:manage — putting these behind it would lock the answers
      // away from exactly the role most likely to know them.
      //
      // NO PERIOD LOCK anywhere in this section, and that is deliberate. A trip
      // is locked because it changes the dollar figure on line 9. Nothing here
      // changes a dollar figure on any form — these fill a disclosure box. A
      // corporation that closes 2026 in January must still be able to answer
      // these in March when the return is actually prepared.
      .post(
        '/api/vehicles',
        requireCapability('expenses:write'),
        validator('json', (value, c) => {
          const parsed = vehicleCreateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const { companyId, label, ...rest } = c.req.valid('json');

          const [company] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, companyId), eq(companies.accountId, accountId)))
            .limit(1);
          if (!company) return c.json({ error: 'company_not_found' }, 404);

          await assertCompanyActive(tx, { accountId, companyId });

          // Checked before insert so a duplicate reads as "you already have one of
          // those" rather than a unique-violation 500. The partial index is still
          // what makes it true.
          const [clash] = await tx
            .select({ id: vehicles.id })
            .from(vehicles)
            .where(
              and(
                eq(vehicles.accountId, accountId),
                eq(vehicles.companyId, companyId),
                isNull(vehicles.retiredAt),
                sql`lower(btrim(${vehicles.label})) = lower(btrim(${label}))`,
              ),
            )
            .limit(1);
          if (clash) return c.json({ error: 'vehicle_label_taken', vehicleId: clash.id }, 409);

          const id = uuidv7();
          await tx.insert(vehicles).values({
            id,
            accountId,
            companyId,
            label,
            placedInServiceOn: rest.placedInServiceOn ?? null,
            personalUse: rest.personalUse ?? null,
            anotherVehicleAvailable: rest.anotherVehicleAvailable ?? null,
          });
          const [created] = await tx.select().from(vehicles).where(eq(vehicles.id, id)).limit(1);
          await c.var.audit({
            entityType: 'vehicle',
            entityId: id,
            action: 'create',
            after: created,
            companyId,
          });

          return c.json(created, 201);
        },
      )
      // Unpaginated, unlike the trip list. A workspace has a handful of vehicles
      // — a keyset cursor here would be machinery with no reader. Same call the
      // year-summary endpoint makes.
      .get('/api/vehicles', async (c) => {
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const companyId = c.req.query('companyId');
        const includeRetired = c.req.query('includeRetired') === 'true';

        const conditions = [eq(vehicles.accountId, accountId)];
        if (companyId) conditions.push(eq(vehicles.companyId, companyId));
        if (!includeRetired) conditions.push(isNull(vehicles.retiredAt));

        const rows = await tx
          .select()
          .from(vehicles)
          .where(and(...conditions))
          .orderBy(asc(vehicles.label));
        return c.json({ vehicles: rows });
      })
      // The validator middleware is required so hc<MileageAppType>() sees `json`
      // on the typed Input — the path-param-with-body footgun (same note as
      // jobs.ts's time-entry route).
      .patch(
        '/api/vehicles/:id',
        requireCapability('expenses:write'),
        validator('json', (value, c) => {
          const parsed = vehicleUpdateSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const id = c.req.param('id');
          if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
          const parsed = { data: c.req.valid('json') };

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [current] = await tx
            .select()
            .from(vehicles)
            .where(and(eq(vehicles.id, id), eq(vehicles.accountId, accountId)))
            .limit(1);
          if (!current) return c.json({ error: 'vehicle_not_found' }, 404);

          const data = parsed.data;
          if (
            data.label &&
            data.label.trim().toLowerCase() !== current.label.trim().toLowerCase()
          ) {
            const [clash] = await tx
              .select({ id: vehicles.id })
              .from(vehicles)
              .where(
                and(
                  eq(vehicles.accountId, accountId),
                  eq(vehicles.companyId, current.companyId),
                  isNull(vehicles.retiredAt),
                  sql`lower(btrim(${vehicles.label})) = lower(btrim(${data.label}))`,
                ),
              )
              .limit(1);
            if (clash) return c.json({ error: 'vehicle_label_taken', vehicleId: clash.id }, 409);
          }

          const patch: Record<string, unknown> = { updatedAt: new Date() };
          if (data.label !== undefined) patch.label = data.label;
          if (data.placedInServiceOn !== undefined)
            patch.placedInServiceOn = data.placedInServiceOn;
          if (data.personalUse !== undefined) patch.personalUse = data.personalUse;
          if (data.anotherVehicleAvailable !== undefined) {
            patch.anotherVehicleAvailable = data.anotherVehicleAvailable;
          }

          await tx
            .update(vehicles)
            .set(patch)
            .where(and(eq(vehicles.id, id), eq(vehicles.accountId, accountId)));
          const [updated] = await tx.select().from(vehicles).where(eq(vehicles.id, id)).limit(1);

          await c.var.audit({
            entityType: 'vehicle',
            entityId: id,
            action: 'update',
            before: current,
            after: updated,
            companyId: current.companyId,
          });

          return c.json(updated);
        },
      )
      // Schedule C line 44's denominator: how far this vehicle went in total
      // that year. Idempotent upsert — one row per vehicle per year, and
      // answering twice is the same as answering once.
      //
      // NO assertPeriodOpen, deliberately, and a reviewer will ask why when the
      // trip routes above all have it. A trip changes the dollar figure on line
      // 9, which is what the period lock exists to protect. This changes no
      // dollar figure on any form — it fills a disclosure box. A corporation
      // that closed 2026 in January still has to answer this in March when the
      // return is actually prepared, and locking it would make that impossible.
      .put(
        '/api/vehicles/:id/years/:year',
        requireCapability('expenses:write'),
        validator('json', (value, c) => {
          const parsed = vehicleYearSchema.safeParse(value);
          if (!parsed.success) {
            return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
          }
          return parsed.data;
        }),
        async (c) => {
          const vehicleId = c.req.param('id');
          if (!UUID_RE.test(vehicleId)) return c.json({ error: 'invalid_id' }, 400);
          const taxYear = Number(c.req.param('year'));
          if (!Number.isInteger(taxYear) || taxYear < 1900 || taxYear > 2200) {
            return c.json({ error: 'invalid_year' }, 400);
          }
          const body = c.req.valid('json');

          const tx = c.get('tx');
          const accountId = c.get('accountId');

          const [vehicle] = await tx
            .select({ id: vehicles.id, companyId: vehicles.companyId })
            .from(vehicles)
            .where(and(eq(vehicles.id, vehicleId), eq(vehicles.accountId, accountId)))
            .limit(1);
          if (!vehicle) return c.json({ error: 'vehicle_not_found' }, 404);

          const [existing] = await tx
            .select()
            .from(vehicleYears)
            .where(
              and(
                eq(vehicleYears.vehicleId, vehicleId),
                eq(vehicleYears.accountId, accountId),
                eq(vehicleYears.taxYear, taxYear),
              ),
            )
            .limit(1);

          const totalMiles =
            body.totalMiles === undefined ? (existing?.totalMiles ?? null) : body.totalMiles;
          const commutingMiles = body.commutingMiles ?? existing?.commutingMiles ?? '0';

          // BLOCKS, where the double-dip overlap warning only warns — and the
          // asymmetry is the point. Both halves of a double-dip can be
          // legitimate (parking and tolls stack on top of the rate), so that one
          // informs. A total below the miles already logged against it is
          // arithmetically impossible, so this one refuses. The logged figure
          // rides along so the client can say why rather than just "invalid".
          if (totalMiles !== null) {
            const trips = await tx
              .select({ miles: mileageTrips.miles })
              .from(mileageTrips)
              .where(
                and(
                  eq(mileageTrips.accountId, accountId),
                  eq(mileageTrips.vehicleId, vehicleId),
                  gte(mileageTrips.tripDate, `${taxYear}-01-01`),
                  lte(mileageTrips.tripDate, `${taxYear}-12-31`),
                ),
              );
            const businessMiles = summariseMileage(
              trips.map((t) => ({ miles: t.miles, tripDate: `${taxYear}-01-01` })),
            ).miles;
            if (Number(totalMiles) < Number(businessMiles) + Number(commutingMiles)) {
              return c.json({ error: 'total_below_logged', businessMiles, commutingMiles }, 400);
            }
          }

          const id = existing?.id ?? uuidv7();
          if (existing) {
            await tx
              .update(vehicleYears)
              .set({ totalMiles, commutingMiles, updatedAt: new Date() })
              .where(eq(vehicleYears.id, existing.id));
          } else {
            await tx.insert(vehicleYears).values({
              id,
              accountId,
              companyId: vehicle.companyId,
              vehicleId,
              taxYear,
              totalMiles,
              commutingMiles,
            });
          }
          const [saved] = await tx
            .select()
            .from(vehicleYears)
            .where(eq(vehicleYears.id, id))
            .limit(1);

          await c.var.audit({
            entityType: 'vehicle',
            entityId: vehicleId,
            action: 'update',
            before: existing,
            after: saved,
            companyId: vehicle.companyId,
          });

          return c.json(saved, existing ? 200 : 201);
        },
      )
      // Retire, not delete. A truck sold in June still has to appear on that
      // year's return, so the row has to survive — and its trips with it.
      .post('/api/vehicles/:id/retire', requireCapability('expenses:write'), async (c) => {
        const id = c.req.param('id');
        if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);

        const tx = c.get('tx');
        const accountId = c.get('accountId');

        const [current] = await tx
          .select()
          .from(vehicles)
          .where(and(eq(vehicles.id, id), eq(vehicles.accountId, accountId)))
          .limit(1);
        if (!current) return c.json({ error: 'vehicle_not_found' }, 404);
        if (current.retiredAt) return c.json({ error: 'already_retired' }, 409);

        await tx
          .update(vehicles)
          .set({ retiredAt: new Date(), updatedAt: new Date() })
          .where(and(eq(vehicles.id, id), eq(vehicles.accountId, accountId)));
        const [updated] = await tx.select().from(vehicles).where(eq(vehicles.id, id)).limit(1);

        await c.var.audit({
          entityType: 'vehicle',
          entityId: id,
          action: 'update',
          before: current,
          after: updated,
          companyId: current.companyId,
        });

        return c.json(updated);
      })
  );
}

export type MileageAppType = ReturnType<typeof mileageRoutes>;
