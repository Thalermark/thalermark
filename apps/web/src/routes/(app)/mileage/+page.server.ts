import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error, fail } from '@sveltejs/kit';
import { mileageTripCreateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// The trip log (TMC-179). A standalone page rather than a section of the job
// screen, because the drives that have no job — the bank, the supply house, the
// accountant — are ordinary deductible business miles and would have nowhere to
// live otherwise.
//
// The year summary is fetched alongside the page because the list is
// keyset-paginated: a running total computed from the visible rows would quietly
// under-report the year, which on a deduction is worse than showing nothing.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const { activeCompanyId } = await event.parent();
  const year = Number(event.url.searchParams.get('year')) || new Date().getFullYear();

  const query: Record<string, string> = { limit: String(PAGE_SIZE) };
  if (activeCompanyId) query.companyId = activeCompanyId;

  const [res, summaryRes, vehiclesRes] = await Promise.all([
    client.api['mileage-trips'].$get({ query }),
    activeCompanyId
      ? client.api.companies[':id'].mileage.$get({
          param: { id: activeCompanyId },
          query: { year: String(year) },
        })
      : Promise.resolve(null),
    client.api.vehicles.$get({ query: activeCompanyId ? { companyId: activeCompanyId } : {} }),
  ]);
  if (!res.ok) throw error(res.status, 'failed to load mileage');
  const { trips, nextCursor } = await res.json();
  // Best-effort: a failed summary hides the total rather than failing the page.
  const summary = summaryRes?.ok ? await summaryRes.json() : null;
  const vehicles = vehiclesRes.ok ? (await vehiclesRes.json()).vehicles : [];

  return { trips, nextCursor, summary, year, vehicles };
};

export const actions: Actions = {
  // One action for both the form and the per-row "Again" button — "Again" is
  // just this form pre-filled with an older trip's miles and purpose and
  // today's date, so giving it its own endpoint would be two ways to say one
  // thing.
  log: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = {
      tripDate: String(data.get('tripDate') ?? '').trim(),
      miles: String(data.get('miles') ?? '').trim(),
      purpose: String(data.get('purpose') ?? '').trim(),
      vehicleId: String(data.get('vehicleId') ?? '').trim(),
    };

    const companiesRes = await client.api.companies.$get();
    // A lookup this action needs, not the thing the user asked for. Throwing
    // here renders the error page and discards the form, which is the very
    // loss TMC-248 is about — so it fails the action instead, keeping the
    // values on screen with a sentence saying why.
    if (!companiesRes.ok) {
      const body = (await companiesRes.json().catch(() => null)) as { error?: string } | null;
      return fail(companiesRes.status, {
        values,
        formError: apiErrorMessage(body?.error, 'That could not be saved. Try again.', body),
      });
    }
    const { companies } = await companiesRes.json();
    const company = pickActiveCompany(event.cookies, companies);
    if (!company) return fail(400, { values, formError: 'No company in this workspace.' });

    const parsed = mileageTripCreateSchema.safeParse({
      companyId: company.id,
      tripDate: values.tripDate,
      miles: values.miles,
      purpose: values.purpose,
      ...(values.vehicleId ? { vehicleId: values.vehicleId } : {}),
    });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api['mileage-trips'].$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { values, formError: logErrorMessage(body?.error) });
    }
    return { logged: true };
  },

  // Vehicles live on this page rather than in Settings, deliberately: the trip
  // form needs the picker anyway, and Settings is gated on settings:manage,
  // which `accountant` does not hold. The person who has to finish Schedule C
  // Part IV at tax time is often exactly that person.
  addVehicle: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const label = String(data.get('label') ?? '').trim();
    if (!label) return fail(400, { vehicleError: 'Give the vehicle a name.' });

    const companiesRes = await client.api.companies.$get();
    // A lookup this action needs, not the thing the user asked for. Throwing
    // here renders the error page and discards the form, which is the very
    // loss TMC-248 is about — so it fails the action instead, keeping the
    // values on screen with a sentence saying why.
    if (!companiesRes.ok) {
      const body = (await companiesRes.json().catch(() => null)) as { error?: string } | null;
      // This form reports through `vehicleError`, not the shared formError.
      return fail(companiesRes.status, {
        vehicleError: apiErrorMessage(body?.error, 'That could not be saved. Try again.', body),
      });
    }
    const { companies } = await companiesRes.json();
    const company = pickActiveCompany(event.cookies, companies);
    if (!company) return fail(400, { vehicleError: 'No company in this workspace.' });

    const res = await client.api.vehicles.$post({ json: { companyId: company.id, label } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        vehicleError:
          body?.error === 'vehicle_label_taken'
            ? 'You already have a vehicle by that name.'
            : "Couldn't add that vehicle.",
      });
    }
    return { vehicleAdded: true };
  },

  // The Part IV answers (lines 43, 45, 46). Answering these is what lets a
  // work-only vehicle skip the year-end mileage question entirely.
  saveVehicle: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const id = String(data.get('id') ?? '');
    const placedInServiceOn = String(data.get('placedInServiceOn') ?? '').trim();
    const personalUse = String(data.get('personalUse') ?? '').trim();
    const another = String(data.get('anotherVehicleAvailable') ?? '').trim();

    const res = await client.api.vehicles[':id'].$patch({
      param: { id },
      json: {
        placedInServiceOn: placedInServiceOn || null,
        ...(personalUse === 'none' || personalUse === 'some' ? { personalUse } : {}),
        ...(another === 'yes' || another === 'no'
          ? { anotherVehicleAvailable: another === 'yes' }
          : {}),
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        vehicleError:
          body?.error === 'vehicle_label_taken'
            ? 'You already have a vehicle by that name.'
            : "Couldn't save that vehicle.",
      });
    }
    return { vehicleSaved: true };
  },

  retireVehicle: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const id = String(data.get('id') ?? '');
    const res = await client.api.vehicles[':id'].retire.$post({ param: { id } });
    if (!res.ok) return fail(res.status, { vehicleError: "Couldn't retire that vehicle." });
    return { vehicleRetired: true };
  },

  remove: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const id = String(data.get('id') ?? '');
    const res = await client.api['mileage-trips'][':id'].$delete({ param: { id } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { formError: logErrorMessage(body?.error) });
    }
    return { removed: true };
  },
};

// Mechanical error codes → plain English, the same mapping every other page
// does at its own boundary. The two that a user will actually hit are the
// locks, and both need to say what to do next rather than name a constraint.
function logErrorMessage(code: string | undefined): string {
  if (code === 'period_closed') {
    return "That year's books are closed, so it can't take a new trip. Reopen the year first if you need to add this.";
  }
  if (code === 'company_retired') {
    return 'This business has been retired, so it no longer records new activity.';
  }
  return "Couldn't save that trip.";
}
