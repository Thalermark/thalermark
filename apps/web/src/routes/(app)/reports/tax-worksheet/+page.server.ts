import { serverApiClient } from '$lib/api.server';
import { loadTaxWorksheet } from '$lib/reports.server';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => loadTaxWorksheet(event);

// A DELIBERATE PRECEDENT BREAK: no other page under routes/(app)/reports/
// exports actions — reports are read-only everywhere else.
//
// Part IV is answered here because this is the only tax-time surface with no
// capability gate. Reads are ungated by design (packages/validation/src/roles.ts
// says so explicitly), so every role can already open this page. Settings is
// gated on settings:manage, which `accountant` does not hold; The Ledger is
// gated on ledger:adjust and a solo operator may never open it at all. Answering
// the question next to the empty box it fills is the whole reason this is the
// hook — linking out to /mileage would lose exactly that.
//
// The writes still go through the API, which gates them on expenses:write. This
// page being ungated only decides who can SEE the form.
export const actions: Actions = {
  saveVehicleYear: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const vehicleId = String(data.get('vehicleId') ?? '');
    const year = Number(data.get('year'));
    const totalMiles = String(data.get('totalMiles') ?? '').trim();
    const commutingMiles = String(data.get('commutingMiles') ?? '').trim();

    const res = await client.api.vehicles[':id'].years[':year'].$put({
      param: { id: vehicleId, year: String(year) },
      json: {
        totalMiles: totalMiles || null,
        ...(commutingMiles ? { commutingMiles } : {}),
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        businessMiles?: string;
      } | null;
      // The one error a user will actually hit, and it needs the logged figure
      // to be answerable rather than just refused.
      if (body?.error === 'total_below_logged') {
        return fail(400, {
          vehicleError: `You've already logged ${Number(body.businessMiles ?? 0).toLocaleString('en-US', { maximumFractionDigits: 1 })} business miles on this vehicle, so the total can't be less than that.`,
        });
      }
      return fail(res.status, { vehicleError: "Couldn't save that." });
    }
    return { vehicleYearSaved: true };
  },

  // The standing facts (lines 43, 45, 46). Answering 45 as "work only" is what
  // removes the year-end question for that vehicle entirely.
  saveVehicleFacts: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const id = String(data.get('vehicleId') ?? '');
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
    if (!res.ok) return fail(res.status, { vehicleError: "Couldn't save that." });
    return { vehicleFactsSaved: true };
  },
};
