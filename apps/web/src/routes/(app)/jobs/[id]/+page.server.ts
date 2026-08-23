import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { isBillingUnit, minutesFromClockSpan, minutesFromDuration } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Job detail: the margin block, the invoices the job emitted, and its time log.
//
// INTERNAL ONLY. Cost, margin and hours never reach the customer — the public
// invoice view builds its own payload server-side and none of this is in it.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const [jobRes, timeRes] = await Promise.all([
    client.api.jobs[':id'].$get({ param: { id: event.params.id } }),
    // The whole log, billed and unbilled — the detail page shows both.
    client.api.jobs[':id'].time.$get({
      param: { id: event.params.id },
      query: { unbilled: undefined },
    }),
  ]);
  if (jobRes.status === 404) throw error(404, 'job not found');
  if (!jobRes.ok) throw error(jobRes.status, 'failed to load job');
  const job = await jobRes.json();
  const time = timeRes.ok
    ? await timeRes.json()
    : { timeEntries: [], jobName: '', billingUnit: 'hour', totalMinutes: 0, totalHours: '0.00' };
  // The caller's running stopwatch, if any — on this job or another. One read
  // answers both "is my timer on THIS job" and "which job is holding it".
  const timerRes = await client.api.timer.$get();
  const { timer } = timerRes.ok ? await timerRes.json() : { timer: null };

  // Trips tagged to this job (TMC-179). Read-only context — mileage is a tax
  // figure, not a job cost, so it deliberately does NOT feed the margin block
  // above it (margin reconciles against the P&L, and mileage isn't in the P&L).
  const milesRes = await client.api['mileage-trips'].$get({
    query: { jobId: event.params.id, limit: '50' },
  });
  const trips = milesRes.ok ? (await milesRes.json()).trips : [];

  // The vehicle picker for the Miles form. Without it every trip logged from a
  // job screen would land with no vehicle — counted in the deduction but absent
  // from Schedule C Part IV — which is exactly the gap the worksheet warns
  // about. Logging from the job is the most natural path, so it must not be the
  // one that creates the problem.
  const vehiclesRes = await client.api.vehicles.$get({ query: { companyId: job.companyId } });
  const vehicles = vehiclesRes.ok ? (await vehiclesRes.json()).vehicles : [];

  return { job, time, timer, trips, vehicles };
};

export const actions: Actions = {
  startTimer: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.jobs[':id'].timer.$post({ param: { id: event.params.id } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        jobName?: string;
        jobId?: string;
      } | null;
      // A refusal has to name the job holding the timer and link to it, or the
      // user is stranded: they are standing at this job and the thing blocking
      // them is somewhere else.
      return fail(res.status, {
        timerError:
          body?.error === 'timer_already_running'
            ? `A timer is already running on "${body.jobName}". Stop it there first.`
            : apiErrorMessage(body?.error, 'The timer could not be started. Try again.', body),
        runningJobId: body?.jobId,
      });
    }
    redirect(303, `/jobs/${event.params.id}`);
  },

  // Stop hands back the elapsed minutes rather than logging. The user still owes
  // a note and a rate, and a stopwatch that silently became a billable entry is
  // the easiest way to invoice someone for a drive home.
  stopTimer: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.jobs[':id'].timer.$delete({ param: { id: event.params.id } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        timerError: apiErrorMessage(
          body?.error,
          'The timer could not be stopped. Try again.',
          body,
        ),
      });
    }
    const { minutes, note } = await res.json();
    return { stoppedMinutes: minutes, stoppedNote: note };
  },

  // How this job bills (TMC-264), asked once and changeable after the fact.
  //
  // Changing it RE-READS existing entries rather than rewriting them: each row
  // keeps both its minutes and its count, and the unit decides which one reaches
  // the invoice. So someone who logged three visits as hours fixes the job
  // instead of re-entering the work.
  setBillingUnit: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const billingUnit = String(data.get('billingUnit') ?? '');
    if (!isBillingUnit(billingUnit)) {
      return fail(400, { actionError: 'That is not a unit this job can bill in.' });
    }
    const res = await client.api.jobs[':id'].$patch({
      param: { id: event.params.id },
      // `confirm` belongs to the close-with-unbilled-work guard on setStatus and
      // is irrelevant here, but the route's query validator types it as required
      // on every PATCH.
      query: { confirm: undefined },
      json: { billingUnit },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        actionError: apiErrorMessage(body?.error, 'That could not be changed. Try again.', body),
      });
    }
    redirect(303, `/jobs/${event.params.id}`);
  },

  logTime: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const unit = String(data.get('billingUnit') ?? 'hour');
    const billsByHour = unit === 'hour';

    // THREE WAYS IN, ONE RECORD OUT. A typed duration, a stopwatch (which fills
    // the duration field rather than logging directly), and a time card (TMC-265)
    // — which also resolves to a duration here rather than becoming a second kind
    // of entry.
    //
    // The card winning over the duration is now a BELT-AND-BRACES GUARD rather
    // than a rule anyone has to know. The form renders exactly one mode's inputs
    // at a time, so both arriving together is unreachable from the UI. It stays
    // because a hand-rolled POST can still send both, and silently averaging two
    // contradictory durations would be worse than picking the one the user
    // typed as clock times.
    const startTime = String(data.get('startTime') ?? '').trim();
    const endTime = String(data.get('endTime') ?? '').trim();
    let minutes: number | null = null;
    if (startTime && endTime) {
      const span = minutesFromClockSpan(startTime, endTime);
      if (span === null) {
        return fail(400, { timeError: 'Check the start and end times.' });
      }
      // An overnight span stays ONE entry, dated by its start (owner decision).
      // The client already showed the computed hours and said it ran overnight,
      // so nothing is being decided here that the user has not seen.
      minutes = span.minutes;
    } else if (startTime || endTime) {
      return fail(400, { timeError: 'Enter both a start and an end time, or neither.' });
    } else {
      // Shared with mobile (@thalermark/validation) so the same typed string can
      // never become two different durations.
      minutes = minutesFromDuration(String(data.get('duration') ?? ''));
    }

    // On an hourly job the duration IS the billable amount, so it is required.
    // On any other unit it is optional context for effective-hourly.
    if (billsByHour && minutes === null) {
      return fail(400, { timeError: 'Enter hours like 3.25 or 3:15.' });
    }

    // The count, in the job's own unit. Required on a non-hourly job for the
    // same reason hours are required on an hourly one: it is what gets billed.
    const quantityRaw = String(data.get('quantity') ?? '').trim();
    if (!billsByHour && !quantityRaw) {
      return fail(400, { timeError: 'Enter how many you did.' });
    }

    const entryDate = String(data.get('entryDate') ?? '').trim();
    const note = String(data.get('note') ?? '').trim();
    const rate = String(data.get('rate') ?? '').trim();

    const res = await client.api.jobs[':id'].time.$post({
      param: { id: event.params.id },
      json: {
        entryDate,
        minutes,
        quantity: billsByHour ? undefined : quantityRaw,
        startTime: startTime || undefined,
        endTime: endTime || undefined,
        note: note || undefined,
        rate: rate || undefined,
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        timeError: apiErrorMessage(body?.error, 'That could not be recorded. Try again.', body),
      });
    }
    redirect(303, `/jobs/${event.params.id}`);
  },

  // Miles driven to this job (TMC-179). Its own action with its own error flag,
  // deliberately NOT folded into logTime: hours produce revenue and miles
  // produce a deduction, and in a form they look identical. Mixing them is how
  // someone bills a customer for a drive.
  logMiles: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const miles = String(data.get('miles') ?? '').trim();
    const tripDate = String(data.get('tripDate') ?? '').trim();
    const purpose = String(data.get('purpose') ?? '').trim();
    const vehicleId = String(data.get('vehicleId') ?? '').trim();
    if (!miles || !purpose) {
      return fail(400, { milesError: 'Enter the miles and what the trip was for.' });
    }

    // companyId comes off the job, not the form — the trip has to land on the
    // same company the job belongs to, and the API rejects a mismatch anyway.
    const jobRes = await client.api.jobs[':id'].$get({ param: { id: event.params.id } });
    if (!jobRes.ok) return fail(jobRes.status, { milesError: 'Could not find that job.' });
    const { companyId } = await jobRes.json();

    const res = await client.api['mileage-trips'].$post({
      json: {
        companyId,
        jobId: event.params.id,
        miles,
        tripDate,
        purpose,
        ...(vehicleId ? { vehicleId } : {}),
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        milesError:
          body?.error === 'period_closed'
            ? "That year's books are closed, so it can't take a new trip."
            : "Couldn't save that trip.",
      });
    }
    redirect(303, `/jobs/${event.params.id}`);
  },

  deleteTime: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const id = String(data.get('id') ?? '');
    if (!id) return fail(400, { timeError: 'missing_id' });
    const res = await client.api['time-entries'][':id'].$delete({ param: { id } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        timeError:
          body?.error === 'time_entry_billed'
            ? 'Those hours are already on an invoice. Take them off it first.'
            : apiErrorMessage(body?.error, 'That could not be deleted. Try again.', body),
      });
    }
    redirect(303, `/jobs/${event.params.id}`);
  },

  setStatus: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const status = String(data.get('status') ?? '');
    if (status !== 'open' && status !== 'closed')
      return fail(400, { actionError: 'Choose a status from the list.' });
    // A deliberate close carries confirm=true; the first attempt does not, so
    // the API can refuse and tell us how much is still waiting.
    const confirmed = String(data.get('confirm') ?? '') === 'true';
    const res = await client.api.jobs[':id'].$patch({
      param: { id: event.params.id },
      query: { confirm: confirmed ? 'true' : undefined },
      json: { status },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        readyToBill?: string;
      } | null;
      if (body?.error === 'job_has_unbilled_time') {
        // Not an error so much as a question. Closing would drop the job out of
        // the default list and take its unbilled work with it.
        return fail(409, { confirmClose: body.readyToBill ?? '0.00' });
      }
      return fail(res.status, {
        actionError: apiErrorMessage(body?.error, 'That could not be saved. Try again.', body),
      });
    }
    redirect(303, `/jobs/${event.params.id}`);
  },

  // Only ever succeeds for a job that was never used — the API refuses one with
  // invoices or tracked time, because deleting it would cascade the hours away.
  delete: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.jobs[':id'].$delete({ param: { id: event.params.id } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const message =
        body?.error === 'job_has_time_entries'
          ? 'This job has hours logged against it. Close it instead — deleting would throw the hours away.'
          : body?.error === 'job_has_invoices'
            ? 'This job has invoices. Close it instead.'
            : apiErrorMessage(body?.error, 'That could not be deleted. Try again.', body);
      return fail(res.status, { actionError: message });
    }
    redirect(303, '/jobs');
  },
};
